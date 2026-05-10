#!/usr/bin/env node
// aggregate.mjs — deterministic Risk Manager + Portfolio Manager for the
// hedge-fund Hermes skill.
//
// Reads N persona signal JSONs (per-token bullish/bearish/neutral +
// confidence), converts to weights, runs confidence-weighted cross-persona
// aggregation, applies long-only concentration caps, writes target weights.
//
// Pattern adapted from virattt/ai-hedge-fund (educational use). Upstream
// uses LLM-based PM and volatility-based risk sizing; we substitute
// deterministic concentration caps and equal-weighted persona aggregation
// for demo reproducibility. See ../personas/{risk-manager,pm}.md for the
// design rationale.
//
// Usage:
//   node aggregate.mjs \
//     --signals signals/buffett.json signals/wood.json signals/burry.json \
//     --tokens ../scripts/tokens.json \
//     --max-single 0.5 --max-longtail 0.10 --usdc-floor 0.10 \
//     --out target-weights.json

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SIGNAL_VALUES = { bullish: +1, neutral: 0, bearish: -1 };

function parseArgs(argv) {
    const args = {
        signals: [],
        tokens: null,
        out: "target-weights.json",
        maxSingle: 0.5,
        maxLongtail: 0.10,
        usdcFloor: 0.10,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "--signals":
                while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args.signals.push(argv[++i]);
                break;
            case "--tokens":      args.tokens = argv[++i]; break;
            case "--out":         args.out = argv[++i]; break;
            case "--max-single":  args.maxSingle = parseFloat(argv[++i]); break;
            case "--max-longtail":args.maxLongtail = parseFloat(argv[++i]); break;
            case "--usdc-floor":  args.usdcFloor = parseFloat(argv[++i]); break;
            default:
                throw new Error(`unknown arg: ${a}`);
        }
    }
    if (args.signals.length === 0) throw new Error("--signals required (one or more JSON files)");
    if (!args.tokens)              throw new Error("--tokens required (basket definition JSON)");
    return args;
}

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Convert a persona's per-token signal+confidence to a non-negative weight,
// then normalize across tokens so the persona's weights sum to 1.0.
//
// Signal mapping:
//   bullish  → +confidence/100
//   neutral  →  0
//   bearish  → −confidence/100  (clipped to 0; long-only book)
//
// Edge case: a persona that says bearish on every token gets all-zero
// scores. We default to 100% USDC for that persona (cash is a position).
function personaToWeights(persona, tokenSymbols) {
    const scores = {};
    for (const tk of tokenSymbols) scores[tk] = 0;

    const sigByToken = Object.fromEntries(persona.signals.map(s => [s.token, s]));
    for (const tk of tokenSymbols) {
        const sig = sigByToken[tk];
        if (!sig) continue;  // missing token from persona → score 0
        const dir = SIGNAL_VALUES[sig.signal] ?? 0;
        const conf = Math.max(0, Math.min(100, Number(sig.confidence) || 0));
        const raw = dir * (conf / 100);
        scores[tk] = Math.max(0, raw);
    }

    const sum = Object.values(scores).reduce((a, b) => a + b, 0);
    if (sum <= 0) {
        const fallback = Object.fromEntries(tokenSymbols.map(t => [t, 0]));
        fallback.USDC = 1.0;
        return { rawScores: { ...scores }, normalized: fallback, fallbackToUSDC: true };
    }

    const normalized = Object.fromEntries(
        tokenSymbols.map(t => [t, scores[t] / sum])
    );
    return { rawScores: scores, normalized, fallbackToUSDC: false };
}

// Equal-weighted average across personas, then renormalize.
function aggregatePersonas(perPersonaNormalized, tokenSymbols) {
    const out = {};
    const n = Object.keys(perPersonaNormalized).length;
    for (const tk of tokenSymbols) {
        const sum = Object.values(perPersonaNormalized).reduce((a, w) => a + (w[tk] ?? 0), 0);
        out[tk] = sum / n;
    }
    return renormalize(out, tokenSymbols);
}

