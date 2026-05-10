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
//     --tokens basket.json \
//     --max-single 0.5 --max-longtail 0.10 \
//     --out target-weights.json
//
// `--tokens` accepts either a basket.json from research.mjs (top-level
// `tokens: [...]`) or a static fallback like the legacy tokens.json.
//
// `--usdc-floor` defaults to 0 (no floor). The dynamic basket may not
// contain USDC at all — pass --usdc-floor 0.10 if you want to re-enable
// the legacy stable-coin floor (only meaningful when the basket actually
// contains USDC under that exact symbol).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SIGNAL_VALUES = { bullish: +1, neutral: 0, bearish: -1 };

// Symbol pattern for "stable / cash-equivalent" tokens. We detect from the
// basket dynamically (instead of hardcoding USDC) so the fully-dynamic
// research basket can have any stable — or none.
const STABLE_PATTERN = /^(USDC|USDT|EURC|DAI|FRAX|USDe|PYUSD|GUSD|TUSD|crvUSD|sDAI)$/i;
function isStable(token) {
    if (token && typeof token === "object" && token.stable === true) return true;
    return STABLE_PATTERN.test(token?.symbol || token);
}
function findStables(tokens) {
    return tokens.filter(isStable).map(t => t.symbol);
}

function parseArgs(argv) {
    const args = {
        signals: [],
        tokens: null,
        out: "target-weights.json",
        maxSingle: 0.5,
        maxLongtail: 0.10,
        usdcFloor: 0,
        // Vol-weighted single-asset cap. If enabled, the per-token cap is
        // min(maxSingle, volWeightK / vol_proxy). Higher-vol tokens get a
        // smaller cap (rough volatility proxy: smaller mcap → higher
        // expected vol → tighter cap). Set to 0 to disable.
        volWeightK: 0,
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
            case "--vol-weight":  args.volWeightK = parseFloat(argv[++i]); break;
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
// scores. Default behavior: 100% to the first stable in the basket (cash is
// a position). If no stable is in the basket, fall back to equal-weight
// across all tokens (no opinion → don't concentrate).
function personaToWeights(persona, tokens) {
    const tokenSymbols = tokens.map(t => t.symbol);
    const scores = {};
    for (const tk of tokenSymbols) scores[tk] = 0;

    const sigByToken = Object.fromEntries(persona.signals.map(s => [s.token, s]));
    for (const tk of tokenSymbols) {
        const sig = sigByToken[tk];
        if (!sig) continue;
        const dir = SIGNAL_VALUES[sig.signal] ?? 0;
        const conf = Math.max(0, Math.min(100, Number(sig.confidence) || 0));
        const raw = dir * (conf / 100);
        scores[tk] = Math.max(0, raw);
    }

    const sum = Object.values(scores).reduce((a, b) => a + b, 0);
    if (sum <= 0) {
        const stables = findStables(tokens);
        const fallback = Object.fromEntries(tokenSymbols.map(t => [t, 0]));
        let note = "all-bearish/neutral";
        if (stables.length > 0) {
            fallback[stables[0]] = 1.0;
            note += ` → fell back to 100% ${stables[0]}`;
        } else {
            // No stable in basket — equal-weight across all tokens (no opinion).
            const w = 1 / tokenSymbols.length;
            for (const t of tokenSymbols) fallback[t] = w;
            note += ` → no stable in basket, fell back to equal-weight`;
        }
        return { rawScores: { ...scores }, normalized: fallback, fallbackNote: note };
    }

    const normalized = Object.fromEntries(
        tokenSymbols.map(t => [t, scores[t] / sum])
    );
    return { rawScores: scores, normalized, fallbackNote: null };
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
    if (sum <= 0) {
        // Degenerate input — return equal-weight rather than concentrating
        // arbitrarily on USDC (which may not be in a dynamic basket).
        const w = 1 / tokenSymbols.length;
        return Object.fromEntries(tokenSymbols.map(t => [t, w]));
    }
    return Object.fromEntries(tokenSymbols.map(t => [t, (weights[t] ?? 0) / sum]));
}

// Apply caps in a multi-pass loop until weights converge. Each pass runs
// long-tail → single-asset (with optional vol weighting) → stable floor,
// then renormalizes. We keep iterating because cap-then-redistribute can
// push another token over its cap, requiring a second pass — without
// iteration, a single pass would clip a token, then the message says
// "X clipped to N%" but renormalization or a later cap could leave X
// elsewhere, confusing observers.
//
// Adjustment messages are emitted ONCE at the end, comparing the
// pre-cap state to the post-convergence state. So messages always
// reflect the actual final weights.
//
// "Stable" tokens are detected dynamically from the basket via
// STABLE_PATTERN (USDC/USDT/EURC/DAI/etc.) — no hardcoded symbols.
function applyCaps(weights, tokens, opts) {
    const tokenSymbols = tokens.map(t => t.symbol);
    const tailSet = new Set(tokens.filter(t => t.tail).map(t => t.symbol));
    const stableSet = new Set(findStables(tokens));
    const tokenByName = Object.fromEntries(tokens.map(t => [t.symbol, t]));
    const initial = { ...weights };

    function tokenCapFor(tk) {
        if (stableSet.has(tk)) return 1;   // stables uncapped
        let cap = opts.maxSingle;
        if (opts.volWeightK > 0) {
            const meta = tokenByName[tk] || {};
            const mcap = Math.max(meta.mcap_usd ?? 0, 1);
            const turnover = (meta.vol24_usd ?? 0) / mcap;
            const volCap = opts.volWeightK * Math.sqrt(mcap / 1e8);
            const liqPenalty = turnover > 0.5 ? 0.5 : 1;
            cap = Math.min(cap, volCap * liqPenalty);
        }
        // Tail tokens are also bounded by the long-tail cap individually
        // (their group sum is bounded separately) — give them at most the
        // long-tail cap so a single tail token can't dominate even within
        // the tail budget.
        if (tailSet.has(tk)) cap = Math.min(cap, opts.maxLongtail);
        return cap;
    }

    function onePass(w) {
        let didChange = false;

        // 1) Long-tail group cap.
        const tailSum = [...tailSet].reduce((a, t) => a + (w[t] ?? 0), 0);
        if (tailSum > opts.maxLongtail + 1e-9) {
            const scale = opts.maxLongtail / tailSum;
            for (const t of tailSet) w[t] = (w[t] ?? 0) * scale;
            didChange = true;
        }

        // 2) Per-token (single-asset, optionally vol-weighted) cap.
        for (const tk of tokenSymbols) {
            const cap = tokenCapFor(tk);
            if ((w[tk] ?? 0) > cap + 1e-9) {
                w[tk] = cap;
                didChange = true;
            }
        }

        // 3) Stable floor (opt-in).
        if (opts.usdcFloor > 0 && stableSet.size > 0) {
            const stables = [...stableSet];
            const stableSum = stables.reduce((a, t) => a + (w[t] ?? 0), 0);
            if (stableSum + 1e-9 < opts.usdcFloor) {
                const shortfall = opts.usdcFloor - stableSum;
                if (stableSum > 0) {
                    for (const t of stables) w[t] = (w[t] ?? 0) + shortfall * ((w[t] ?? 0) / stableSum);
                } else {
                    for (const t of stables) w[t] = (w[t] ?? 0) + shortfall / stables.length;
                }
                didChange = true;
            }
        }

        // 4) Renormalize so weights always sum to 1.
        const renorm = renormalize(w, tokenSymbols);
        for (const t of tokenSymbols) {
            if (Math.abs((renorm[t] ?? 0) - (w[t] ?? 0)) > 1e-9) didChange = true;
            w[t] = renorm[t];
        }
        return didChange;
    }

    let w = { ...weights };
    let iter = 0;
    while (iter < 12) {
        iter++;
        if (!onePass(w)) break;
    }

    // Build adjustment messages from initial → final, citing which caps
    // appear to have been the binding constraint.
    const adjustments = [];
    for (const tk of tokenSymbols) {
        const before = initial[tk] ?? 0;
        const after = w[tk] ?? 0;
        if (Math.abs(after - before) < 0.005) continue;   // skip < 0.5pp moves
        const reasons = [];
        const cap = tokenCapFor(tk);
        if (Math.abs(after - cap) < 0.005 && before > cap + 1e-9) {
            reasons.push(opts.volWeightK > 0 && !stableSet.has(tk) && !tailSet.has(tk) ? "vol-weighted cap" : "single-asset cap");
        }
        if (tailSet.has(tk) && (before > opts.maxLongtail || after < before)) {
            reasons.push("long-tail cap");
        }
        if (stableSet.has(tk) && opts.usdcFloor > 0 && after > before) {
            reasons.push("stable floor");
        }
        if (!reasons.length) reasons.push("redistribution");
        adjustments.push(
            `${tk}: ${(before * 100).toFixed(1)}% → ${(after * 100).toFixed(1)}% (${reasons.join(", ")})`
        );
    }

    return { weights: w, adjustments, iterations: iter };
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
        const { rawScores, normalized, fallbackNote } = personaToWeights(persona, tokens);
        perPersonaNormalized[persona.persona] = normalized;
        perPersonaRaw[persona.persona] = rawScores;
        if (fallbackNote) personaNotes[persona.persona] = fallbackNote;
    }

    const aggregated = aggregatePersonas(perPersonaNormalized, tokenSymbols);
    const { weights, adjustments } = applyCaps(aggregated, tokens, {
        maxSingle: args.maxSingle,
        maxLongtail: args.maxLongtail,
        usdcFloor: args.usdcFloor,
        volWeightK: args.volWeightK,
    });

    // Emit weights both as a {symbol:value} map (human-readable) and as
    // ordered arrays in basket order. The arrays are what `sherwood
    // strategy propose portfolio` wants: --tokens csv-of-addresses
    // --weights csv-of-bps. Ordered arrays remove the "did you preserve
    // basket order?" footgun from the SKILL.md invocation.
    const weights_bps_ordered = tokens.map(t => Math.round((weights[t.symbol] ?? 0) * 10000));
    const addresses_ordered = tokens.map(t => t.address);
    const tokens_ordered = tokens.map(t => t.symbol);

    // Sanity: bps must sum to 10000 ± rounding noise.
    const bpsSum = weights_bps_ordered.reduce((a, b) => a + b, 0);
    if (Math.abs(bpsSum - 10000) > 5) {
        console.error(`warning: weights_bps_ordered sum is ${bpsSum}, expected 10000 ± 5`);
    }
    // Fix rounding drift by adjusting the largest weight by the delta.
    if (bpsSum !== 10000 && weights_bps_ordered.length > 0) {
        const drift = 10000 - bpsSum;
        const largestIdx = weights_bps_ordered.indexOf(Math.max(...weights_bps_ordered));
        weights_bps_ordered[largestIdx] += drift;
    }

    const result = {
        weights: Object.fromEntries(
            Object.entries(weights).map(([k, v]) => [k, Number(v.toFixed(4))])
        ),
        weights_bps_ordered,
        addresses_ordered,
        tokens_ordered,
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
