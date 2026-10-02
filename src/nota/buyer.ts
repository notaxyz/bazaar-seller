import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPublicClient, http, isAddress, isHex, type Address, type Hex, type PublicClient } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { NOTA_HEADERS } from './seller.js';

/** Buyer-side helpers. Nothing here needs, or may touch, the seller's key. */

export function notaPublicClient(): PublicClient {
  return createPublicClient({ chain: arbitrumSepolia, transport: http(process.env.NOTA_RPC_URL || undefined) }) as PublicClient;
}

/**
 * The seller the buyer expects to have dealt with. It must come from the buyer's own
 * configuration, never from the seller's response: a seller could name anyone.
 */
export function expectedSeller(fromArgs?: string): Address {
  const value = fromArgs || process.env.NOTA_EXPECTED_SELLER;
  if (!value || !isAddress(value)) {
    throw new Error('Set NOTA_EXPECTED_SELLER (or pass --seller 0x...) to the seller address you expect to have sold to you');
  }
  return value;
}

export interface NotaResponseHeaders {
  purchaseRef?: Hex;
  receiptStore?: string;
  chainId?: string;
}

export function readNotaHeaders(headers: Headers): NotaResponseHeaders {
  const purchaseRef = headers.get(NOTA_HEADERS.purchaseRef) ?? undefined;
  return {
    purchaseRef: purchaseRef && isHex(purchaseRef) && purchaseRef.length === 66 ? purchaseRef : undefined,
    receiptStore: headers.get(NOTA_HEADERS.receiptStore) ?? undefined,
    chainId: headers.get(NOTA_HEADERS.chainId) ?? undefined,
  };
}

/** Saves the response body byte-for-byte so it can be verified later. */
export async function saveReceivedBytes(purchaseRef: Hex, bytes: Uint8Array): Promise<string> {
  const file = path.resolve('.nota', 'received', `${purchaseRef}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return path.relative(process.cwd(), file);
}
