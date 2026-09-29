import { formatUnits, type Abi, type Address } from 'viem';
import {
  ArbiscanError,
  getContractCreation,
  getRecentTransactions,
  getSourceCode,
  isArbiscanConfigured,
  isVerified,
  type SourceCodeResult,
  type TxListItem,
} from './arbiscan.js';
import { classifyPrivilegedFunctions, hasFunction, parseAbi, selectorMap } from './abi.js';
import {
  accountKind,
  fetchAnyLogChunk,
  fetchApprovalChunk,
  getBlockTimestamp,
  getBytecode,
  minimalProxyTarget,
  normalizeAddress,
  publicClient,
  readOwnership,
  readProxySlots,
  readTokenMetadata,
  scanLogs,
  ZERO_ADDRESS,
} from './rpc.js';
import type {
  ActivityInfo,
  ApprovalsInfo,
  ContractAnalysis,
  ControlInfo,
  PrivilegedAccount,
  ProxyInfo,
  RiskFlag,
  SourceInfo,
  TokenInfo,
} from './types.js';

export class AnalysisError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'AnalysisError';
  }
}

// Arbitrum One produces a block roughly every 250ms; 20k blocks is about 80 minutes.
// The official RPC serves 5k-block log ranges; the scanner halves the chunk if a provider refuses.
const LOG_WINDOW_BLOCKS = 20_000n;
const LOG_CHUNK_BLOCKS = 5_000n;
const LOG_BUDGET_MS = 6_000;
const UINT256_MAX = (1n << 256n) - 1n;
const UNLIMITED_THRESHOLD = 1n << 255n;
const TX_SAMPLE = 100;

