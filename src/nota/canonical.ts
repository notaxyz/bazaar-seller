import canonicalize from 'canonicalize';
import { keccak256, toBytes, type Hex } from 'viem';

/**
 * JCS (RFC 8785) serialization of a JSON value. This string is the response body: the seller
 * serializes exactly once, sends this string, and hashes this same string, so the committed
 * bytes and the delivered bytes cannot diverge.
 */
export function canonicalJson(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) {
    throw new Error('value has no JSON representation');
  }
  return serialized;
}

/**
 * keccak256 over bytes exactly as given. A string is taken as its UTF-8 encoding, which is how
 * Express writes a string body. Never parse and re-serialize before calling this: that would
 * hash the caller's serializer, not the bytes that were committed to.
 */
export function metadataHashOf(bytes: string | Uint8Array): Hex {
  return keccak256(typeof bytes === 'string' ? toBytes(bytes) : bytes);
}

/** Whether `bytes` are already the JCS form of the JSON they encode. Diagnostic only. */
export function isCanonicalJson(bytes: Uint8Array): boolean {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  try {
    return canonicalJson(JSON.parse(text)) === text;
  } catch {
    return false;
  }
}
