#!/usr/bin/env node
// cycle.mjs — orchestrator for the hedge-fund Hermes skill.
//
// Splits what was previously one giant LLM turn into N+1 isolated calls:
// - One LLM call per persona (clean context, full attention to JSON schema)
// - Optional aggregator (deterministic, no LLM) chained at the end
//
// Each persona call:
// 1. Reads personas/<name>.md (the lens template)
// 2. Reads basket.json (token list + research metadata)
// 3. Constructs the full prompt = lens + literal token list + per-token
//    research metadata block + strict JSON output instruction
// 4. Calls the Hermes OpenAI-compatible gateway (API_SERVER_URL +
//    API_SERVER_KEY env, defaults work in-container)
// 5. Validates the JSON. Retries once on validation failure with a
//    "JSON only, no prose" instruction. Skips the persona on second
//    failure (logged).
// 6. Writes cycles/<id>/signals/<name>.json
//
// At the end, requires >= MIN_VALID_PERSONAS (default 2) successful
// persona signal files; otherwise exits non-zero so the skill aborts
// the cycle.
//
// Usage:
//   node cycle.mjs \
//       --basket cycles/2026-05-10/basket.json \
//       --personas buffett wood burry \
//       --personas-dir ../../personas \
//       --out-dir cycles/2026-05-10/signals \
//       --gateway-url http://127.0.0.1:8642 \
//       --gateway-key "$API_SERVER_KEY" \
//       --model "$HERMES_MODEL"

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const SIGNAL_VALUES = new Set(["bullish", "bearish", "neutral"]);
const MIN_VALID_PERSONAS = 2;
const MAX_REASONING_CHARS = 240;

function parseArgs(argv) {
    const args = {
        basket: null,
        personas: [],
        personasDir: null,
        outDir: null,
        gatewayUrl: process.env.API_SERVER_URL || "http://127.0.0.1:8642",
        gatewayKey: process.env.API_SERVER_KEY || null,
        model: process.env.HERMES_MODEL || null,
        verbose: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "--basket":        args.basket = argv[++i]; break;
            case "--personas":
                while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args.personas.push(argv[++i]);
                break;
            case "--personas-dir":  args.personasDir = argv[++i]; break;
            case "--out-dir":       args.outDir = argv[++i]; break;
            case "--gateway-url":   args.gatewayUrl = argv[++i]; break;
            case "--gateway-key":   args.gatewayKey = argv[++i]; break;
            case "--model":         args.model = argv[++i]; break;
            case "--verbose":       args.verbose = true; break;
            default: throw new Error(`unknown arg: ${a}`);
        }
    }
    if (!args.basket)       throw new Error("--basket required");
    if (!args.personasDir)  throw new Error("--personas-dir required");
    if (!args.outDir)       throw new Error("--out-dir required");
    if (args.personas.length === 0) throw new Error("--personas required (1+ names)");
    if (!args.gatewayKey)   throw new Error("--gateway-key (or API_SERVER_KEY env) required");
    if (!args.model)        throw new Error("--model (or HERMES_MODEL env) required");
    return args;
}

function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function readText(p) { return readFileSync(p, "utf8"); }

