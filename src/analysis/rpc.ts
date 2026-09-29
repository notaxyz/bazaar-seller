import {
  createPublicClient,
  http,
  getAddress,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { arbitrum } from 'viem/chains';
import { analysisConfig } from '../config.js';

/** Read-only Arbitrum One client. All analysis data on chain comes through here. */
export const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(analysisConfig.arbitrumRpcUrl, { timeout: 15000, retryCount: 2 }),
});

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// EIP-1967 storage slots and EIP-1822 (UUPS "PROXIABLE") slot
export const SLOT_EIP1967_IMPLEMENTATION: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const SLOT_EIP1967_ADMIN: Hex = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
export const SLOT_EIP1967_BEACON: Hex = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
export const SLOT_EIP1822_LOGIC: Hex = '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7';
// Pre-EIP-1967 ZeppelinOS AdminUpgradeabilityProxy slots (used by Circle's FiatTokenProxy among others)
export const SLOT_ZOS_IMPLEMENTATION: Hex = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
export const SLOT_ZOS_ADMIN: Hex = '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b';

// EIP-1167 minimal proxy runtime bytecode with the 20-byte target in the middle
const MINIMAL_PROXY_PATTERN = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;

const COMMON_ABI = parseAbi([
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function paused() view returns (bool)',
  'function implementation() view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

const APPROVAL_EVENT = parseAbiItem('event Approval(address indexed owner, address indexed spender, uint256 value)');

export type ApprovalLog = Log<bigint, number, false, typeof APPROVAL_EVENT, true>;

export function normalizeAddress(value: string): Address {
  return getAddress(value);
}

export async function getBytecode(address: Address): Promise<Hex | null> {
  const code = await publicClient.getCode({ address });
  return code && code !== '0x' ? code : null;
}

/** contract | eoa | unknown, where unknown means the RPC call failed */
export async function accountKind(address: string): Promise<'contract' | 'eoa' | 'unknown'> {
  try {
    const code = await getBytecode(normalizeAddress(address));
    return code ? 'contract' : 'eoa';
  } catch {
    return 'unknown';
  }
}

export function slotToAddress(slotValue: Hex | undefined): Address | null {
  if (!slotValue || /^0x0*$/.test(slotValue)) return null;
  const padded = slotValue.slice(2).padStart(64, '0');
  const candidate = `0x${padded.slice(24)}`;
  if (/^0x0{40}$/.test(candidate)) return null;
  try {
    return getAddress(candidate);
  } catch {
    return null;
  }
}

export async function readSlot(address: Address, slot: Hex): Promise<Hex | undefined> {
  return publicClient.getStorageAt({ address, slot });
}

/** Call a view function; null when it reverts or does not exist. */
async function tryRead<T>(address: Address, functionName: string): Promise<T | null> {
  try {
    return (await publicClient.readContract({
      address,
      abi: COMMON_ABI,
      functionName: functionName as any,
    })) as T;
  } catch {
    return null;
  }
}

export function minimalProxyTarget(code: Hex): Address | null {
  const match = MINIMAL_PROXY_PATTERN.exec(code);
  return match ? getAddress(`0x${match[1]}`) : null;
}

export interface ProxySlots {
  eip1967Implementation: Address | null;
  eip1967Admin: Address | null;
  eip1967Beacon: Address | null;
  eip1822Logic: Address | null;
  zosImplementation: Address | null;
  zosAdmin: Address | null;
  implementationCall: Address | null;
}

export async function readProxySlots(address: Address): Promise<ProxySlots> {
  const [impl, admin, beacon, logic, zosImpl, zosAdmin, implCall] = await Promise.all([
    readSlot(address, SLOT_EIP1967_IMPLEMENTATION),
    readSlot(address, SLOT_EIP1967_ADMIN),
    readSlot(address, SLOT_EIP1967_BEACON),
    readSlot(address, SLOT_EIP1822_LOGIC),
    readSlot(address, SLOT_ZOS_IMPLEMENTATION),
    readSlot(address, SLOT_ZOS_ADMIN),
    tryRead<Address>(address, 'implementation'),
  ]);
  return {
    eip1967Implementation: slotToAddress(impl),
    eip1967Admin: slotToAddress(admin),
    eip1967Beacon: slotToAddress(beacon),
    eip1822Logic: slotToAddress(logic),
    zosImplementation: slotToAddress(zosImpl),
    zosAdmin: slotToAddress(zosAdmin),
    implementationCall: implCall && implCall !== ZERO_ADDRESS ? getAddress(implCall) : null,
  };
}

export interface OwnershipReads {
  owner: Address | null;
  pendingOwner: Address | null;
  /** null when the contract has no paused() view */
  paused: boolean | null;
}

export async function readOwnership(address: Address): Promise<OwnershipReads> {
  const [owner, getOwner, pendingOwner, paused] = await Promise.all([
    tryRead<Address>(address, 'owner'),
    tryRead<Address>(address, 'getOwner'),
    tryRead<Address>(address, 'pendingOwner'),
    tryRead<boolean>(address, 'paused'),
  ]);
  const resolvedOwner = owner ?? getOwner;
  return {
    owner: resolvedOwner ? getAddress(resolvedOwner) : null,
    pendingOwner: pendingOwner && pendingOwner !== ZERO_ADDRESS ? getAddress(pendingOwner) : null,
    paused,
  };
}

export interface TokenReads {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
  balanceOfWorks: boolean;
}

export async function readTokenMetadata(address: Address): Promise<TokenReads> {
  const [name, symbol, decimals, totalSupply, balance] = await Promise.all([
    tryRead<string>(address, 'name'),
    tryRead<string>(address, 'symbol'),
    tryRead<number>(address, 'decimals'),
    tryRead<bigint>(address, 'totalSupply'),
    (async () => {
      try {
        await publicClient.readContract({ address, abi: COMMON_ABI, functionName: 'balanceOf', args: [ZERO_ADDRESS] });
        return true;
      } catch {
        return false;
      }
    })(),
  ]);
  return { name, symbol, decimals, totalSupply, balanceOfWorks: balance };
}

export interface LogScan<T> {
  logs: T[];
  /** Inclusive range actually scanned; `scannedBlocks` is 0 when every chunk failed */
  fromBlock: bigint;
  toBlock: bigint;
  scannedBlocks: bigint;
  /** Set when the provider refused part of the window (too many results / range too wide) */
  truncatedReason?: string;
}

/**
 * Scan a block window in chunks. Public RPCs cap getLogs by range and result size,
 * so a chunk that fails is retried at half size once and then reported as truncated.
 */
export async function scanLogs<T>(
  fetchChunk: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  toBlock: bigint,
  totalBlocks: bigint,
  chunkSize: bigint,
  budgetMs: number
): Promise<LogScan<T>> {
  const started = Date.now();
  const target = toBlock - totalBlocks + 1n;
  const logs: T[] = [];
  let cursor = toBlock;
  let lowest = toBlock + 1n;
  let size = chunkSize;
  let truncatedReason: string | undefined;

  while (cursor >= target) {
    if (Date.now() - started > budgetMs) {
      truncatedReason = 'time budget exhausted';
      break;
    }
    const from = cursor - size + 1n > target ? cursor - size + 1n : target;
    try {
      logs.push(...(await fetchChunk(from, cursor)));
      lowest = from;
      cursor = from - 1n;
    } catch (error: any) {
      // Shrink and retry the same head; give up once chunks get tiny
      size = size / 2n;
      if (size < 50n) {
        truncatedReason = `provider rejected log query: ${error.shortMessage || error.message}`;
        break;
      }
    }
  }

  const scanned = lowest <= toBlock ? toBlock - lowest + 1n : 0n;
  return { logs, fromBlock: scanned > 0n ? lowest : toBlock, toBlock, scannedBlocks: scanned, truncatedReason };
}

export function fetchApprovalChunk(address: Address) {
  return (fromBlock: bigint, toBlock: bigint) =>
    publicClient.getLogs({ address, event: APPROVAL_EVENT, fromBlock, toBlock }) as Promise<ApprovalLog[]>;
}

export function fetchAnyLogChunk(address: Address) {
  return (fromBlock: bigint, toBlock: bigint) => publicClient.getLogs({ address, fromBlock, toBlock });
}

export async function getBlockTimestamp(blockNumber: bigint): Promise<Date | null> {
  try {
    const block = await publicClient.getBlock({ blockNumber });
    return new Date(Number(block.timestamp) * 1000);
  } catch {
    return null;
  }
}
