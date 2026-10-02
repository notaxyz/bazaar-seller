import type { Address } from 'viem';

/**
 * The Nota deployment this seller attests against, copied from the deployment record
 * notaxyz/contracts deployments/arbitrum-sepolia-attest.json (the attestReceipt build).
 *
 * The buyer-side verifier filters logs to `receiptStore` from here, never from anything the
 * seller sent: any contract can emit a log with the same signature and topics, so a store
 * address taken from a response header would let a dishonest seller point the verifier at a
 * forgery.
 */
export const notaDeployment = {
  record: 'notaxyz/contracts deployments/arbitrum-sepolia-attest.json',
  network: 'arbitrum-sepolia',
  chainId: 421614,
  receiptStore: '0x6b13e2077c84e1326111acBbb618E028723e2EA2' as Address,
  receiptStoreDeployBlock: 314705695n,
  purchaseRefRegistry: '0x32aAeC7768adBBFD65C776b129616b8727d0c8bd' as Address,
  settlementToken: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' as Address,
  explorerUrl: 'https://sepolia.arbiscan.io',
} as const;