type Undetermined = { field: string; reason: string };

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export async function analyzeContract(rawAddress: string): Promise<ContractAnalysis> {
  let address: Address;
  try {
    address = normalizeAddress(rawAddress);
  } catch {
    throw new AnalysisError('address must be a valid 20-byte hex address', 400);
  }

  const undetermined: Undetermined[] = [];
  const dataSources = new Set<string>();
  const analyzedAt = new Date().toISOString();

  let code;
  try {
    code = await getBytecode(address);
    dataSources.add(`rpc:${new URL(publicClient.transport.url ?? '').host || 'arbitrum-one'}`);
  } catch (error) {
    throw new AnalysisError(`Arbitrum RPC unavailable: ${describeError(error)}`, 502);
  }

  if (!code) {
    return notAContract(address, analyzedAt, [...dataSources]);
  }
  const bytecodeSize = (code.length - 2) / 2;

  // Independent reads, fired together
  const [slots, ownership, token, creation, source, txs, latestBlock] = await Promise.all([
    settle(readProxySlots(address)),
    settle(readOwnership(address)),
    settle(readTokenMetadata(address)),
    settle(isArbiscanConfigured() ? getContractCreation(address) : Promise.reject(new ArbiscanError('ARBISCAN_API_KEY is not configured'))),
    settle(isArbiscanConfigured() ? getSourceCode(address) : Promise.reject(new ArbiscanError('ARBISCAN_API_KEY is not configured'))),
    settle(isArbiscanConfigured() ? getRecentTransactions(address, TX_SAMPLE) : Promise.reject(new ArbiscanError('ARBISCAN_API_KEY is not configured'))),
    settle(publicClient.getBlockNumber()),
  ]);
  if (source.ok || creation.ok || txs.ok) dataSources.add('arbiscan (etherscan v2 api, chainid 42161)');

  // ---- Proxy ------------------------------------------------------------
  const proxy: ProxyInfo = { determined: false, isProxy: null, pattern: null, implementation: null, admin: null, beacon: null };
  const minimalTarget = minimalProxyTarget(code);
  if (slots.ok) {
    const s = slots.value;
    proxy.determined = true;
    proxy.admin = s.eip1967Admin;
    proxy.beacon = s.eip1967Beacon;
    if (s.eip1967Implementation) {
      proxy.isProxy = true; proxy.pattern = 'eip1967'; proxy.implementation = s.eip1967Implementation;
    } else if (s.eip1967Beacon) {
      proxy.isProxy = true; proxy.pattern = 'eip1967-beacon';
      // Beacon proxies resolve their implementation through the beacon's implementation()
      const viaBeacon = await settle(readProxySlots(s.eip1967Beacon));
      proxy.implementation = viaBeacon.ok ? viaBeacon.value.implementationCall : null;
      if (!proxy.implementation) undetermined.push({ field: 'proxy.implementation', reason: 'beacon did not answer implementation()' });
    } else if (s.eip1822Logic) {
      proxy.isProxy = true; proxy.pattern = 'eip1822'; proxy.implementation = s.eip1822Logic;
    } else if (s.zosImplementation) {
      proxy.isProxy = true; proxy.pattern = 'zeppelinos'; proxy.implementation = s.zosImplementation;
      proxy.admin = proxy.admin ?? s.zosAdmin;
    } else if (minimalTarget) {
      proxy.isProxy = true; proxy.pattern = 'eip1167-minimal'; proxy.implementation = minimalTarget;
    } else if (s.implementationCall) {
      proxy.isProxy = true; proxy.pattern = 'implementation()'; proxy.implementation = s.implementationCall;
    } else if (source.ok && source.value?.Proxy === '1' && source.value.Implementation) {
      proxy.isProxy = true; proxy.pattern = 'arbiscan'; proxy.implementation = normalizeAddress(source.value.Implementation);
    } else {
      proxy.isProxy = false;
    }
  } else {
    undetermined.push({ field: 'proxy', reason: `storage reads failed: ${slots.error}` });
    if (minimalTarget) {
      proxy.determined = true; proxy.isProxy = true; proxy.pattern = 'eip1167-minimal'; proxy.implementation = minimalTarget;
    }
  }

  // ---- Source -----------------------------------------------------------
  const sourceInfo: SourceInfo = {
    determined: false, verified: null, contractName: null, compilerVersion: null, license: null,
    optimizationUsed: null, implementationVerified: null, implementationContractName: null,
  };
  let implementationSource: SourceCodeResult | null = null;
  if (source.ok) {
    const s = source.value;
    sourceInfo.determined = true;
    sourceInfo.verified = isVerified(s);
    if (sourceInfo.verified && s) {
      sourceInfo.contractName = s.ContractName || null;
      sourceInfo.compilerVersion = s.CompilerVersion || null;
      sourceInfo.license = s.LicenseType || null;
      sourceInfo.optimizationUsed = s.OptimizationUsed === '1';
    }
    if (proxy.isProxy && proxy.implementation) {
      const implSource = await settle(getSourceCode(proxy.implementation));
      if (implSource.ok) {
        implementationSource = implSource.value;
        sourceInfo.implementationVerified = isVerified(implSource.value);
        sourceInfo.implementationContractName = sourceInfo.implementationVerified ? implSource.value?.ContractName || null : null;
      } else {
        undetermined.push({ field: 'source.implementationVerified', reason: implSource.error });
      }
    }
  } else {
    undetermined.push({ field: 'source', reason: source.error });
  }

  // ---- ABI (implementation's when proxied) -------------------------------
  const abi: Abi | null =
    parseAbi(implementationSource?.ABI && isVerified(implementationSource) ? implementationSource.ABI : null) ??
    parseAbi(source.ok && isVerified(source.value) ? source.value?.ABI : null);
  if (!abi && sourceInfo.determined) {
    undetermined.push({ field: 'control.privilegedFunctions', reason: proxy.isProxy ? 'implementation source not verified, ABI unavailable' : 'source not verified, ABI unavailable' });
  }

  // ---- Control ------------------------------------------------------------
  const control: ControlInfo = {
    determined: ownership.ok, accounts: [], privilegedFunctions: abi ? classifyPrivilegedFunctions(abi) : [],
    ownershipRenounced: null, pausable: null, paused: null, upgradeable: null,
  };
  if (ownership.ok) {
    const o = ownership.value;
    if (o.owner) {
      control.ownershipRenounced = o.owner === ZERO_ADDRESS;
      if (!control.ownershipRenounced) {
        control.accounts.push({ role: 'owner', address: o.owner, kind: await accountKind(o.owner), source: 'owner()' });
      }
    }
    if (o.pendingOwner) {
      control.accounts.push({ role: 'pendingOwner', address: o.pendingOwner, kind: await accountKind(o.pendingOwner), source: 'pendingOwner()' });
    }
    control.pausable = o.paused !== null;
    control.paused = o.paused;
  } else {
    undetermined.push({ field: 'control.accounts', reason: `owner reads failed: ${ownership.error}` });
  }
  if (proxy.admin) {
    const adminSource = proxy.pattern === 'zeppelinos' ? 'zeppelinos admin slot' : 'eip1967 admin slot';
    control.accounts.push({ role: 'proxyAdmin', address: proxy.admin, kind: await accountKind(proxy.admin), source: adminSource });
  }
  if (proxy.determined) {
    const uups = hasFunction(abi, 'upgradeTo') || hasFunction(abi, 'upgradeToAndCall');
    control.upgradeable = proxy.isProxy === true && proxy.pattern !== 'eip1167-minimal' ? true : uups ? true : proxy.isProxy === false ? false : null;
  }
  if (control.accounts.length === 0 && control.ownershipRenounced === null && abi && control.privilegedFunctions.length > 0) {
    undetermined.push({ field: 'control.accounts', reason: 'privileged functions exist but no owner()/admin exposed; access may be role-based (not enumerated)' });
  }

  // ---- Token --------------------------------------------------------------
  const tokenInfo: TokenInfo = { determined: token.ok, isErc20: null, name: null, symbol: null, decimals: null, totalSupply: null };
  if (token.ok) {
    const t = token.value;
    tokenInfo.isErc20 = t.decimals !== null && t.totalSupply !== null && t.balanceOfWorks;
    tokenInfo.name = t.name;
    tokenInfo.symbol = t.symbol;
    tokenInfo.decimals = t.decimals;
    tokenInfo.totalSupply = t.totalSupply !== null && t.decimals !== null ? formatUnits(t.totalSupply, t.decimals) : t.totalSupply?.toString() ?? null;
  } else {
    undetermined.push({ field: 'token', reason: token.error });
  }

  // ---- Approvals (ERC-20 only) and recent logs ----------------------------
  const approvals: ApprovalsInfo = {
    determined: false, applicable: tokenInfo.isErc20 === true, fromBlock: null, toBlock: null,
    totalApprovals: null, unlimitedApprovals: null, distinctSpenders: null, topSpenders: [],
  };
  let recentLogsScanned: number | null = null;
  if (latestBlock.ok) {
    const head = latestBlock.value;
    if (approvals.applicable) {
      const scan = await scanLogs(fetchApprovalChunk(address), head, LOG_WINDOW_BLOCKS, LOG_CHUNK_BLOCKS, LOG_BUDGET_MS);
      if (scan.scannedBlocks === 0n) {
        undetermined.push({ field: 'approvals', reason: scan.truncatedReason ?? 'no blocks scanned' });
      } else {
      approvals.determined = true;
      approvals.fromBlock = scan.fromBlock.toString();
      approvals.toBlock = scan.toBlock.toString();
      approvals.totalApprovals = scan.logs.length;
      const bySpender = new Map<string, { approvals: number; unlimited: number }>();
      let unlimited = 0;
      for (const log of scan.logs) {
        const spender = log.args.spender as string | undefined;
        const value = log.args.value as bigint | undefined;
        if (!spender) continue;
        const entry = bySpender.get(spender) ?? { approvals: 0, unlimited: 0 };
        entry.approvals += 1;
        if (value !== undefined && (value === UINT256_MAX || value >= UNLIMITED_THRESHOLD)) {
          entry.unlimited += 1;
          unlimited += 1;
        }
        bySpender.set(spender, entry);
      }
      approvals.unlimitedApprovals = unlimited;
      approvals.distinctSpenders = bySpender.size;
      const top = [...bySpender.entries()].sort((a, b) => b[1].approvals - a[1].approvals).slice(0, 5);
      approvals.topSpenders = await Promise.all(
        top.map(async ([spender, stats]) => ({
          spender, approvals: stats.approvals, unlimitedApprovals: stats.unlimited, spenderKind: await accountKind(spender),
        }))
      );
      if (scan.truncatedReason) undetermined.push({ field: 'approvals', reason: `scan window shortened: ${scan.truncatedReason}` });
      }
      recentLogsScanned = null;
    } else {
      const scan = await scanLogs(fetchAnyLogChunk(address), head, LOG_WINDOW_BLOCKS, LOG_CHUNK_BLOCKS, LOG_BUDGET_MS);
      if (scan.scannedBlocks === 0n) {
        undetermined.push({ field: 'activity.recentLogsScanned', reason: scan.truncatedReason ?? 'no blocks scanned' });
      } else {
        recentLogsScanned = scan.logs.length;
        approvals.fromBlock = scan.fromBlock.toString();
        approvals.toBlock = scan.toBlock.toString();
        if (scan.truncatedReason) undetermined.push({ field: 'activity.recentLogsScanned', reason: `scan window shortened: ${scan.truncatedReason}` });
      }
    }
  } else {
    undetermined.push({ field: 'approvals', reason: `could not read latest block: ${latestBlock.error}` });
  }

  // ---- Activity -----------------------------------------------------------
  const activity: ActivityInfo = {
    determined: false, creator: null, creationTxHash: null, creationTimestamp: null, ageDays: null, ethBalanceWei: null,
    sampleSize: null, firstSampledTx: null, lastSampledTx: null, distinctSendersInSample: null, failedTxInSample: null,
    topFunctions: [], recentLogsScanned,
  };
  const balance = await settle(publicClient.getBalance({ address }));
  if (balance.ok) activity.ethBalanceWei = balance.value.toString(); else undetermined.push({ field: 'activity.ethBalanceWei', reason: balance.error });

  if (creation.ok && creation.value) {
    activity.creator = creation.value.contractCreator ? normalizeAddress(creation.value.contractCreator) : null;
    activity.creationTxHash = creation.value.txHash || null;
    let created: Date | null = creation.value.timestamp ? new Date(Number(creation.value.timestamp) * 1000) : null;
    if (!created && creation.value.blockNumber) created = await getBlockTimestamp(BigInt(creation.value.blockNumber));
    if (!created && activity.creationTxHash) {
      const receipt = await settle(publicClient.getTransactionReceipt({ hash: activity.creationTxHash as `0x${string}` }));
      if (receipt.ok) created = await getBlockTimestamp(receipt.value.blockNumber);
    }
    if (created) {
      activity.creationTimestamp = created.toISOString();
      activity.ageDays = Math.floor((Date.now() - created.getTime()) / 86_400_000);
    } else {
      undetermined.push({ field: 'activity.creationTimestamp', reason: 'creation block timestamp unavailable' });
    }
  } else {
    undetermined.push({ field: 'activity.creation', reason: creation.ok ? 'arbiscan has no creation record' : creation.error });
  }

  if (txs.ok) {
    activity.determined = true;
    summarizeTransactions(txs.value, abi, activity);
  } else {
    undetermined.push({ field: 'activity.transactions', reason: txs.error });
  }

  const riskFlags = buildRiskFlags({ proxy, source: sourceInfo, control, token: tokenInfo, approvals, activity, undetermined });

  return {
    address,
    chainId: 42161,
    network: 'eip155:42161',
    analyzedAt,
    isContract: true,
    bytecodeSize,
    proxy,
    source: sourceInfo,
    control,
    token: tokenInfo,
    approvals,
    activity,
    riskFlags,
    undetermined,
    dataSources: [...dataSources],
  };
}

