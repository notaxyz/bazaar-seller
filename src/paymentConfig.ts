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

type Hex = `0x${string}`;

function address(name: string): Hex {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 20-byte hex address`);
  }
  return value as Hex;
}

function privateKey(name: string): Hex {
  const value = required(name);
  // Never echo the value back, not even in the error.
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex private key`);
  }
  return value as Hex;
}

function listingId(name: string): bigint {
  const value = required(name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer listing id, got "${value}"`);
  }
  return BigInt(value);
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
  // Nota attestation: after each settled call the seller commits on-chain to the exact bytes
  // it returned. The seller key signs attestReceipt and must be the listing's seller.
  nota: {
    rpcUrl: required('NOTA_RPC_URL'),
    receiptStore: address('NOTA_RECEIPT_STORE'),
    purchaseRefRegistry: address('NOTA_PURCHASE_REF_REGISTRY'),
    listingId: listingId('NOTA_LISTING_ID'),
    sellerPrivateKey: privateKey('SELLER_PRIVATE_KEY'),
  },
};
