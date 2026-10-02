import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isHex,
  parseEventLogs,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Chain,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { randomBytes } from 'node:crypto';
import type { SettleResultContext } from '@x402/core/server';
import { notaReceiptStoreAbi } from './abi.js';
import { metadataHashOf } from './canonical.js';
import { hashPurchaseRef, keepPurchaseRef, newPurchaseRef, type PurchaseRefScope } from './purchaseRef.js';

/** Response headers a buyer uses to find the attestation later. Set before the body is sent. */
export const NOTA_HEADERS = {
  purchaseRef: 'X-Nota-Purchase-Ref',
  receiptStore: 'X-Nota-Receipt-Store',
  chainId: 'X-Nota-Chain-Id',
} as const;

export interface NotaSellerConfig {
  rpcUrl: string;
  receiptStore: Address;
  purchaseRefRegistry: Address;
  listingId: bigint;
  sellerPrivateKey: Hex;
}

export interface AttestReceiptArgs {
  listingId: bigint;
  buyer: Address;
  purchaseRef: Hex;
  metadataHash: Hex;
  agentId: Hex;
  paymentRef: Hex;
}

interface PendingReceipt {
  metadataHash: Hex;
  createdAt: number;
}

// A response whose settlement never completes leaves its entry behind; drop those eventually.
const PENDING_TTL_MS = 15 * 60 * 1000;

const isBytes32 = (value: unknown): value is Hex => typeof value === 'string' && isHex(value) && value.length === 66;

function reason(error: any): string {
  // Name the store's custom error (ListingInactive, PurchaseRefAlreadyUsed, ...) when there is one.
  const reverted = typeof error?.walk === 'function' ? error.walk((e: any) => e?.name === 'ContractFunctionRevertedError') : undefined;
  const errorName = reverted?.data?.errorName;
  const message = error?.shortMessage || error?.message || String(error);
  return errorName ? `${message} ${errorName}` : message;
}

/**
 * The seller side of Nota attestation: a wallet on Arbitrum Sepolia for the listing's seller key,
 * a typed attestReceipt call, and the x402 afterSettle hook that drives it.
 */
export class NotaSeller {
  readonly account: Account & { address: Address };
  readonly chain = arbitrumSepolia;
  private readonly publicClient: PublicClient<Transport, Chain>;
  private readonly walletClient: WalletClient<Transport, Chain, Account>;
  private readonly pending = new Map<Hex, PendingReceipt>();
  // Attestations share one key, so they go out one at a time to keep nonces in order.
  private queue: Promise<unknown> = Promise.resolve();
  private scope?: PurchaseRefScope;

  constructor(private readonly config: NotaSellerConfig) {
    this.account = privateKeyToAccount(config.sellerPrivateKey);
    const transport = http(config.rpcUrl);
    this.publicClient = createPublicClient({ chain: this.chain, transport });
    this.walletClient = createWalletClient({ chain: this.chain, transport, account: this.account });
  }

  get listingId(): bigint {
    return this.config.listingId;
  }

  get receiptStore(): Address {
    return this.config.receiptStore;
  }

  /**
   * Refuses to start unless attestations can succeed: right chain, the store wired to the
   * configured registry, the listing existing, active, and owned by this key, and the local
   * purchaseRef hash agreeing with the contract's.
   */
  async checkStartup(): Promise<void> {
    const store = { address: this.config.receiptStore, abi: notaReceiptStoreAbi } as const;

    const chainId = await this.publicClient.getChainId();
    if (chainId !== this.chain.id) {
      throw new Error(`NOTA_RPC_URL is on chain ${chainId}, expected Arbitrum Sepolia (${this.chain.id})`);
    }

    const registry = await this.publicClient.readContract({ ...store, functionName: 'PURCHASE_REF_REGISTRY' });
    if (registry.toLowerCase() !== this.config.purchaseRefRegistry.toLowerCase()) {
      throw new Error(`Receipt store ${this.config.receiptStore} uses registry ${registry}, but NOTA_PURCHASE_REF_REGISTRY is ${this.config.purchaseRefRegistry}`);
    }

    const listing = await this.publicClient
      .readContract({ ...store, functionName: 'getListing', args: [this.config.listingId] })
      .catch((error) => {
        throw new Error(`Listing ${this.config.listingId} not readable on ${this.config.receiptStore}: ${reason(error)}`);
      });
    if (listing.seller.toLowerCase() !== this.account.address.toLowerCase()) {
      throw new Error(`Listing ${this.config.listingId} belongs to ${listing.seller}, but SELLER_PRIVATE_KEY is ${this.account.address}`);
    }
    if (!listing.active) {
      throw new Error(`Listing ${this.config.listingId} is inactive; attestReceipt would revert with ListingInactive`);
    }
    if (await this.publicClient.readContract({ ...store, functionName: 'purchasesPaused' })) {
      console.warn('[nota] receipt store has purchasesPaused set; attestReceipt will revert until it is cleared');
    }

    const settlementToken = await this.publicClient.readContract({ ...store, functionName: 'SETTLEMENT_TOKEN' });
    this.scope = { chainId, settlementToken, seller: this.account.address };

    // Prove the local purchaseRef hash matches the contract's. The bundle is throwaway and used
    // for nothing else, so sending it in an eth_call exposes no real nonce.
    const probeRaw = `nota_selfcheck_${randomBytes(16).toString('hex')}`;
    const probeNonce = `0x${randomBytes(32).toString('hex')}` as Hex;
    const onChain = await this.publicClient.readContract({
      ...store,
      functionName: 'hashPurchaseRef',
      args: [this.account.address, this.config.listingId, probeRaw, probeNonce],
    });
    const local = hashPurchaseRef(this.scope, probeRaw, probeNonce);
    if (onChain !== local) {
      throw new Error(`Local hashPurchaseRef ${local} disagrees with the contract's ${onChain}`);
    }
  }