function renormalize(weights, tokenSymbols) {
    const sum = tokenSymbols.reduce((a, t) => a + (weights[t] ?? 0), 0);
    if (sum <= 0) return Object.fromEntries(tokenSymbols.map(t => [t, t === "USDC" ? 1 : 0]));
    return Object.fromEntries(tokenSymbols.map(t => [t, (weights[t] ?? 0) / sum]));
}

// Apply caps in order: long-tail, single-asset, USDC floor, then renormalize.
// Each cap returns adjusted weights + a list of human-readable adjustment notes.
function applyCaps(weights, tokens, opts) {
    const tokenSymbols = tokens.map(t => t.symbol);
    const tailSet = new Set(tokens.filter(t => t.tail).map(t => t.symbol));
    const adjustments = [];
    let w = { ...weights };

    // 1) Long-tail cap: sum of tail tokens ≤ maxLongtail.
    const tailSum = [...tailSet].reduce((a, t) => a + (w[t] ?? 0), 0);
    if (tailSum > opts.maxLongtail + 1e-9) {
        const excess = tailSum - opts.maxLongtail;
        const scale = opts.maxLongtail / tailSum;
        for (const t of tailSet) {
            const before = w[t] ?? 0;
            w[t] = before * scale;
            if (before > 0) adjustments.push(
                `${t} clipped ${(before * 100).toFixed(1)}% → ${(w[t] * 100).toFixed(1)}% (long-tail cap)`
            );
        }
        // Redistribute excess to non-USDC, non-tail tokens pro-rata.
        const eligible = tokenSymbols.filter(t => t !== "USDC" && !tailSet.has(t));
        const eligibleSum = eligible.reduce((a, t) => a + (w[t] ?? 0), 0);
        if (eligibleSum > 0) {
            for (const t of eligible) w[t] = (w[t] ?? 0) + excess * ((w[t] ?? 0) / eligibleSum);
        } else if (eligible.length > 0) {
            for (const t of eligible) w[t] = (w[t] ?? 0) + excess / eligible.length;
        }
    }

    // 2) Single-asset cap (excluding USDC): no non-USDC asset > maxSingle.
    for (const tk of tokenSymbols) {
        if (tk === "USDC") continue;
        if ((w[tk] ?? 0) > opts.maxSingle + 1e-9) {
            const before = w[tk];
            const excess = before - opts.maxSingle;
            w[tk] = opts.maxSingle;
            adjustments.push(
                `${tk} clipped ${(before * 100).toFixed(1)}% → ${(opts.maxSingle * 100).toFixed(1)}% (single-asset cap)`
            );
            // Excludes tail tokens — pushing single-asset excess into a tail token
            // would re-inflate above the long-tail cap that just ran.
            const others = tokenSymbols.filter(t => t !== "USDC" && t !== tk && !tailSet.has(t));
            const othersSum = others.reduce((a, t) => a + (w[t] ?? 0), 0);
            if (othersSum > 0) {
                for (const t of others) w[t] = (w[t] ?? 0) + excess * ((w[t] ?? 0) / othersSum);
            } else if (others.length > 0) {
                for (const t of others) w[t] = (w[t] ?? 0) + excess / others.length;
            }
        }
    }

    // 3) USDC floor: USDC ≥ usdcFloor. Take from non-USDC, non-tail tokens pro-rata.
    if ((w.USDC ?? 0) + 1e-9 < opts.usdcFloor) {
        const before = w.USDC ?? 0;
        const shortfall = opts.usdcFloor - before;
        w.USDC = opts.usdcFloor;
        adjustments.push(
            `USDC raised ${(before * 100).toFixed(1)}% → ${(opts.usdcFloor * 100).toFixed(1)}% (USDC floor)`
        );
        const donors = tokenSymbols.filter(t => t !== "USDC" && !tailSet.has(t));
        const donorsSum = donors.reduce((a, t) => a + (w[t] ?? 0), 0);
        if (donorsSum > 0) {
            for (const t of donors) w[t] = Math.max(0, (w[t] ?? 0) - shortfall * ((w[t] ?? 0) / donorsSum));
        } else if (donors.length > 0) {
            for (const t of donors) w[t] = Math.max(0, (w[t] ?? 0) - shortfall / donors.length);
        }
    }

    // 4) Final renormalization to exactly 1.0.
    return { weights: renormalize(w, tokenSymbols), adjustments };
}