function summarizeTransactions(txs: TxListItem[], abi: Abi | null, activity: ActivityInfo): void {
  activity.sampleSize = txs.length;
  if (txs.length === 0) return;
  const times = txs.map((t) => Number(t.timeStamp) * 1000).filter((n) => Number.isFinite(n));
  activity.lastSampledTx = new Date(Math.max(...times)).toISOString();
  activity.firstSampledTx = new Date(Math.min(...times)).toISOString();
  activity.distinctSendersInSample = new Set(txs.map((t) => t.from.toLowerCase())).size;
  activity.failedTxInSample = txs.filter((t) => t.isError === '1').length;

  const selectors = selectorMap(abi);
  const counts = new Map<string, { name: string | null; calls: number }>();
  for (const tx of txs) {
    if (!tx.input || tx.input.length < 10) continue;
    const selector = tx.input.slice(0, 10).toLowerCase();
    const fromArbiscan = tx.functionName ? tx.functionName.split('(')[0] : null;
    const name = selectors.get(selector) ?? fromArbiscan ?? null;
    const entry = counts.get(selector) ?? { name, calls: 0 };
    entry.calls += 1;
    if (!entry.name && name) entry.name = name;
    counts.set(selector, entry);
  }
  activity.topFunctions = [...counts.entries()]
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 5)
    .map(([selector, v]) => ({ selector, name: v.name, calls: v.calls }));
}

