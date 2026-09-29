import 'dotenv/config';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { withBazaar } from '@x402/extensions/bazaar';
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Plays the role of an agent that knows nothing about this service ahead of time:
 *   1. lists the facilitator's bazaar catalog
 *   2. finds an HTTP resource whose declared input takes an `address`
 *   3. builds the request from the declaration and pays for it
 */

const facilitatorUrl = process.env.FACILITATOR_URL || 'http://localhost:3002';
const buyerKey = process.env.BUYER_PRIVATE_KEY;
const targetAddress = process.argv[2];

if (!buyerKey) {
  console.error('BUYER_PRIVATE_KEY must be set to a wallet funded with test USDC');
  process.exit(1);
}

const facilitator = withBazaar(new HTTPFacilitatorClient({ url: facilitatorUrl }));

console.log(`1. GET ${facilitatorUrl}/discovery/resources?type=http`);
const catalog = await facilitator.extensions.bazaar.listResources({ type: 'http', limit: 50 });
console.log(`   ${catalog.items.length} of ${catalog.pagination.total} resources`);
for (const item of catalog.items) {
  console.log(`   - ${item.resource}  (${item.accepts[0]?.amount} ${item.accepts[0]?.network}, updated ${item.lastUpdated})`);
}

type BazaarInfo = { input?: { type?: string; method?: string; queryParams?: Record<string, unknown> } };
const takesAddress = (item: (typeof catalog.items)[number]): boolean => {
  const info = (item.extensions?.bazaar as { info?: BazaarInfo } | undefined)?.info;
  return info?.input?.type === 'http' && !!info.input.queryParams && 'address' in info.input.queryParams;
};

// A catalog with several rows may hold more than one address-taking service. Prefer this
// seller's own origin so the demo still shows *this* repo, and fall back to any match.
const sellerOrigin = process.env.SELLER_URL
  ? new URL(process.env.SELLER_URL).origin
  : `http://localhost:${process.env.PORT || '3100'}`;
const candidates = catalog.items.filter(takesAddress);
const service =
  candidates.find((item) => {
    try {
      return new URL(item.resource).origin === sellerOrigin;
    } catch {
      return false;
    }
  }) ?? candidates[0];
if (!service) {
  console.error('2. No HTTP resource with an `address` query parameter is listed. Has a paid call settled through the facilitator yet?');
  process.exit(1);
}
const info = (service.extensions!.bazaar as { info: BazaarInfo }).info;
console.log(`2. Found ${service.serviceName ?? service.resource}`);
console.log(`   ${service.description ?? ''}`);
console.log(`   declared input: ${info.input!.method} ${JSON.stringify(info.input!.queryParams)}`);

const url = new URL(service.resource);
for (const [key, value] of Object.entries(info.input!.queryParams!)) {
  url.searchParams.set(key, key === 'address' && targetAddress ? targetAddress : String(value));
}

const account = privateKeyToAccount(buyerKey as `0x${string}`);
const network = service.accepts[0]!.network;
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network, client: new ExactEvmScheme(account) }],
});

console.log(`3. ${info.input!.method} ${url} as ${account.address}`);
const response = await fetchWithPayment(url.toString());
console.log(`   status ${response.status}`);
const body = await response.json();

const paymentResponse = response.headers.get('PAYMENT-RESPONSE');
if (paymentResponse) {
  console.log('   settlement:', JSON.stringify(decodePaymentResponseHeader(paymentResponse), null, 2));
}
console.log('4. analysis:');
console.log(JSON.stringify(body, null, 2));
