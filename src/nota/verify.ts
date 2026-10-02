import { getAbiItem, zeroHash, type Address, type Hex, type PublicClient } from 'viem';
import { notaReceiptStoreAbi } from './abi.js';
import { isCanonicalJson, metadataHashOf } from './canonical.js';
import { notaDeployment } from './deployment.js';

const receiptAttested = getAbiItem({ abi: notaReceiptStoreAbi, name: 'ReceiptAttested' });

export interface Attestation {
  receiptId: bigint;
  seller: Address;
  buyer: Address;
  listingId: bigint;
  purchaseRef: Hex;
  metadataHash: Hex;
  agentId: Hex;
  paymentRef: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
}

export type StepStatus = 'pass' | 'fail' | 'skipped' | 'info';

export interface StepResult {
  step: number;
  title: string;
  status: StepStatus;
  detail: string[];
}

export interface VerifyInput {
  client: PublicClient;
  purchaseRef: Hex;
  expectedSeller: Address;
  /** The bytes exactly as received from the seller. Never re-serialized. */
  receivedBytes: Uint8Array;
  /** If the buyer expects a specific listing. */
  expectedListingId?: bigint;
  /** What the seller's response headers claimed, compared against the deployment record. */
  claimed?: { receiptStore?: string; chainId?: string };
}