  /**
   * Called with the exact string about to be sent as the paid response body. Mints the
   * purchaseRef, records the commitment for the afterSettle hook, persists the off-chain bundle,
   * and returns the headers to set before sending.
   */
  prepareReceipt(body: string): Record<string, string> {
    if (!this.scope) throw new Error('NotaSeller.checkStartup() has not completed');
    const bundle = newPurchaseRef(this.scope);
    const now = Date.now();
    for (const [ref, entry] of this.pending) {
      if (now - entry.createdAt > PENDING_TTL_MS) this.pending.delete(ref);
    }
    this.pending.set(bundle.purchaseRef, { metadataHash: metadataHashOf(body), createdAt: now });
    keepPurchaseRef(bundle, this.config.listingId).catch((error) => {
      // Never include the bundle in this message.
      console.warn(`[nota] could not persist the purchaseRef bundle for ${bundle.purchaseRef}: ${error?.code ?? 'write failed'}`);
    });
    return {
      [NOTA_HEADERS.purchaseRef]: bundle.purchaseRef,
      [NOTA_HEADERS.receiptStore]: this.config.receiptStore,
      [NOTA_HEADERS.chainId]: String(this.chain.id),
    };
  }

  /**
   * x402 afterSettle hook. @x402/express buffers the handler's response, settles, runs this,
   * and only then flushes the body, so this must not wait on the chain: it queues the
   * attestation and returns. It never throws; the buyer has paid and must get the response.
   */
  readonly onAfterSettle = async (context: SettleResultContext): Promise<void> => {
    try {
      if (context.phase !== 'after-handler' || !context.result.success) return;
      const transport = context.transportContext as
        | { responseBody?: Uint8Array; responseHeaders?: Record<string, string> }
        | undefined;
      const purchaseRef = transport?.responseHeaders?.[NOTA_HEADERS.purchaseRef.toLowerCase()] as Hex | undefined;
      if (!purchaseRef) return;

      const pending = this.pending.get(purchaseRef);
      this.pending.delete(purchaseRef);
      if (!pending) {
        console.warn(`[nota] settled ${purchaseRef} but no commitment was recorded for it; not attesting`);
        return;
      }
      // The committed hash came from the string the handler sent. Check it against the bytes
      // the middleware is about to flush, so an attestation can only ever cover what the buyer gets.
      if (!transport?.responseBody || metadataHashOf(transport.responseBody) !== pending.metadataHash) {
        console.warn(`[nota] delivered bytes for ${purchaseRef} do not match the committed hash; not attesting`);
        return;
      }

      const transaction = context.result.transaction;
      const paymentRef = isBytes32(transaction) ? transaction : zeroHash;
      if (paymentRef === zeroHash) {
        console.warn(`[nota] settle result for ${purchaseRef} carries no 32-byte transaction hash; paymentRef left unspecified`);
      }

      const authorization = (context.paymentPayload.payload as { authorization?: { from?: string } }).authorization;
      const payer = authorization?.from ?? context.result.payer;
      const buyer = payer && isAddress(payer) ? payer : zeroAddress;

      this.enqueue({
        listingId: this.config.listingId,
        buyer,
        purchaseRef,
        metadataHash: pending.metadataHash,
        agentId: zeroHash,
        paymentRef,
      });
    } catch (error) {
      console.warn(`[nota] attestation skipped: ${reason(error)}`);
    }
  };

  private enqueue(args: AttestReceiptArgs): void {
    const run = this.queue.then(() => this.attestReceipt(args));
    this.queue = run.then(
      ({ hash, receiptId, blockNumber, gasUsed }) =>
        console.log(
          `[nota] attested purchaseRef=${args.purchaseRef} receiptId=${receiptId} block=${blockNumber} gasUsed=${gasUsed} tx=${hash} ${this.chain.blockExplorers.default.url}/tx/${hash}`,
        ),
      (error) => console.warn(`[nota] attestReceipt failed for purchaseRef=${args.purchaseRef}: ${reason(error)}`),
    );
  }

  /** Typed attestReceipt: simulate (to surface revert reasons), send, wait for inclusion. */
  async attestReceipt(args: AttestReceiptArgs): Promise<{ hash: Hex; receiptId: bigint; blockNumber: bigint; gasUsed: bigint }> {
    const { request } = await this.publicClient.simulateContract({
      account: this.account,
      address: this.config.receiptStore,
      abi: notaReceiptStoreAbi,
      functionName: 'attestReceipt',
      args: [args.listingId, args.buyer, args.purchaseRef, args.metadataHash, args.agentId, args.paymentRef],
    });
    const hash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`attestReceipt transaction ${hash} reverted`);
    }
    const storeLogs = receipt.logs.filter((log) => log.address.toLowerCase() === this.config.receiptStore.toLowerCase());
    const [event] = parseEventLogs({ abi: notaReceiptStoreAbi, eventName: 'ReceiptAttested', logs: storeLogs });
    return { hash, receiptId: event?.args.receiptId ?? 0n, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  }
}
