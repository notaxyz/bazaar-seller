/**
 * Output contract for the analysis endpoint. Every section carries `determined`
 * so a consumer can tell "we checked and it is false" from "we could not check".
 * Nothing in here is guessed: when a data source is unavailable the field is null
 * and the reason is recorded in `undetermined`.
 */

export type Severity = 'info' | 'low' | 'medium' | 'high';

export interface RiskFlag {
  code: string;
  severity: Severity;
  title: string;
  evidence: string;
}

export interface ProxyInfo {
  determined: boolean;
  isProxy: boolean | null;
  /** How the proxy was recognised: eip1967 | eip1822 | eip1167 | implementation() | arbiscan */
  pattern: string | null;
  implementation: string | null;
  /** EIP-1967 admin slot holder, if any */
  admin: string | null;
  /** EIP-1967 beacon, if any */
  beacon: string | null;
}

export interface SourceInfo {
  determined: boolean;
  verified: boolean | null;
  contractName: string | null;
  compilerVersion: string | null;
  license: string | null;
  optimizationUsed: boolean | null;
  /** Implementation verification status when the target is a proxy */
  implementationVerified: boolean | null;
  implementationContractName: string | null;
}

export interface PrivilegedAccount {
  role: string;
  address: string;
  /** contract | eoa | unknown */
  kind: 'contract' | 'eoa' | 'unknown';
  source: string;
}

export interface PrivilegedFunction {
  name: string;
  signature: string;
  category: string;
}

export interface ControlInfo {
  determined: boolean;
  accounts: PrivilegedAccount[];
  /** State-changing functions in the ABI whose names indicate privileged powers */
  privilegedFunctions: PrivilegedFunction[];
  ownershipRenounced: boolean | null;
  pausable: boolean | null;
  paused: boolean | null;
  upgradeable: boolean | null;
}

export interface TokenInfo {
  determined: boolean;
  isErc20: boolean | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
}

export interface ApprovalSpender {
  spender: string;
  approvals: number;
  unlimitedApprovals: number;
  spenderKind: 'contract' | 'eoa' | 'unknown';
}

export interface ApprovalsInfo {
  determined: boolean;
  applicable: boolean;
  fromBlock: string | null;
  toBlock: string | null;
  totalApprovals: number | null;
  unlimitedApprovals: number | null;
  distinctSpenders: number | null;
  topSpenders: ApprovalSpender[];
}

export interface ActivityInfo {
  determined: boolean;
  creator: string | null;
  creationTxHash: string | null;
  creationTimestamp: string | null;
  ageDays: number | null;
  ethBalanceWei: string | null;
  /** Based on the most recent transactions returned by Arbiscan (max 100) */
  sampleSize: number | null;
  firstSampledTx: string | null;
  lastSampledTx: string | null;
  distinctSendersInSample: number | null;
  failedTxInSample: number | null;
  topFunctions: { selector: string; name: string | null; calls: number }[];
  /** Event logs emitted by the contract in the scanned block window */
  recentLogsScanned: number | null;
}

export interface ContractAnalysis {
  address: string;
  chainId: 42161;
  network: 'eip155:42161';
  analyzedAt: string;
  isContract: boolean;
  bytecodeSize: number;
  proxy: ProxyInfo;
  source: SourceInfo;
  control: ControlInfo;
  token: TokenInfo;
  approvals: ApprovalsInfo;
  activity: ActivityInfo;
  riskFlags: RiskFlag[];
  /** Fields that could not be determined, with the reason */
  undetermined: { field: string; reason: string }[];
  dataSources: string[];
}