export interface VerifyResult {
  pass: boolean;
  steps: StepResult[];
  attestation?: Attestation;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Plain eth_getLogs for ReceiptAttested, filtered to the store address from the deployment
 * record and to the indexed purchaseRef topic. No indexer. If the provider rejects the block
 * range, the range is split and retried.
 */
export async function findAttestations(client: PublicClient, purchaseRef: Hex): Promise<Attestation[]> {
  const latest = await client.getBlockNumber();
  const found: Attestation[] = [];
  const scan = async (fromBlock: bigint, toBlock: bigint): Promise<void> => {
    try {
      const logs = await client.getLogs({
        address: notaDeployment.receiptStore,
        event: receiptAttested,
        args: { purchaseRef },
        fromBlock,
        toBlock,
        strict: true,
      });
      for (const log of logs) {
        // The RPC filtered on address already; checking again costs nothing.
        if (!same(log.address, notaDeployment.receiptStore)) continue;
        found.push({ ...log.args, blockNumber: log.blockNumber, transactionHash: log.transactionHash });
      }
    } catch (error) {
      if (toBlock - fromBlock < 10_000n) throw error;
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      await scan(fromBlock, mid);
      await scan(mid + 1n, toBlock);
    }
  };
  await scan(notaDeployment.receiptStoreDeployBlock, latest);
  return found;
}

/**
 * The "Verifying a Receipt" procedure from notaxyz/contracts docs/receipt-mode-integration.md,
 * steps 0 through 5 in order. Overall pass requires steps 0-4; step 5 only reports paymentRef.
 */
export async function verifyReceipt(input: VerifyInput): Promise<VerifyResult> {
  const steps: StepResult[] = [];
  const add = (step: number, title: string, status: StepStatus, detail: string[]) => {
    steps.push({ step, title, status, detail });
    return status;
  };
  const skipRest = (from: number, why: string) => {
    const titles: Record<number, string> = {
      1: 'ReceiptAttested log exists for purchaseRef',
      2: 'seller is the expected seller',
      3: 'listingId belongs to that seller',
      4: 'metadataHash matches the bytes received',
      5: 'paymentRef',
    };
    for (let step = from; step <= 5; step++) add(step, titles[step]!, 'skipped', [why]);
  };

  // 0. Only logs from the store in the deployment record count.
  const chainId = await input.client.getChainId();
  const zeroDetail = [
    `store ${notaDeployment.receiptStore} on chain ${notaDeployment.chainId}, from ${notaDeployment.record}`,
    `RPC chain id: ${chainId}`,
  ];
  let zeroOk = chainId === notaDeployment.chainId;
  if (!zeroOk) zeroDetail.push(`expected chain id ${notaDeployment.chainId}`);
  if (input.claimed?.receiptStore && !same(input.claimed.receiptStore, notaDeployment.receiptStore)) {
    zeroOk = false;
    zeroDetail.push(`seller header names store ${input.claimed.receiptStore}; expected ${notaDeployment.receiptStore}. Logs from any other address are not receipts`);
  }
  if (input.claimed?.chainId && input.claimed.chainId !== String(notaDeployment.chainId)) {
    zeroOk = false;
    zeroDetail.push(`seller header names chain ${input.claimed.chainId}; expected ${notaDeployment.chainId}`);
  }
  if (add(0, 'logs filtered to the deployment-record store', zeroOk ? 'pass' : 'fail', zeroDetail) === 'fail') {
    skipRest(1, 'step 0 failed; every later check would be meaningless');
    return { pass: false, steps };
  }

  // 1. Exactly one ReceiptAttested for this purchaseRef. The ref is single-use across the registry.
  const attestations = await findAttestations(input.client, input.purchaseRef);
  if (attestations.length !== 1) {
    add(1, 'ReceiptAttested log exists for purchaseRef', 'fail', [
      attestations.length === 0
        ? `no ReceiptAttested from ${notaDeployment.receiptStore} with purchaseRef ${input.purchaseRef}`
        : `expected exactly one log, found ${attestations.length}`,
    ]);
    skipRest(2, 'no single attestation to check');
    return { pass: false, steps };
  }
  const attestation = attestations[0]!;
  add(1, 'ReceiptAttested log exists for purchaseRef', 'pass', [
    `receiptId ${attestation.receiptId} in block ${attestation.blockNumber}, tx ${attestation.transactionHash}`,
  ]);

  // 2. Seller.
  const sellerOk = same(attestation.seller, input.expectedSeller);
  add(2, 'seller is the expected seller', sellerOk ? 'pass' : 'fail', [
    `log seller ${attestation.seller}`,
    ...(sellerOk ? [] : [`expected ${input.expectedSeller}`]),
  ]);

  // 3. Listing ownership, read back from the same store.
  const listingDetail = [`listingId ${attestation.listingId}`];
  let listingOk = true;
  try {
    const listing = await input.client.readContract({
      address: notaDeployment.receiptStore,
      abi: notaReceiptStoreAbi,
      functionName: 'getListing',
      args: [attestation.listingId],
    });
    listingDetail.push(`getListing(${attestation.listingId}).seller = ${listing.seller}`);
    if (!same(listing.seller, input.expectedSeller)) {
      listingOk = false;
      listingDetail.push(`expected ${input.expectedSeller}`);
    }
  } catch (error: any) {
    listingOk = false;
    listingDetail.push(`getListing(${attestation.listingId}) failed: ${error?.shortMessage ?? error?.message}`);
  }
  if (input.expectedListingId !== undefined && attestation.listingId !== input.expectedListingId) {
    listingOk = false;
    listingDetail.push(`expected listingId ${input.expectedListingId}`);
  }
  add(3, 'listingId belongs to that seller', listingOk ? 'pass' : 'fail', listingDetail);

  // 4. The commitment, over the bytes exactly as received.
  const receivedHash = metadataHashOf(input.receivedBytes);
  const hashOk = receivedHash === attestation.metadataHash;
  const hashDetail = [`on-chain metadataHash   ${attestation.metadataHash}`, `keccak256(received bytes) ${receivedHash}  (${input.receivedBytes.length} bytes)`];
  if (!hashOk) {
    hashDetail.push(
      isCanonicalJson(input.receivedBytes)
        ? 'the bytes are canonical JSON but not the bytes the seller committed to'
        : 'the bytes are not JCS-canonical JSON: altered, re-serialized, pretty-printed, or given a trailing newline after receipt',
    );
  }
  add(4, 'metadataHash matches the bytes received', hashOk ? 'pass' : 'fail', hashDetail);

  const pass = steps.every((step) => step.status === 'pass');

  // 5. paymentRef: reported last, never a key. Followed only once everything above passed.
  const paymentDetail = [`paymentRef ${attestation.paymentRef}`, 'not unique and never a lookup key; seller-chosen, not evidence of payment'];
  if (!pass) {
    paymentDetail.push('not followed: an earlier step failed');
  } else if (attestation.paymentRef === zeroHash) {
    paymentDetail.push('unspecified (zero)');
  } else {
    try {
      const receipt = await input.client.getTransactionReceipt({ hash: attestation.paymentRef });
      paymentDetail.push(`followed on chain ${chainId}: tx status ${receipt.status}, block ${receipt.blockNumber}, from ${receipt.from}`);
    } catch {
      paymentDetail.push(`no transaction ${attestation.paymentRef} found on chain ${chainId}`);
    }
  }
  add(5, 'paymentRef', 'info', paymentDetail);

  return { pass, steps, attestation };
}

export function printVerifyResult(result: VerifyResult, log: (line: string) => void = console.log): void {
  const mark: Record<StepStatus, string> = { pass: 'PASS', fail: 'FAIL', skipped: 'SKIP', info: 'INFO' };
  for (const step of result.steps) {
    log(`  [${mark[step.status]}] ${step.step}. ${step.title}`);
    for (const line of step.detail) log(`         ${line}`);
  }
  const failed = result.steps.filter((step) => step.status === 'fail');
  log(
    result.pass
      ? '  RESULT: PASS. The seller committed on-chain to exactly these bytes.'
      : `  RESULT: FAIL at step ${failed.map((step) => step.step).join(', ')}`,
  );
}
