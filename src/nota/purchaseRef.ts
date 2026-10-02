import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { encodeAbiParameters, keccak256, bytesToHex, type Address, type Hex } from 'viem';

/** Domain string from NotaReceiptStore.PURCHASE_REF_HASH_DOMAIN. */
const PURCHASE_REF_HASH_DOMAIN = 'nota.purchaseRef.receipt.v1';
const MAX_RAW_PURCHASE_REF_LENGTH = 128;

/**
 * The off-chain entitlement bundle. `purchaseRefNonce` is the secret: it must never be logged,
 * returned in a response, or placed in calldata (including eth_call). Only `purchaseRef`, the
 * hash, ever leaves this process.
 */
export interface PurchaseRefBundle {
  rawPurchaseRef: string;
  purchaseRefNonce: Hex;
  purchaseRef: Hex;
}

export interface PurchaseRefScope {
  chainId: number;
  settlementToken: Address;
  seller: Address;
}

/**
 * Local mirror of NotaReceiptStore.hashPurchaseRef:
 *   keccak256(abi.encode(domain, block.chainid, SETTLEMENT_TOKEN, seller, rawPurchaseRef, purchaseRefNonce))
 * Computed here rather than through the view function so the nonce never reaches an RPC
 * provider. The seller checks it against the contract at startup with a throwaway bundle.
 */
export function hashPurchaseRef(scope: PurchaseRefScope, rawPurchaseRef: string, purchaseRefNonce: Hex): Hex {
  const rawLength = Buffer.byteLength(rawPurchaseRef, 'utf8');
  if (rawLength === 0 || rawLength > MAX_RAW_PURCHASE_REF_LENGTH) {
    throw new Error(`rawPurchaseRef must be 1..${MAX_RAW_PURCHASE_REF_LENGTH} bytes`);
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'string' },
        { type: 'bytes32' },
      ],
      [PURCHASE_REF_HASH_DOMAIN, BigInt(scope.chainId), scope.settlementToken, scope.seller, rawPurchaseRef, purchaseRefNonce],
    ),
  );
}

/**
 * A fresh bundle per paid request. The raw ref follows the contracts' recommended
 * `<namespace>_<context>_<random>` form with a 128-bit random suffix; the nonce is 32 CSPRNG bytes.
 */
export function newPurchaseRef(scope: PurchaseRefScope): PurchaseRefBundle {
  const rawPurchaseRef = `nota_x402-analyze_${randomBytes(16).toString('hex')}`;
  const purchaseRefNonce = bytesToHex(randomBytes(32));
  return { rawPurchaseRef, purchaseRefNonce, purchaseRef: hashPurchaseRef(scope, rawPurchaseRef, purchaseRefNonce) };
}

/**
 * Where the seller keeps `(rawPurchaseRef, purchaseRefNonce)` for a future redemption flow.
 * Append-only JSON lines, file mode 0600, under a gitignored directory. Nothing here logs the
 * secret values; a failure reports only that the write failed.
 */
export const PURCHASE_REF_STORE_PATH = path.resolve('.nota', 'purchase-refs.jsonl');

export async function keepPurchaseRef(bundle: PurchaseRefBundle, listingId: bigint): Promise<void> {
  await mkdir(path.dirname(PURCHASE_REF_STORE_PATH), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({
    purchaseRef: bundle.purchaseRef,
    rawPurchaseRef: bundle.rawPurchaseRef,
    purchaseRefNonce: bundle.purchaseRefNonce,
    listingId: listingId.toString(),
    createdAt: new Date().toISOString(),
  });
  await appendFile(PURCHASE_REF_STORE_PATH, `${line}\n`, { mode: 0o600 });
}
