import 'dotenv/config';

/**
 * Configuration the analyzer needs, and nothing more.
 *
 * This module deliberately performs no validation and throws on import for nothing: importing
 * any binding from a module runs the whole module, so putting the payment config's eager
 * `required()` checks here would make `npm run analyze` — the payment-free local path — fail
 * before it makes a single RPC call. The payment fields live in ./paymentConfig.js instead.
 */
export const analysisConfig = {
  arbitrumRpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
  arbiscanApiKey: process.env.ARBISCAN_API_KEY || '',
};