// Build the prompt fed to the LLM for a single persona.
// The persona file (lens) goes in as the system prompt. The basket +
// research metadata is rendered as a structured user message so the LLM
// can cite concrete numbers (mcap, vol, attention) per Burry's lens etc.
function buildPersonaPrompt(personaName, lensText, basket) {
    const tokens = basket.tokens ?? basket;
    const nameRow = (t) => {
        const tail = t.tail ? " [tail]" : "";
        const mcap = t.mcap_usd ? `$${(t.mcap_usd / 1e6).toFixed(1)}M` : "?";
        const vol = t.vol24_usd ? `$${(t.vol24_usd / 1e6).toFixed(1)}M` : "?";
        const att = t.attention_pct != null ? `${t.attention_pct.toFixed(2)}%` : "?";
        const sig = t.signal_score != null ? t.signal_score.toFixed(2) : "?";
        const sources = (t.sources || []).join(",") || "?";
        return `| ${t.symbol}${tail} | \`${t.address}\` | ${mcap} | ${vol} | ${att} | ${sig} | ${sources} |`;
    };
    const tokenTable = [
        "| symbol | address | mcap | 24h vol | attention | signal score | sources |",
        "|---|---|---|---|---|---|---|",
        ...tokens.map(nameRow),
    ].join("\n");

    const systemPrompt = lensText;
    const userPrompt = [
        `You are grading the following ${tokens.length}-token basket on Base mainnet for the zerohumanfund hedge-fund cycle.`,
        ``,
        `**Tokens (in order — your output MUST list them in this same order):**`,
        ``,
        tokenTable,
        ``,
        `Cite concrete numbers from the table when reasoning. Do not invent data.`,
        ``,
        `Emit ONE JSON object — no prose, no markdown fences, no surrounding text:`,
        ``,
        `{`,
        `  "persona": "${personaName}",`,
        `  "signals": [`,
        ...tokens.map((t, i) => `    {"token": "${t.symbol}", "signal": "bullish|bearish|neutral", "confidence": <int 0-100>, "reasoning": "<= ${MAX_REASONING_CHARS} chars"}${i < tokens.length - 1 ? "," : ""}`),
        `  ]`,
        `}`,
    ].join("\n");

    return { systemPrompt, userPrompt };
}

