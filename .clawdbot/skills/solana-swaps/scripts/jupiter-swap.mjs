#!/usr/bin/env node
/**
 * jupiter-swap.mjs
 * Sign and submit Jupiter swap transactions to Solana
 *
 * Usage:
 *   node jupiter-swap.mjs --keypair <path> --transaction <base64>
 *   node jupiter-swap.mjs --transaction <base64>  # Uses SOLANA_KEYPAIR env var
 *
 * Arguments:
 *   --keypair      Path to Solana keypair JSON file (optional if SOLANA_KEYPAIR env is set)
 *   --transaction  Base64-encoded unsigned swap transaction from Jupiter API
 *   --rpc          (Optional) Custom RPC endpoint (default: mainnet-beta)
 *
 * Environment Variables:
 *   SOLANA_KEYPAIR       JSON array of secret key bytes (takes precedence over file)
 *   SOLANA_KEYPAIR_PATH  Path to keypair file (fallback if SOLANA_KEYPAIR not set)
 */

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { readFileSync, existsSync } from 'fs';

// Parse command line arguments
function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keypair' && args[i + 1]) {
      result.keypair = args[++i];
    } else if (args[i] === '--transaction' && args[i + 1]) {
      result.transaction = args[++i];
    } else if (args[i] === '--rpc' && args[i + 1]) {
      result.rpc = args[++i];
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

// Validate required arguments
if (!args.transaction) {
  console.error('Usage: node jupiter-swap.mjs --keypair <path> --transaction <base64>');
  console.error('       node jupiter-swap.mjs --transaction <base64>  # Uses env vars');
  console.error('');
  console.error('Arguments:');
  console.error('  --keypair      Path to Solana keypair JSON file (optional)');
  console.error('  --transaction  Base64-encoded unsigned swap transaction');
  console.error('  --rpc          (Optional) Custom RPC endpoint');
  console.error('');
  console.error('Environment Variables:');
  console.error('  SOLANA_KEYPAIR       JSON array of secret key bytes (preferred)');
  console.error('  SOLANA_KEYPAIR_PATH  Path to keypair file (fallback)');
  process.exit(1);
}

/**
 * Load keypair from environment variable or file
 * Priority: SOLANA_KEYPAIR env > --keypair arg > SOLANA_KEYPAIR_PATH env
 */
function loadKeypair() {
  // 1. Check SOLANA_KEYPAIR environment variable (JSON array)
  if (process.env.SOLANA_KEYPAIR) {
    console.log('Loading keypair from SOLANA_KEYPAIR environment variable...');
    try {
      const secretKeyData = JSON.parse(process.env.SOLANA_KEYPAIR);
      return Keypair.fromSecretKey(new Uint8Array(secretKeyData));
    } catch (e) {
      console.error('Error parsing SOLANA_KEYPAIR env var:', e.message);
      process.exit(1);
    }
  }

  // 2. Check --keypair command line argument
  if (args.keypair) {
    console.log(`Loading keypair from file: ${args.keypair}`);
    if (!existsSync(args.keypair)) {
      console.error(`Keypair file not found: ${args.keypair}`);
      process.exit(1);
    }
    const secretKeyData = JSON.parse(readFileSync(args.keypair, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKeyData));
  }

  // 3. Check SOLANA_KEYPAIR_PATH environment variable
  if (process.env.SOLANA_KEYPAIR_PATH) {
    const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
    console.log(`Loading keypair from SOLANA_KEYPAIR_PATH: ${keypairPath}`);
    if (!existsSync(keypairPath)) {
      console.error(`Keypair file not found: ${keypairPath}`);
      process.exit(1);
    }
    const secretKeyData = JSON.parse(readFileSync(keypairPath, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKeyData));
  }

  // No keypair source found
  console.error('No keypair provided. Set SOLANA_KEYPAIR env var, use --keypair, or set SOLANA_KEYPAIR_PATH');
  process.exit(1);
}

async function main() {
  try {
    // Load keypair
    const wallet = loadKeypair();
    console.log(`Wallet address: ${wallet.publicKey.toBase58()}`);

    // Connect to Solana
    const rpcEndpoint = args.rpc || 'https://api.mainnet-beta.solana.com';
    console.log(`Connecting to ${rpcEndpoint}...`);
    const connection = new Connection(rpcEndpoint, 'confirmed');

    // Deserialize the transaction
    console.log('Deserializing transaction...');
    const transactionBuffer = Buffer.from(args.transaction, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuffer);

    // Sign the transaction
    console.log('Signing transaction...');
    transaction.sign([wallet]);

    // Send the transaction
    console.log('Submitting transaction...');
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      maxRetries: 3,
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });

    console.log(`Transaction submitted: ${signature}`);
    console.log(`Solscan: https://solscan.io/tx/${signature}`);

    // Wait for confirmation
    console.log('Waiting for confirmation...');
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: transaction.message.recentBlockhash,
        lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight
      },
      'confirmed'
    );

    if (confirmation.value.err) {
      console.error('Transaction failed:', JSON.stringify(confirmation.value.err));
      process.exit(1);
    }

    console.log('Transaction confirmed successfully!');
    console.log(`View on Solscan: https://solscan.io/tx/${signature}`);

  } catch (error) {
    console.error('Error:', error.message);

    // Provide helpful error messages
    if (error.message.includes('ENOENT')) {
      console.error('Keypair file not found. Check the path and try again.');
    } else if (error.message.includes('Unexpected token')) {
      console.error('Invalid keypair file format. Ensure it contains a JSON array of bytes.');
    } else if (error.message.includes('insufficient funds')) {
      console.error('Insufficient SOL for transaction fees. Add more SOL to your wallet.');
    } else if (error.message.includes('blockhash not found')) {
      console.error('Transaction expired. Please get a fresh quote and try again.');
    }

    process.exit(1);
  }
}

main();
