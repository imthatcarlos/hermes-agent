#!/usr/bin/env node
// research.mjs — x402-paid token discovery for the hedge-fund Hermes skill.
//
// Calls CoinGecko AI Agent Hub + Checkr Social via x402 micropayments
// (USDC on Base mainnet) to discover the top-N tokens for a cycle's basket.
//
// Per-cycle spend: ~$0.22 USDC (1 trending pool call + 1 Checkr leaderboard +
// 1 Checkr signal radar + 1 token-price bulk lookup).
//
// Inputs:
//   AGENT_PRIVATE_KEY  EVM private key paying the x402 calls (must hold USDC on Base)
//   BASE_RPC_URL       (optional) Base RPC; defaults to publicnode
//
// Usage:
//   node research.mjs --execute --out cycles/2026-05-10/basket.json --top-n 5
//   node research.mjs --dry-run                      # describes what it would do, no spend
//   node research.mjs --execute --out basket.json --max-spend-usdc 0.50 --top-n 5
//
// Output (basket.json) follows the same shape consumed by aggregate.mjs:
//   { tokens: [{ symbol, address, decimals, tail, mcap_usd, vol24_usd, attention_score, signal_score, sources: [...] }, ...],
//     research_summary: { … },
//     generated_at }

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const COINGECKO_BASE = "https://pro-api.coingecko.com/api/v3/x402";
const CHECKR_BASE = "https://api.checkr.social/v1";
const DEXSCREENER_BASE = "https://api.dexscreener.com";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_BASE = "0x4200000000000000000000000000000000000006";

function parseArgs(argv) {
    const args = {
        out: "basket.json",
        execute: false,
        dryRun: false,
        topN: 5,
        maxSpendUsdc: 0.5,           // hard cap on total per call (Coingecko=$0.01, Checkr signal=$0.15)
        skipCheckr: false,           // fall back to Coingecko-only if Checkr is down
        skipDexscreener: false,      // skip the free Base coverage source
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "--out":            args.out = argv[++i]; break;
            case "--execute":        args.execute = true; break;
            case "--dry-run":        args.dryRun = true; break;
            case "--top-n":          args.topN = parseInt(argv[++i], 10); break;
            case "--max-spend-usdc": args.maxSpendUsdc = parseFloat(argv[++i]); break;
            case "--skip-checkr":    args.skipCheckr = true; break;
            case "--skip-dexscreener": args.skipDexscreener = true; break;
            default:
                throw new Error(`unknown arg: ${a}`);
        }
    }
    return args;
}

function makeFetchPaid(maxSpendUsdc) {
    const pk = process.env.AGENT_PRIVATE_KEY;
    if (!pk) throw new Error("AGENT_PRIVATE_KEY env var required");
    const normalized = pk.startsWith("0x") ? pk : `0x${pk}`;
    const account = privateKeyToAccount(normalized);
    // x402 v2 wires the wallet via @x402/evm's ExactEvmScheme.
    // network "eip155:8453" = Base mainnet.
    return wrapFetchWithPaymentFromConfig(globalThis.fetch, {
        schemes: [
            { network: "eip155:8453", client: new ExactEvmScheme(account) },
        ],
        // The wrapper also enforces a per-request maxValue downstream; we use
        // a hard ceiling so a misbehaving server can't drain the wallet.
        // Express in USDC base units (6 decimals).
    });
}