function buildRiskFlags(input: {
  proxy: ProxyInfo; source: SourceInfo; control: ControlInfo; token: TokenInfo;
  approvals: ApprovalsInfo; activity: ActivityInfo; undetermined: Undetermined[];
}): RiskFlag[] {
  const { proxy, source, control, token, approvals, activity } = input;
  const flags: RiskFlag[] = [];
  const add = (code: string, severity: RiskFlag['severity'], title: string, evidence: string) => flags.push({ code, severity, title, evidence });

  if (source.determined && source.verified === false) {
    add('UNVERIFIED_SOURCE', 'high', 'Source code is not verified on Arbiscan', 'getsourcecode returned no source for this address');
  }
  if (proxy.isProxy && source.implementationVerified === false) {
    add('IMPLEMENTATION_UNVERIFIED', 'high', 'Proxy implementation is not verified', `implementation ${proxy.implementation} has no verified source`);
  }
  if (control.upgradeable === true) {
    const who = proxy.admin ? `admin ${proxy.admin}` : control.accounts.find((a) => a.role === 'owner')?.address ? `owner ${control.accounts.find((a) => a.role === 'owner')!.address}` : 'an unidentified admin';
    add('UPGRADEABLE', 'medium', 'Contract logic can be replaced', `${proxy.pattern ?? 'upgrade function'} proxy; ${who} can change the implementation`);
  }
  const admin = control.accounts.find((a) => a.role === 'proxyAdmin');
  if (admin?.kind === 'eoa') {
    add('ADMIN_IS_EOA', 'high', 'Proxy admin is a single externally owned account', `${admin.address} holds no code; one private key can upgrade the contract`);
  }
  const owner = control.accounts.find((a) => a.role === 'owner');
  if (owner?.kind === 'eoa') {
    const powers = [...new Set(control.privilegedFunctions.map((f) => f.category))];
    add('OWNER_IS_EOA', powers.length > 0 ? 'medium' : 'low', 'Owner is a single externally owned account',
      `${owner.address} holds no code${powers.length ? `; ABI exposes ${powers.join(', ')} functions` : ''}`);
  }
  if (control.ownershipRenounced === true) {
    add('OWNERSHIP_RENOUNCED', 'info', 'Ownership has been renounced', 'owner() returns the zero address');
  }
  if (control.paused === true) {
    add('PAUSED', 'high', 'Contract is currently paused', 'paused() returned true');
  } else if (control.pausable === true) {
    add('PAUSABLE', 'low', 'Contract can be paused', 'exposes paused(); a privileged account can halt it');
  }
  const byCategory = (category: string) => control.privilegedFunctions.filter((f) => f.category === category).map((f) => f.name);
  const supply = byCategory('supply');
  if (supply.length > 0 && control.ownershipRenounced !== true) {
    add('SUPPLY_CONTROL', token.isErc20 ? 'medium' : 'low', 'Privileged supply functions present', `ABI includes ${supply.join(', ')}`);
  }
  const restriction = byCategory('restriction');
  if (restriction.length > 0) {
    add('TRANSFER_RESTRICTIONS', 'medium', 'Accounts can be restricted or frozen', `ABI includes ${restriction.join(', ')}`);
  }
  const fees = byCategory('fees');
  if (fees.length > 0) {
    add('FEE_CONTROL', 'low', 'Fees or rates are adjustable by a privileged account', `ABI includes ${fees.slice(0, 6).join(', ')}${fees.length > 6 ? ', …' : ''}`);
  }
  const funds = byCategory('funds');
  if (funds.length > 0) {
    add('FUNDS_WITHDRAWAL', 'low', 'Privileged withdrawal or rescue functions present', `ABI includes ${funds.join(', ')}`);
  }
  if (activity.ageDays !== null) {
    if (activity.ageDays < 30) add('NEW_CONTRACT', 'medium', 'Deployed less than 30 days ago', `created ${activity.creationTimestamp}`);
    else if (activity.ageDays < 90) add('RECENT_CONTRACT', 'low', 'Deployed less than 90 days ago', `created ${activity.creationTimestamp}`);
  }
  if (activity.sampleSize !== null && activity.sampleSize < 10) {
    add('LOW_ACTIVITY', 'low', 'Very few transactions on record', `only ${activity.sampleSize} transactions returned by Arbiscan`);
  }
  if (activity.sampleSize && activity.failedTxInSample !== null && activity.failedTxInSample / activity.sampleSize > 0.3) {
    add('HIGH_FAILURE_RATE', 'low', 'Many recent transactions reverted', `${activity.failedTxInSample} of the last ${activity.sampleSize} transactions failed`);
  }
  if (approvals.determined && approvals.unlimitedApprovals !== null && approvals.totalApprovals) {
    const ratio = approvals.unlimitedApprovals / approvals.totalApprovals;
    if (ratio > 0.5 && approvals.totalApprovals >= 10) {
      add('UNLIMITED_APPROVALS_COMMON', 'info', 'Most recent approvals are unlimited', `${approvals.unlimitedApprovals} of ${approvals.totalApprovals} approvals in blocks ${approvals.fromBlock}-${approvals.toBlock} were uint256 max`);
    }
  }
  if (!source.determined) {
    add('SOURCE_NOT_CHECKED', 'info', 'Verification status could not be checked', input.undetermined.find((u) => u.field === 'source')?.reason ?? 'Arbiscan unavailable');
  }
  return flags;
}

