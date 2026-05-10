#!/usr/bin/env node
// diagnose-x402.mjs — verbose end-to-end test of one x402 call.
//
// Use when CoinGecko / Checkr x402 calls fail and you can't tell why.
// Walks through the protocol manually and prints every payload at every
// step so you can see exactly what got signed and what the server returned.
//
// Also reads the agent wallet's USDC balance and ETH balance so you can
// rule out "out of funds" before going deeper.
//
// Usage:
//   node diagnose-x402.mjs --url <full-x402-endpoint-url>
//   node diagnose-x402.mjs --url https://pro-api.coingecko.com/api/v3/x402/onchain/networks/base/trending_pools

import process from "node:process";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits, parseAbi } from "viem";
import { base } from "viem/chains";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ERC20_ABI = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function nonces(address) view returns (uint256)",
    "function name() view returns (string)",
    "function version() view returns (string)",
]);

function arg(name, fallback = null) {
    const i = process.argv.indexOf(name);
    if (i < 0) return fallback;
    return process.argv[i + 1];
}

async function main() {
    const url = arg("--url");
    if (!url) {
        console.error("usage: node diagnose-x402.mjs --url <x402-endpoint>");
        process.exit(1);
    }
    const pk = process.env.AGENT_PRIVATE_KEY;
    if (!pk) {
        console.error("AGENT_PRIVATE_KEY env var required");
        process.exit(1);
    }
    const normalized = pk.startsWith("0x") ? pk : `0x${pk}`;
    const account = privateKeyToAccount(normalized);
    const rpcUrl = process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com";
    const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

    console.log("== x402 diagnostic ==");
    console.log(`url:      ${url}`);
    console.log(`agent:    ${account.address}`);
    console.log(`rpc:      ${rpcUrl}`);

    // 1) Wallet balance check.
    try {
        const usdcBal = await publicClient.readContract({
            address: USDC_BASE, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
        });
        const ethBal = await publicClient.getBalance({ address: account.address });
        console.log(`USDC bal: $${formatUnits(usdcBal, 6)}`);
        console.log(`ETH bal:  ${formatUnits(ethBal, 18)} ETH`);
        if (usdcBal === 0n) console.warn("WARN: agent wallet has 0 USDC — x402 calls will fail");
    } catch (e) {
        console.error(`balance check failed: ${e.message}`);
    }

    // 2) Read USDC contract domain (name + version) — must match what the
    //    payment requirements specify in extra.{name,version}, otherwise the
    //    EIP-712 signature recovers to the wrong address and the facilitator
    //    rejects with a vague 400.
    try {
        const onchainName = await publicClient.readContract({
            address: USDC_BASE, abi: ERC20_ABI, functionName: "name",
        });
        const onchainVersion = await publicClient.readContract({
            address: USDC_BASE, abi: ERC20_ABI, functionName: "version",
        });
        console.log(`USDC onchain name:    "${onchainName}"`);
        console.log(`USDC onchain version: "${onchainVersion}"`);
    } catch (e) {
        console.warn(`USDC contract read failed (some chains don't expose version()): ${e.message}`);
    }

    // 3) Unauthenticated probe of the endpoint to read its payment requirements.
    console.log("\n== probing endpoint without payment ==");
    let probeR;
    try {
        probeR = await fetch(url);
        console.log(`status: ${probeR.status} ${probeR.statusText}`);
        const reqHeader = probeR.headers.get("payment-required");
        if (reqHeader) {
            try {
                const decoded = JSON.parse(Buffer.from(reqHeader, "base64").toString("utf8"));
                console.log("decoded payment-required header:");
                console.log(JSON.stringify(decoded, null, 2));
            } catch {
                console.log(`raw payment-required header: ${reqHeader.slice(0, 200)}…`);
            }
        }
        const body = await probeR.text();
        if (body) console.log(`body (first 500): ${body.slice(0, 500)}`);
    } catch (e) {
        console.error(`probe failed: ${e.message}`);
    }

    // 4) Real x402 attempt with logging-wrapped fetch so we can capture the
    //    outgoing X-PAYMENT header and the actual response body.
    console.log("\n== full x402 attempt with @x402/fetch v2 ==");
    const loggingFetch = async (input, init) => {
        const req = new Request(input, init);
        // Log outgoing headers (especially X-PAYMENT, base64-decoded if present)
        const outHeaders = {};
        req.headers.forEach((v, k) => { outHeaders[k] = v; });
        console.log("→ outgoing headers (relevant):");
        for (const k of Object.keys(outHeaders).filter(k => /payment|x402|content-type|authorization/i.test(k))) {
            const v = outHeaders[k];
            console.log(`    ${k}: ${v.length > 100 ? v.slice(0, 100) + "…" : v}`);
            if (k.toLowerCase() === "x-payment") {
                try {
                    const decoded = JSON.parse(Buffer.from(v, "base64").toString("utf8"));
                    console.log(`    ↳ decoded x-payment payload:`);
                    console.log(JSON.stringify(decoded, null, 2).split("\n").map(l => "      " + l).join("\n"));
                } catch {}
            }
        }
        const res = await fetch(req);
        console.log(`← response: ${res.status} ${res.statusText}`);
        // Clone so we can read body for logging without consuming the stream
        const clone = res.clone();
        const body = await clone.text();
        console.log(`← body (first 800): ${body.slice(0, 800)}`);
        return res;
    };

    const fetchPaid = wrapFetchWithPaymentFromConfig(loggingFetch, {
        schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
    });

    try {
        const r = await fetchPaid(url);
        console.log(`\n== final response: ${r.status} ${r.statusText} ==`);
        if (r.ok) {
            const j = await r.json();
            console.log(`SUCCESS — got JSON with ${Object.keys(j).join(", ")}`);
        } else {
            const body = await r.text();
            console.log(`FAILED body: ${body.slice(0, 800)}`);
        }
    } catch (e) {
        console.error(`x402 wrapper threw: ${e?.stack ?? e?.message ?? e}`);
    }
}

main().catch(e => { console.error(e?.stack ?? e?.message ?? e); process.exit(1); });
