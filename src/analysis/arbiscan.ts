import { analysisConfig } from '../config.js';

/**
 * Thin client for the Etherscan V2 API scoped to Arbitrum One (chainid 42161).
 * Arbiscan's own V1 endpoint is deprecated and redirects here.
 * Calls are serialised with a small gap to stay under the free tier's 5 req/s.
 */

const BASE_URL = 'https://api.etherscan.io/v2/api';
const CHAIN_ID = '42161';
const MIN_GAP_MS = 220;
const TIMEOUT_MS = 12000;

export class ArbiscanError extends Error {
  constructor(message: string, public readonly retryable = false) {
    super(message);
    this.name = 'ArbiscanError';
  }
}

export interface SourceCodeResult {
  SourceCode: string;
  ABI: string;
  ContractName: string;
  CompilerVersion: string;
  OptimizationUsed: string;
  LicenseType: string;
  Proxy: string;
  Implementation: string;
}

export interface ContractCreationResult {
  contractAddress: string;
  contractCreator: string;
  txHash: string;
  blockNumber?: string;
  timestamp?: string;
}

export interface TxListItem {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  input: string;
  isError: string;
  methodId?: string;
  functionName?: string;
}

// Etherscan keys are 34 alphanumeric characters; anything else (empty, the .env placeholder) is treated as unset
// so we never burn the "too many invalid api key attempts" budget on a misconfigured key.
export function isArbiscanConfigured(): boolean {
  return /^[A-Za-z0-9]{20,64}$/.test(analysisConfig.arbiscanApiKey) && analysisConfig.arbiscanApiKey !== 'PASTE_KEY_HERE';
}

let queue: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(params: Record<string, string>, emptyOnNoRecords = false): Promise<T> {
  if (!isArbiscanConfigured()) {
    throw new ArbiscanError('ARBISCAN_API_KEY is not configured');
  }

  const run = async (): Promise<T> => {
    const url = new URL(BASE_URL);
    url.searchParams.set('chainid', CHAIN_ID);
    url.searchParams.set('apikey', analysisConfig.arbiscanApiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      throw new ArbiscanError(`Arbiscan HTTP ${response.status}`, response.status >= 500 || response.status === 429);
    }
    const body = (await response.json()) as { status: string; message: string; result: unknown };

    if (body.status !== '1') {
      const detail = typeof body.result === 'string' ? body.result : body.message;
      if (emptyOnNoRecords && /no (transactions|records) found/i.test(`${body.message} ${detail}`)) {
        return [] as unknown as T;
      }
      throw new ArbiscanError(`Arbiscan: ${detail}`, /rate limit/i.test(detail));
    }
    return body.result as T;
  };

  const result = queue.then(run, run);
  queue = result.then(() => sleep(MIN_GAP_MS), () => sleep(MIN_GAP_MS));
  return result;
}

export async function getSourceCode(address: string): Promise<SourceCodeResult | null> {
  const result = await request<SourceCodeResult[]>({ module: 'contract', action: 'getsourcecode', address });
  return result[0] ?? null;
}

export async function getContractCreation(address: string): Promise<ContractCreationResult | null> {
  try {
    const result = await request<ContractCreationResult[]>({
      module: 'contract',
      action: 'getcontractcreation',
      contractaddresses: address,
    });
    return result[0] ?? null;
  } catch (error) {
    // Etherscan answers "No data found" for contracts it has not indexed the creation of
    if (error instanceof ArbiscanError && /no data found/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

/** Most recent `limit` transactions sent to or from the address, newest first. */
export async function getRecentTransactions(address: string, limit = 100): Promise<TxListItem[]> {
  return request<TxListItem[]>(
    {
      module: 'account',
      action: 'txlist',
      address,
      startblock: '0',
      endblock: '999999999',
      page: '1',
      offset: String(limit),
      sort: 'desc',
    },
    true
  );
}

/** True when getsourcecode returned a verified entry (empty SourceCode means unverified). */
export function isVerified(source: SourceCodeResult | null): boolean {
  return !!source && typeof source.SourceCode === 'string' && source.SourceCode.trim().length > 0;
}