function validatePersona(persona, tokenSymbols, fileLabel) {
    if (!persona || typeof persona !== "object") throw new Error(`${fileLabel}: not an object`);
    if (!persona.persona) throw new Error(`${fileLabel}: missing 'persona' field`);
    if (!Array.isArray(persona.signals)) throw new Error(`${fileLabel}: 'signals' must be an array`);
    const seen = new Set();
    for (const s of persona.signals) {
        if (!tokenSymbols.includes(s.token)) throw new Error(`${fileLabel}: unknown token ${s.token}`);
        if (seen.has(s.token)) throw new Error(`${fileLabel}: duplicate token ${s.token}`);
        seen.add(s.token);
        if (!Object.prototype.hasOwnProperty.call(SIGNAL_VALUES, s.signal))
            throw new Error(`${fileLabel}: bad signal '${s.signal}' for ${s.token}`);
        const c = Number(s.confidence);
        if (!Number.isFinite(c) || c < 0 || c > 100)
            throw new Error(`${fileLabel}: bad confidence ${s.confidence} for ${s.token}`);
        if (typeof s.reasoning !== "string" || s.reasoning.length > 240)
            throw new Error(`${fileLabel}: reasoning must be string ≤ 240 chars for ${s.token}`);
    }
    const missing = tokenSymbols.filter(t => !seen.has(t));
    if (missing.length > 0) throw new Error(`${fileLabel}: missing tokens ${missing.join(",")}`);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const tokensFile = readJson(args.tokens);
    const tokens = tokensFile.tokens ?? tokensFile;  // accept either {tokens:[...]} or [...]
    const tokenSymbols = tokens.map(t => t.symbol);

    const perPersonaNormalized = {};
    const perPersonaRaw = {};
    const personaNotes = {};
    for (const file of args.signals) {
        const persona = readJson(file);
        validatePersona(persona, tokenSymbols, path.basename(file));
        const { rawScores, normalized, fallbackToUSDC } = personaToWeights(persona, tokenSymbols);
        perPersonaNormalized[persona.persona] = normalized;
        perPersonaRaw[persona.persona] = rawScores;
        if (fallbackToUSDC) personaNotes[persona.persona] = "all-bearish/neutral → fell back to 100% USDC";
    }

    const aggregated = aggregatePersonas(perPersonaNormalized, tokenSymbols);
    const { weights, adjustments } = applyCaps(aggregated, tokens, {
        maxSingle: args.maxSingle,
        maxLongtail: args.maxLongtail,
        usdcFloor: args.usdcFloor,
    });

    const result = {
        weights: Object.fromEntries(
            Object.entries(weights).map(([k, v]) => [k, Number(v.toFixed(4))])
        ),
        adjustments,
        persona_notes: personaNotes,
        by_persona_normalized: Object.fromEntries(
            Object.entries(perPersonaNormalized).map(([p, w]) => [
                p, Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Number(v.toFixed(4))])),
            ])
        ),
        by_persona_raw_scores: Object.fromEntries(
            Object.entries(perPersonaRaw).map(([p, w]) => [
                p, Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Number(v.toFixed(4))])),
            ])
        ),
        config: {
            max_single: args.maxSingle,
            max_longtail: args.maxLongtail,
            usdc_floor: args.usdcFloor,
        },
        generated_at: new Date().toISOString(),
    };

    fs.writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n");

    // Stdout summary for human / chat consumption.
    console.log("== aggregate.mjs ==");
    console.log("inputs:", args.signals.join(", "));
    console.log("output:", args.out);
    for (const [tk, w] of Object.entries(result.weights)) {
        console.log(`  ${tk.padEnd(6)} ${(w * 100).toFixed(1).padStart(5)}%`);
    }
    if (adjustments.length > 0) {
        console.log("risk adjustments:");
        for (const a of adjustments) console.log("  -", a);
    }
}

main();
