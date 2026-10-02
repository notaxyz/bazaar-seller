import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { isHex } from 'viem';
import { verifyReceipt, printVerifyResult } from '../src/nota/verify.js';
import { notaDeployment } from '../src/nota/deployment.js';
import { expectedSeller, notaPublicClient } from '../src/nota/buyer.js';

/**
 * Buyer-side verification of a Nota attestation, from chain data alone:
 *   npm run verify -- <purchaseRef> [analysis.json] [--seller 0x...] [--listing <id>]
 * The analysis bytes come from the file argument, or stdin when it is omitted or "-". They are
 * hashed exactly as given: save the response body byte-for-byte, do not pretty-print it.
 */

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('usage: npm run verify -- <purchaseRef> [analysis.json | -] [--seller 0x...] [--listing <id>]');
  process.exit(2);
}

const positional: string[] = [];
const flags: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === '--seller' || arg === '--listing') {
    const value = argv[++i];
    if (!value) usage(`${arg} needs a value`);
    flags[arg.slice(2)] = value;
  } else {
    positional.push(arg);
  }
}

const [purchaseRef, file] = positional;
if (!purchaseRef || !isHex(purchaseRef) || purchaseRef.length !== 66) usage('purchaseRef must be a 0x-prefixed 32-byte hex value');
if (flags.listing !== undefined && !/^[1-9][0-9]*$/.test(flags.listing)) usage('--listing must be a positive integer');

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

let seller;
try {
  seller = expectedSeller(flags.seller);
} catch (error: any) {
  usage(error.message);
}

const receivedBytes = !file || file === '-' ? await readStdin() : await readFile(file);

console.log(`Verifying purchaseRef ${purchaseRef}`);
console.log(`  expected seller ${seller}${flags.listing ? `, listing ${flags.listing}` : ''}`);
console.log(`  analysis bytes from ${!file || file === '-' ? 'stdin' : file}`);
console.log(`  store ${notaDeployment.receiptStore} (${notaDeployment.record})`);

const result = await verifyReceipt({
  client: notaPublicClient(),
  purchaseRef,
  expectedSeller: seller,
  receivedBytes,
  expectedListingId: flags.listing ? BigInt(flags.listing) : undefined,
});
printVerifyResult(result);
process.exit(result.pass ? 0 : 1);