async function fetchJson(label, url, fetchPaid) {
    let r;
    try {
        r = await fetchPaid(url);
    } catch (e) {
        // x402-fetch v2 throws on payment-related failures (insufficient
        // USDC, signature reject, header version mismatch, etc.). Surface a
        // clear message naming the most likely causes first.
        const msg = e?.message || String(e);
        const hints = [];
        if (/exceeds maximum allowed/i.test(msg)) hints.push("the endpoint demanded more USDC than --max-spend-usdc allows; raise the cap if you trust it");
        if (/insufficient/i.test(msg)) hints.push("agent wallet may be out of USDC on Base — fund it");
        if (/PAYMENT-SIGNATURE|X-PAYMENT/i.test(msg)) hints.push("possible v1↔v2 x402 header mismatch — try downgrading to x402-fetch@^1.x if the upstream API expects PAYMENT-SIGNATURE");
        throw new Error(`${label} → ${msg}${hints.length ? `\n  hint: ${hints.join("; ")}` : ""}`);
    }
    if (!r.ok) throw new Error(`${label} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
}

// ---- CoinGecko: trending pools on Base (24h) ----
//
// We filter to pools quoted in stables (USDC, USDT, EURC, etc.) so we only
// surface token candidates with a USD-denominated price reference for
// downstream rebalancing — and so we don't accidentally grade a stablecoin
// pair (USDC/USDT) as a "hot pick." We also filter out base tokens whose
// symbol IS a stable (the base side of WETH/USDC is WETH, but if we somehow
// see USDC/USDT the base is USDC and gets dropped here too).
const STABLE_QUOTE_PATTERN = /^(USDC|USDT|EURC|DAI|FRAX|USDe|PYUSD|GUSD|TUSD|crvUSD|sDAI)$/i;

async function cgTrendingBase(fetchPaid) {
    const url = `${COINGECKO_BASE}/onchain/networks/base/trending_pools?page=1&duration=24h&include=base_token,quote_token,dex`;
    const data = await fetchJson("cg.trending", url, fetchPaid);
    // JSON:API shape: data[].relationships.base_token.data.id is "base_TOKEN_<addr>"
    const included = Object.fromEntries((data.included || []).map(i => [`${i.type}:${i.id}`, i]));
    return (data.data || []).map((pool, idx) => {
        const baseRef = pool.relationships?.base_token?.data;
        const quoteRef = pool.relationships?.quote_token?.data;
        const baseTok = baseRef ? included[`${baseRef.type}:${baseRef.id}`] : null;
        const quoteTok = quoteRef ? included[`${quoteRef.type}:${quoteRef.id}`] : null;
        return {
            rank: idx + 1,
            base_address: baseTok?.attributes?.address?.toLowerCase(),
            base_symbol: baseTok?.attributes?.symbol,
            base_name: baseTok?.attributes?.name,
            base_decimals: baseTok?.attributes?.decimals,
            quote_symbol: quoteTok?.attributes?.symbol,
            quote_address: quoteTok?.attributes?.address?.toLowerCase(),
            volume_usd_h24: parseFloat(pool.attributes?.volume_usd?.h24 || "0"),
            price_change_h24: parseFloat(pool.attributes?.price_change_percentage?.h24 || "0"),
        };
    }).filter(p => {
        if (!p.base_address) return false;
        // Must be quoted in a stable so we have a USD price reference.
        if (!p.quote_symbol || !STABLE_QUOTE_PATTERN.test(p.quote_symbol)) return false;
        // Drop pools whose base side is itself a stable (stable/stable pairs).
        if (p.base_symbol && STABLE_QUOTE_PATTERN.test(p.base_symbol)) return false;
        return true;
    });
}

// ---- CoinGecko: bulk token data by address (decimals + mcap + vol) ----
async function cgTokenPrices(addresses, fetchPaid) {
    if (addresses.length === 0) return {};
    const csv = addresses.join(",");
    const url = `${COINGECKO_BASE}/onchain/simple/networks/base/token_price/${csv}` +
        `?include_market_cap=true&mcap_fdv_fallback=true&include_24hr_vol=true&include_24hr_price_change=true`;
    const data = await fetchJson("cg.tokenPrices", url, fetchPaid);
    // Expected: { data: { attributes: { token_prices: { "0xaddr": "1.23" }, ... } } }
    // Schema for the simple endpoint isn't pinned — we defensively walk both shapes.
    const root = data.data?.attributes ?? data.data ?? data;
    const out = {};
    for (const addr of addresses) {
        const lower = addr.toLowerCase();
        out[lower] = {
            price_usd: parseFloat(root.token_prices?.[lower] ?? root.prices?.[lower] ?? "0"),
            mcap_usd: parseFloat(root.market_caps?.[lower] ?? root.market_cap?.[lower] ?? "0"),
            vol24_usd: parseFloat(root.h24_volume_usd?.[lower] ?? root.volume_24h?.[lower] ?? "0"),
        };
    }
    return out;
}

// ---- Checkr Social: leaderboard + signal radar ----
async function checkrLeaderboard(fetchPaid) {
    const url = `${CHECKR_BASE}/leaderboard?limit=20&hours=24`;
    const data = await fetchJson("checkr.leaderboard", url, fetchPaid);
    // Expected shape: { tokens: [{ symbol, address?, ATT_pct, MS_pct, INF_pct, velocity, ... }] }
    return (data.tokens || data || []).map((t, idx) => ({
        rank: idx + 1,
        symbol: t.symbol,
        address: (t.address || t.contract || t.ca || "").toLowerCase() || null,
        attention_pct: parseFloat(t.ATT_pct ?? t.attention_pct ?? "0"),
        velocity: parseFloat(t.velocity ?? "0"),
        unique_authors: parseInt(t.unique_authors ?? "0", 10),
    }));
}

// ---- DexScreener: free, no x402. Returns all pairs that include USDC or
// WETH on Base, sorted by 24h volume. Gives ~30-50 liquid Base tokens with
// no payment overhead. Used as the primary discovery source when CoinGecko
// trending is shallow.
async function dexscreenerBaseLiquid(seedAddresses = [USDC_BASE, WETH_BASE]) {
    const out = new Map();
    for (const seed of seedAddresses) {
        const url = `${DEXSCREENER_BASE}/token-pairs/v1/base/${seed}`;
        let pairs;
        try {
            const r = await fetch(url);
            if (!r.ok) {
                console.error(`dexscreener seed=${seed} HTTP ${r.status} — skipping`);
                continue;
            }
            pairs = await r.json();
        } catch (e) {
            console.error(`dexscreener seed=${seed} threw: ${e.message} — skipping`);
            continue;
        }
        if (!Array.isArray(pairs)) continue;
        for (const pair of pairs) {
            if (pair.chainId !== "base") continue;
            // Pick whichever side ISN'T the seed address — that's the
            // "discovered" token. Skip pairs where both sides are stables/WETH.
            const baseAddr = pair.baseToken?.address?.toLowerCase();
            const quoteAddr = pair.quoteToken?.address?.toLowerCase();
            const seedLower = seed.toLowerCase();
            let tok;
            if (baseAddr && baseAddr !== seedLower) tok = { ...pair.baseToken, address: baseAddr };
            else if (quoteAddr && quoteAddr !== seedLower) tok = { ...pair.quoteToken, address: quoteAddr };
            else continue;
            // Skip if the discovered token is itself a stable.
            if (STABLE_QUOTE_PATTERN.test(tok.symbol || "")) continue;
            // Aggregate by token; sum volume and keep the best mcap signal
            // across pairs (DexScreener may return multiple pools per token).
            const existing = out.get(tok.address) || {
                base_address: tok.address,
                base_symbol: tok.symbol,
                base_name: tok.name || tok.symbol,
                base_decimals: 18,
                volume_usd_h24: 0,
                liquidity_usd: 0,
                price_usd: 0,
                mcap_usd: 0,
                fdv_usd: 0,
                source: "dexscreener",
            };
            existing.volume_usd_h24 += parseFloat(pair.volume?.h24 || "0");
            existing.liquidity_usd += parseFloat(pair.liquidity?.usd || "0");
            existing.price_usd = parseFloat(pair.priceUsd || "0") || existing.price_usd;
            const pmcap = parseFloat(pair.marketCap || "0");
            const pfdv = parseFloat(pair.fdv || "0");
            if (pmcap > existing.mcap_usd) existing.mcap_usd = pmcap;
            if (pfdv > existing.fdv_usd) existing.fdv_usd = pfdv;
            out.set(tok.address, existing);
        }
    }
    // Sort by 24h volume descending; trim to 60 to keep merge size manageable.
    return [...out.values()]
        .sort((a, b) => b.volume_usd_h24 - a.volume_usd_h24)
        .slice(0, 60);
}

async function checkrSignals(fetchPaid) {
    const url = `${CHECKR_BASE}/signal?limit=10&spiking_only=false`;
    const data = await fetchJson("checkr.signal", url, fetchPaid);
    return (data.signals || data || []).map(s => ({
        symbol: s.symbol,
        address: (s.address || s.contract || s.ca || "").toLowerCase() || null,
        score: parseFloat(s.score ?? "0"),
        signal_type: s.signal_type,
        entry_quality: s.timing?.entry_quality,
        urgency: s.timing?.urgency,
    }));
}

// ---- Merge / score ----
function mergeAndScore({ trending, leaderboard, signals, dexscreener }) {
    const candidates = new Map();   // key: lowercase address

    function upsert(key, patch) {
        if (!key) return;
        const existing = candidates.get(key) || {
            address: key, sources: [],
            cg_volume_usd_h24: 0, cg_rank: 999,
            ds_volume_usd_h24: 0, ds_liquidity_usd: 0, ds_mcap_usd: 0,
            checkr_attention_pct: 0, checkr_velocity: 0, checkr_signal_score: 0,
        };
        candidates.set(key, { ...existing, ...patch, sources: [...new Set([...existing.sources, ...(patch.sources || [])])] });
    }

    for (const p of trending) {
        upsert(p.base_address, {
            symbol: p.base_symbol,
            name: p.base_name,
            decimals: p.base_decimals,
            cg_rank: p.rank,
            cg_volume_usd_h24: p.volume_usd_h24,
            cg_quote_symbol: p.quote_symbol,
            sources: ["coingecko"],
        });
    }
    for (const d of dexscreener) {
        upsert(d.base_address, {
            symbol: d.base_symbol || candidates.get(d.base_address)?.symbol,
            name: d.base_name || candidates.get(d.base_address)?.name,
            decimals: d.base_decimals ?? candidates.get(d.base_address)?.decimals ?? 18,
            ds_volume_usd_h24: d.volume_usd_h24,
            ds_liquidity_usd: d.liquidity_usd,
            ds_mcap_usd: d.mcap_usd || d.fdv_usd,
            ds_price_usd: d.price_usd,
            sources: ["dexscreener"],
        });
    }
    for (const t of leaderboard) {
        if (!t.address) continue;
        upsert(t.address, {
            symbol: t.symbol || candidates.get(t.address)?.symbol,
            checkr_attention_pct: t.attention_pct,
            checkr_velocity: t.velocity,
            sources: ["checkr-leaderboard"],
        });
    }
    for (const s of signals) {
        if (!s.address) continue;
        upsert(s.address, {
            symbol: s.symbol || candidates.get(s.address)?.symbol,
            checkr_signal_score: s.score,
            checkr_signal_type: s.signal_type,
            checkr_entry_quality: s.entry_quality,
            checkr_urgency: s.urgency,
            sources: ["checkr-signal"],
        });
    }

    // Score each candidate. Scale each axis to 0..1 then weighted sum.
    const arr = [...candidates.values()];
    if (arr.length === 0) return arr;
    const maxCgVol = Math.max(...arr.map(c => c.cg_volume_usd_h24), 1);
    const maxDsVol = Math.max(...arr.map(c => c.ds_volume_usd_h24), 1);
    const maxLiq   = Math.max(...arr.map(c => c.ds_liquidity_usd), 1);
    const maxAtt = Math.max(...arr.map(c => c.checkr_attention_pct), 1);
    const maxSig = Math.max(...arr.map(c => c.checkr_signal_score), 1);

    for (const c of arr) {
        // Combined volume score: max of CG-trending vs DexScreener (they
        // measure the same underlying signal but have different coverage).
        const volScore = Math.max(c.cg_volume_usd_h24 / maxCgVol, c.ds_volume_usd_h24 / maxDsVol);
        const liqScore = c.ds_liquidity_usd / maxLiq;
        const attScore = c.checkr_attention_pct / maxAtt;
        const sigScore = c.checkr_signal_score / maxSig;
        // Weights: volume 0.40, liquidity 0.20, attention 0.25, signal 0.15.
        // Volume dominates because price discovery > narrative; liquidity
        // is a slippage proxy (we'll be selling into these); attention +
        // signal are momentum/catalyst.
        c.score = 0.40 * volScore + 0.20 * liqScore + 0.25 * attScore + 0.15 * sigScore;
        // Multi-source bonus: tokens visible in 2+ source families get +10%.
        const families = new Set();
        for (const s of c.sources) {
            if (s === "coingecko") families.add("cg");
            else if (s === "dexscreener") families.add("ds");
            else if (s.startsWith("checkr")) families.add("checkr");
        }
        if (families.size >= 2) c.score *= 1.10;
        if (families.size >= 3) c.score *= 1.05;   // additional +5% for triple-confirmed
    }
    arr.sort((a, b) => b.score - a.score);
    return arr;
}

function classifyTail(mcap_usd) {
    return mcap_usd > 0 && mcap_usd < 10_000_000;   // < $10M mcap = long-tail
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.dryRun) {
        console.log("== research.mjs DRY-RUN ==");
        console.log("Would call:");
        console.log("  DexScreener token-pairs (USDC + WETH on Base)  free");
        console.log("  CoinGecko trending_pools (Base, 24h)         ~$0.01 USDC");
        console.log("  Checkr leaderboard (24h, top 20)             ~$0.05 USDC");
        console.log("  Checkr signal (top 10)                        ~$0.15 USDC");
        console.log("  CoinGecko token_price (top 8 candidates)     ~$0.01 USDC");
        console.log(`Top-N tokens to output: ${args.topN}`);
        console.log(`Total budget: <= $${args.maxSpendUsdc.toFixed(2)} USDC`);
        console.log(`Output path: ${args.out}`);
        console.log("(no payment, no network calls)");
        return;
    }
    if (!args.execute) throw new Error("pass --execute to actually pay+fetch (or --dry-run)");

    const fetchPaid = makeFetchPaid(args.maxSpendUsdc);

    console.log("== research.mjs LIVE ==  (signing x402 payments + free DexScreener calls)");

    // Pull discovery sources in parallel. DexScreener is free; everything
    // else is x402-paid. We always call DexScreener so the basket has
    // depth even if CoinGecko trending is shallow on the day.
    const tasks = [];
    const labels = [];
    if (!args.skipDexscreener) { tasks.push(dexscreenerBaseLiquid()); labels.push("dexscreener"); }
    tasks.push(cgTrendingBase(fetchPaid));                              labels.push("cg.trending");
    if (!args.skipCheckr) {
        tasks.push(checkrLeaderboard(fetchPaid));                       labels.push("checkr.leaderboard");
        tasks.push(checkrSignals(fetchPaid));                           labels.push("checkr.signal");
    }
    let dexscreener = [], trending = [], leaderboard = [], signals = [];
    const buckets = { dexscreener: [], "cg.trending": [], "checkr.leaderboard": [], "checkr.signal": [] };
    try {
        const results = await Promise.allSettled(tasks);
        for (const [i, r] of results.entries()) {
            const label = labels[i];
            if (r.status === "rejected") {
                console.error(`  ${label} FAILED: ${r.reason?.message ?? r.reason}`);
            } else {
                buckets[label] = r.value;
                console.log(`  ${label}: ${r.value.length} candidates`);
            }
        }
        dexscreener = buckets.dexscreener;
        trending    = buckets["cg.trending"];
        leaderboard = buckets["checkr.leaderboard"];
        signals     = buckets["checkr.signal"];
    } catch (e) {
        throw new Error(`discovery phase failed: ${e.message}`);
    }
    if (dexscreener.length + trending.length === 0) {
        throw new Error("Both DexScreener AND CoinGecko returned no candidates — cannot build basket without a price-discovery source");
    }

    // Merge + score.
    const ranked = mergeAndScore({ trending, leaderboard, signals, dexscreener });
    if (ranked.length < args.topN) {
        console.warn(`WARN: only ${ranked.length} candidates after merge, requested ${args.topN}. Will return all available.`);
    }
    const top = ranked.slice(0, Math.max(args.topN, Math.min(ranked.length, 12)));

    // Bulk-fetch decimals + mcap for top candidates so we can validate addresses + tag tail tokens.
    const addrs = top.map(c => c.address).filter(Boolean);
    let prices = {};
    try { prices = await cgTokenPrices(addrs, fetchPaid); }
    catch (e) { console.error(`token_prices lookup failed: ${e.message} — proceeding with scoring data only`); }

    const enriched = top.map(c => ({
        ...c,
        ...(prices[c.address] || {}),
    }));

    const finalTokens = enriched.slice(0, args.topN).map(c => {
        // Mcap precedence: CG-x402 token_price → DexScreener mcap → 0
        const mcap = (c.mcap_usd ?? 0) || (c.ds_mcap_usd ?? 0) || 0;
        // Vol precedence: CG-x402 vol → CG-trending vol → DexScreener vol
        const vol = (c.vol24_usd ?? 0) || (c.cg_volume_usd_h24 ?? 0) || (c.ds_volume_usd_h24 ?? 0);
        return {
            symbol: c.symbol,
            address: c.address,
            decimals: c.decimals ?? 18,
            tail: classifyTail(mcap),
            mcap_usd: mcap,
            vol24_usd: vol,
            liquidity_usd: c.ds_liquidity_usd ?? 0,
            attention_pct: c.checkr_attention_pct ?? 0,
            signal_score: c.checkr_signal_score ?? 0,
            score: Number(c.score.toFixed(4)),
            sources: c.sources,
        };
    });

    const out = {
        tokens: finalTokens,
        research_summary: {
            n_candidates: ranked.length,
            n_dexscreener: dexscreener.length,
            n_trending: trending.length,
            n_leaderboard: leaderboard.length,
            n_signals: signals.length,
            top_dropped: ranked.slice(args.topN, args.topN + 5).map(c => ({
                symbol: c.symbol, address: c.address, score: Number(c.score.toFixed(4)),
            })),
        },
        generated_at: new Date().toISOString(),
    };

    if (args.out) {
        mkdirSync(dirname(args.out), { recursive: true });
        writeFileSync(args.out, JSON.stringify(out, null, 2) + "\n");
        console.log(`wrote ${args.out}`);
    } else {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    }

    console.log("== basket ==");
    for (const t of finalTokens) {
        const tail = t.tail ? "  [tail]" : "";
        console.log(`  ${(t.symbol || "?").padEnd(8)} ${t.address}  mcap=$${(t.mcap_usd / 1e6).toFixed(1)}M  vol24=$${(t.vol24_usd / 1e6).toFixed(1)}M  score=${t.score}${tail}`);
    }
}

main().catch(e => {
    console.error(e?.stack ?? e?.message ?? e);
    process.exit(1);
});