function notAContract(address: Address, analyzedAt: string, dataSources: string[]): ContractAnalysis {
  const reason = 'address holds no code';
  const empty = (field: string) => ({ field, reason });
  return {
    address, chainId: 42161, network: 'eip155:42161', analyzedAt, isContract: false, bytecodeSize: 0,
    proxy: { determined: true, isProxy: false, pattern: null, implementation: null, admin: null, beacon: null },
    source: { determined: false, verified: null, contractName: null, compilerVersion: null, license: null, optimizationUsed: null, implementationVerified: null, implementationContractName: null },
    control: { determined: false, accounts: [], privilegedFunctions: [], ownershipRenounced: null, pausable: null, paused: null, upgradeable: null },
    token: { determined: true, isErc20: false, name: null, symbol: null, decimals: null, totalSupply: null },
    approvals: { determined: false, applicable: false, fromBlock: null, toBlock: null, totalApprovals: null, unlimitedApprovals: null, distinctSpenders: null, topSpenders: [] },
    activity: { determined: false, creator: null, creationTxHash: null, creationTimestamp: null, ageDays: null, ethBalanceWei: null, sampleSize: null, firstSampledTx: null, lastSampledTx: null, distinctSendersInSample: null, failedTxInSample: null, topFunctions: [], recentLogsScanned: null },
    riskFlags: [{ code: 'NOT_A_CONTRACT', severity: 'info', title: 'Address is not a contract', evidence: 'eth_getCode returned empty bytecode on Arbitrum One' }],
    undetermined: [empty('source'), empty('control'), empty('approvals'), empty('activity')],
    dataSources,
  };
}
