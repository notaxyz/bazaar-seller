import { toFunctionSelector, type Abi, type AbiFunction } from 'viem';
import type { PrivilegedFunction } from './types.js';

/**
 * ABI-driven inspection. Nothing here proves who may call a function; it only
 * reports which state-changing functions exist and what their names indicate.
 */

const CATEGORIES: { category: string; pattern: RegExp }[] = [
  { category: 'upgrade', pattern: /^(upgradeTo|upgradeToAndCall|changeAdmin|setImplementation|upgrade)$/i },
  { category: 'ownership', pattern: /^(transferOwnership|renounceOwnership|acceptOwnership|setOwner|grantRole|revokeRole|renounceRole|setAdmin|changeOwner|setPendingOwner|setGovernance|setGovernor)$/i },
  { category: 'pause', pattern: /^(pause|unpause|setPaused|emergencyStop|emergencyPause|halt|unhalt)$/i },
  { category: 'supply', pattern: /^(mint|mintTo|mintBatch|adminBurn|setCap|setMaxSupply|rebase|setMinter|configureMinter|removeMinter)$/i },
  { category: 'restriction', pattern: /(blacklist|blocklist|denylist|freeze|unfreeze|whitelist|allowlist|ban|unban|setBlocked|setRestricted|setLimit|setMaxTx|setMaxWallet)/i },
  { category: 'fees', pattern: /(fee|tax|setRate|setRoyalt)/i },
  { category: 'funds', pattern: /^(withdraw|withdrawAll|withdrawToken|withdrawETH|rescue|rescueTokens|rescueERC20|sweep|recover|recoverERC20|skim|claimFees|emergencyWithdraw|drain)$/i },
  { category: 'config', pattern: /^(set|update|configure|change|toggle|enable|disable)[A-Z_]/ },
];

export function parseAbi(raw: string | undefined | null): Abi | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Abi) : null;
  } catch {
    return null;
  }
}

function signatureOf(fn: AbiFunction): string {
  return `${fn.name}(${fn.inputs.map((i) => i.type).join(',')})`;
}

export function stateChangingFunctions(abi: Abi): AbiFunction[] {
  return abi.filter(
    (item): item is AbiFunction =>
      item.type === 'function' && (item.stateMutability === 'nonpayable' || item.stateMutability === 'payable')
  );
}

export function classifyPrivilegedFunctions(abi: Abi): PrivilegedFunction[] {
  const seen = new Set<string>();
  const result: PrivilegedFunction[] = [];
  for (const fn of stateChangingFunctions(abi)) {
    const signature = signatureOf(fn);
    if (seen.has(signature)) continue;
    const match = CATEGORIES.find((c) => c.pattern.test(fn.name));
    if (!match) continue;
    seen.add(signature);
    result.push({ name: fn.name, signature, category: match.category });
  }
  return result.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function hasFunction(abi: Abi | null, name: string): boolean {
  return !!abi && abi.some((item) => item.type === 'function' && item.name === name);
}

/** 4-byte selector to function name, for resolving transaction inputs. */
export function selectorMap(abi: Abi | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!abi) return map;
  for (const item of abi) {
    if (item.type !== 'function') continue;
    try {
      map.set(toFunctionSelector(item).toLowerCase(), item.name);
    } catch {
      // malformed entry; skip
    }
  }
  return map;
}
