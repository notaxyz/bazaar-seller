import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

// CAIP-2 network identifier, e.g. eip155:421614
type Network = `${string}:${string}`;

function caip2(name: string, fallback: Network): Network {
  const value = process.env[name] || fallback;
  if (!/^[a-z0-9-]+:[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${name} must be a CAIP-2 network id like eip155:421614, got "${value}"`);
  }
  return value as Network;
}

/**
 * Configuration the paid resource server needs. Validated eagerly on import: src/index.ts
 * cannot usefully start without a facilitator and a merchant key. Only src/index.ts imports
 * this, so nothing on the analyzer path is affected by these checks.
 */
export const paymentConfig = {
  port: parseInt(process.env.PORT || '3100', 10),
  facilitatorUrl: required('FACILITATOR_URL'),
  merchantApiKey: required('MERCHANT_API_KEY'),
  network: caip2('NETWORK', 'eip155:421614'),
  priceUsd: process.env.PRICE_USD || '0.25',
};