async function callGateway(args, systemPrompt, userPrompt, retryHint = null) {
    const url = `${args.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`;
    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt + (retryHint ? `\n\n${retryHint}` : "") },
    ];
    const r = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${args.gatewayKey}`,
        },
        body: JSON.stringify({
            model: args.model,
            messages,
            temperature: 0.5,
            max_tokens: 1500,
        }),
    });
    if (!r.ok) {
        const body = await r.text();
        throw new Error(`gateway HTTP ${r.status}: ${body.slice(0, 300)}`);
    }
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || "";
}

// Strip markdown fences if the LLM wrapped JSON in them despite instructions.
function extractJson(raw) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fenced) return fenced[1].trim();
    // Some models prefix with prose. Find the first { and the matching }.
    const start = raw.indexOf("{");
    if (start < 0) return raw;
    const end = raw.lastIndexOf("}");
    if (end > start) return raw.slice(start, end + 1);
    return raw;
}

function validate(parsed, personaName, basketSymbols) {
    if (!parsed || typeof parsed !== "object") return `not an object`;
    if (parsed.persona !== personaName) return `persona field is "${parsed.persona}", expected "${personaName}"`;
    if (!Array.isArray(parsed.signals)) return `signals must be an array`;
    if (parsed.signals.length !== basketSymbols.length) return `signals length ${parsed.signals.length} != basket size ${basketSymbols.length}`;
    for (let i = 0; i < basketSymbols.length; i++) {
        const sig = parsed.signals[i];
        if (sig?.token !== basketSymbols[i]) return `signals[${i}].token is "${sig?.token}", expected "${basketSymbols[i]}" (must match basket order)`;
        if (!SIGNAL_VALUES.has(sig?.signal)) return `signals[${i}].signal "${sig?.signal}" not in bullish|bearish|neutral`;
        const c = Number(sig?.confidence);
        if (!Number.isFinite(c) || c < 0 || c > 100) return `signals[${i}].confidence ${sig?.confidence} not in [0,100]`;
        if (typeof sig?.reasoning !== "string") return `signals[${i}].reasoning not a string`;
        if (sig.reasoning.length > MAX_REASONING_CHARS) return `signals[${i}].reasoning > ${MAX_REASONING_CHARS} chars`;
    }
    return null;
}

async function runPersona(args, personaName, basket) {
    const lensPath = resolve(args.personasDir, `${personaName}.md`);
    const lensText = readText(lensPath);
    const basketSymbols = (basket.tokens ?? basket).map(t => t.symbol);
    const { systemPrompt, userPrompt } = buildPersonaPrompt(personaName, lensText, basket);

    console.log(`\n[${personaName}] calling gateway…`);
    let raw;
    try {
        raw = await callGateway(args, systemPrompt, userPrompt);
    } catch (e) {
        console.error(`[${personaName}] gateway call failed: ${e.message}`);
        return { ok: false, reason: `gateway error: ${e.message}` };
    }
    if (args.verbose) console.log(`[${personaName}] raw output:\n${raw.slice(0, 500)}…`);

    let parsed;
    try { parsed = JSON.parse(extractJson(raw)); }
    catch (e) {
        console.warn(`[${personaName}] JSON parse failed: ${e.message} — retrying with stricter instruction`);
        const retryHint = "Your previous response was not valid JSON. Emit ONE JSON object and absolutely nothing else — no markdown, no prose, no fences.";
        try {
            raw = await callGateway(args, systemPrompt, userPrompt, retryHint);
            parsed = JSON.parse(extractJson(raw));
        } catch (e2) {
            console.error(`[${personaName}] retry also failed: ${e2.message}`);
            return { ok: false, reason: `JSON parse failed twice: ${e2.message}` };
        }
    }

    const err = validate(parsed, personaName, basketSymbols);
    if (err) {
        console.warn(`[${personaName}] schema validation failed: ${err} — retrying with corrective hint`);
        const retryHint = `Your previous response failed validation: ${err}. Emit ONE JSON object that strictly matches the schema. Tokens MUST appear in this exact order: ${basketSymbols.join(", ")}.`;
        try {
            raw = await callGateway(args, systemPrompt, userPrompt, retryHint);
            parsed = JSON.parse(extractJson(raw));
            const err2 = validate(parsed, personaName, basketSymbols);
            if (err2) {
                console.error(`[${personaName}] retry also failed validation: ${err2}`);
                return { ok: false, reason: `schema validation failed twice: ${err2}` };
            }
        } catch (e2) {
            console.error(`[${personaName}] retry threw: ${e2.message}`);
            return { ok: false, reason: `retry threw: ${e2.message}` };
        }
    }

    const outPath = resolve(args.outDir, `${personaName}.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(parsed, null, 2) + "\n");
    console.log(`[${personaName}] wrote ${outPath}`);
    return { ok: true, signals: parsed.signals };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const basket = readJson(args.basket);
    const tokens = basket.tokens ?? basket;
    const symbols = tokens.map(t => t.symbol);

    console.log(`== cycle.mjs ==  basket: ${symbols.join(", ")}  (${symbols.length} tokens)`);
    console.log(`gateway: ${args.gatewayUrl}  model: ${args.model}  personas: ${args.personas.join(", ")}`);

    const results = {};
    for (const name of args.personas) {
        results[name] = await runPersona(args, name, basket);
    }

    const valid = Object.entries(results).filter(([, r]) => r.ok);
    const failed = Object.entries(results).filter(([, r]) => !r.ok);

    console.log(`\n== persona round summary ==`);
    console.log(`  valid:  ${valid.map(([n]) => n).join(", ") || "(none)"}`);
    if (failed.length) console.log(`  failed: ${failed.map(([n, r]) => `${n} (${r.reason})`).join("; ")}`);

    if (valid.length < MIN_VALID_PERSONAS) {
        console.error(`\nFAIL: only ${valid.length} valid persona signal(s); need >= ${MIN_VALID_PERSONAS} to proceed. Aborting cycle.`);
        process.exit(2);
    }

    // Print a manifest the SKILL.md / aggregate.mjs can pick up.
    const manifest = {
        valid_personas: valid.map(([n]) => n),
        failed_personas: failed.map(([n, r]) => ({ persona: n, reason: r.reason })),
        signal_files: valid.map(([n]) => resolve(args.outDir, `${n}.json`)),
        basket_path: resolve(args.basket),
        out_dir: resolve(args.outDir),
        generated_at: new Date().toISOString(),
    };
    const manifestPath = resolve(args.outDir, "..", "persona-round.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`\nwrote manifest: ${manifestPath}`);
    console.log(`next: node aggregate.mjs --signals ${manifest.signal_files.join(" ")} --tokens ${args.basket} --out target-weights.json`);
}

main().catch(e => {
    console.error(e?.stack ?? e?.message ?? e);
    process.exit(1);
});
