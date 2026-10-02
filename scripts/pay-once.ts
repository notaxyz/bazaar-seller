import 'dotenv/config';
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import { readNotaHeaders, saveReceivedBytes } from '../src/nota/buyer.js';

/**
 * Pays for one URL directly, like any x402 buyer would. Used to make the first
 * settlement that gets this service indexed in the facilitator's bazaar catalog.
 *   npm run pay -- "http://localhost:3100/analyze?address=0x..."
 */
const url = process.argv[2] || `http://localhost:${process.env.PORT || 3100}/analyze?address=0xaf88d065e77c8cC2239327C5EDb3A432268e5831`;
const network = process.env.NETWORK || 'eip155:421614';
const buyerKey = process.env.BUYER_PRIVATE_KEY;
if (!buyerKey) {
  console.error('BUYER_PRIVATE_KEY must be set to a wallet funded with test USDC');
  process.exit(1);
}

const account = privateKeyToAccount(buyerKey as `0x${string}`);
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: network as `${string}:${string}`, client: new ExactEvmScheme(account) }],
});

console.log(`paying for ${url} as ${account.address}`);
const started = Date.now();
const response = await fetchWithPayment(url);
console.log(`status ${response.status} in ${Date.now() - started}ms`);
// Keep the exact bytes: the seller's attestation commits to them, not to any re-serialization.
const bytes = new Uint8Array(await response.arrayBuffer());
const body = JSON.parse(new TextDecoder().decode(bytes)) as any;
const paymentResponse = response.headers.get('PAYMENT-RESPONSE');
if (paymentResponse) {
  console.log('settlement:', JSON.stringify(decodePaymentResponseHeader(paymentResponse), null, 2));
}
const nota = readNotaHeaders(response.headers);
if (nota.purchaseRef) {
  const saved = await saveReceivedBytes(nota.purchaseRef, bytes);
  console.log(`nota: purchaseRef=${nota.purchaseRef} store=${nota.receiptStore} chainId=${nota.chainId}`);
  console.log(`nota: response body saved byte-for-byte to ${saved}; once the attestation lands:`);
  console.log(`  npm run verify -- ${nota.purchaseRef} ${saved}`);
} else if (response.ok) {
  console.log('nota: no purchaseRef header; this response will not be attested');
}
console.log(`analysis: ${body.address} isContract=${body.isContract} proxy=${body.proxy?.pattern ?? 'no'} flags=${body.riskFlags?.length} undetermined=${body.undetermined?.length}`);
for (const flag of body.riskFlags ?? []) console.log(`  [${flag.severity}] ${flag.code}: ${flag.evidence}`);
