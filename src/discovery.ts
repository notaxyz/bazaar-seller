import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

/**
 * Bazaar declaration for GET /analyze. Kept in one place so the discovery
 * metadata an agent sees matches what the handler actually accepts and returns.
 */

export const EXAMPLE_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // native USDC on Arbitrum One

const riskFlagSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'low', 'medium', 'high'] },
    title: { type: 'string' },
    evidence: { type: 'string' },
  },
  required: ['code', 'severity', 'title', 'evidence'],
};

const outputSchema = {
  type: 'object',
  description: 'Structured analysis of an Arbitrum One contract. Fields that could not be determined are null and listed under `undetermined` with a reason; nothing is guessed.',
  properties: {
    address: { type: 'string', description: 'Checksummed contract address' },
    chainId: { type: 'integer', const: 42161 },
    network: { type: 'string', const: 'eip155:42161' },
    analyzedAt: { type: 'string', description: 'ISO 8601 timestamp of the analysis' },
    isContract: { type: 'boolean' },
    bytecodeSize: { type: 'integer' },
    proxy: {
      type: 'object',
      properties: {
        determined: { type: 'boolean' },
        isProxy: { type: ['boolean', 'null'] },
        pattern: { type: ['string', 'null'], description: 'eip1967 | eip1967-beacon | eip1822 | eip1167-minimal | implementation() | arbiscan' },
        implementation: { type: ['string', 'null'] },
        admin: { type: ['string', 'null'], description: 'EIP-1967 admin slot holder' },
        beacon: { type: ['string', 'null'] },
      },
    },
    source: {
      type: 'object',
      properties: {
        determined: { type: 'boolean' },
        verified: { type: ['boolean', 'null'] },
        contractName: { type: ['string', 'null'] },
        compilerVersion: { type: ['string', 'null'] },
        license: { type: ['string', 'null'] },
        optimizationUsed: { type: ['boolean', 'null'] },
        implementationVerified: { type: ['boolean', 'null'] },
        implementationContractName: { type: ['string', 'null'] },
      },
    },
    control: {
      type: 'object',
      properties: {
        determined: { type: 'boolean' },
        accounts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'owner | pendingOwner | proxyAdmin' },
              address: { type: 'string' },
              kind: { type: 'string', enum: ['contract', 'eoa', 'unknown'] },
              source: { type: 'string', description: 'how the account was found' },
            },
          },
        },
        privilegedFunctions: {
          type: 'array',
          description: 'State-changing ABI functions whose names indicate privileged powers',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              signature: { type: 'string' },
              category: { type: 'string', description: 'upgrade | ownership | pause | supply | restriction | fees | funds | config' },
            },
          },
        },
        ownershipRenounced: { type: ['boolean', 'null'] },
        pausable: { type: ['boolean', 'null'] },
        paused: { type: ['boolean', 'null'] },
        upgradeable: { type: ['boolean', 'null'] },
      },
    },
    token: {
      type: 'object',
      properties: {
        determined: { type: 'boolean' },
        isErc20: { type: ['boolean', 'null'] },
        name: { type: ['string', 'null'] },
        symbol: { type: ['string', 'null'] },
        decimals: { type: ['integer', 'null'] },
        totalSupply: { type: ['string', 'null'], description: 'Decimal string in whole tokens' },
      },
    },
    approvals: {
      type: 'object',
      description: 'ERC-20 Approval events emitted by the token in the scanned block window',
      properties: {
        determined: { type: 'boolean' },
        applicable: { type: 'boolean' },
        fromBlock: { type: ['string', 'null'] },
        toBlock: { type: ['string', 'null'] },
        totalApprovals: { type: ['integer', 'null'] },
        unlimitedApprovals: { type: ['integer', 'null'] },
        distinctSpenders: { type: ['integer', 'null'] },
        topSpenders: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              spender: { type: 'string' },
              approvals: { type: 'integer' },
              unlimitedApprovals: { type: 'integer' },
              spenderKind: { type: 'string', enum: ['contract', 'eoa', 'unknown'] },
            },
          },
        },
      },
    },
    activity: {
      type: 'object',
      properties: {
        determined: { type: 'boolean' },
        creator: { type: ['string', 'null'] },
        creationTxHash: { type: ['string', 'null'] },
        creationTimestamp: { type: ['string', 'null'] },
        ageDays: { type: ['integer', 'null'] },
        ethBalanceWei: { type: ['string', 'null'] },
        sampleSize: { type: ['integer', 'null'], description: 'Number of recent transactions inspected (max 100)' },
        firstSampledTx: { type: ['string', 'null'] },
        lastSampledTx: { type: ['string', 'null'] },
        distinctSendersInSample: { type: ['integer', 'null'] },
        failedTxInSample: { type: ['integer', 'null'] },
        topFunctions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { selector: { type: 'string' }, name: { type: ['string', 'null'] }, calls: { type: 'integer' } },
          },
        },
        recentLogsScanned: { type: ['integer', 'null'] },
      },
    },
    riskFlags: { type: 'array', items: riskFlagSchema },
    undetermined: {
      type: 'array',
      items: { type: 'object', properties: { field: { type: 'string' }, reason: { type: 'string' } } },
    },
    dataSources: { type: 'array', items: { type: 'string' } },
  },
  required: ['address', 'chainId', 'network', 'analyzedAt', 'isContract', 'proxy', 'source', 'control', 'token', 'approvals', 'activity', 'riskFlags', 'undetermined', 'dataSources'],
};

// Real output of `npm run analyze -- <EXAMPLE_ADDRESS>`, with topSpenders and topFunctions capped
// for size. No value is invented or edited; this is what the route actually returned.
const outputExample = {
  address: EXAMPLE_ADDRESS,
  chainId: 42161,
  network: 'eip155:42161',
  analyzedAt: '2026-09-29T11:09:51.067Z',
  isContract: true,
  bytecodeSize: 1852,
  proxy: { determined: true, isProxy: true, pattern: 'zeppelinos', implementation: '0x86E721b43d4ECFa71119Dd38c0f938A75Fdb57B3', admin: '0x2E0A67588cfBCAD40f9e4DD76052436190A77a68', beacon: null },
  source: { determined: true, verified: true, contractName: 'FiatTokenProxy', compilerVersion: 'v0.6.12+commit.27d51765', license: null, optimizationUsed: true, implementationVerified: true, implementationContractName: 'FiatTokenV2_2' },
  control: { determined: true, accounts: [{ role: 'owner', address: '0xc7a599037fDa4Ff8029df9a042Af6053d061ebc9', kind: 'eoa', source: 'owner()' }, { role: 'proxyAdmin', address: '0x2E0A67588cfBCAD40f9e4DD76052436190A77a68', kind: 'eoa', source: 'zeppelinos admin slot' }], privilegedFunctions: [{ name: 'updateMasterMinter', signature: 'updateMasterMinter(address)', category: 'config' }, { name: 'updatePauser', signature: 'updatePauser(address)', category: 'config' }, { name: 'updateRescuer', signature: 'updateRescuer(address)', category: 'config' }, { name: 'rescueERC20', signature: 'rescueERC20(address,address,uint256)', category: 'funds' }, { name: 'transferOwnership', signature: 'transferOwnership(address)', category: 'ownership' }, { name: 'pause', signature: 'pause()', category: 'pause' }, { name: 'unpause', signature: 'unpause()', category: 'pause' }, { name: 'blacklist', signature: 'blacklist(address)', category: 'restriction' }, { name: 'unBlacklist', signature: 'unBlacklist(address)', category: 'restriction' }, { name: 'updateBlacklister', signature: 'updateBlacklister(address)', category: 'restriction' }, { name: 'configureMinter', signature: 'configureMinter(address,uint256)', category: 'supply' }, { name: 'mint', signature: 'mint(address,uint256)', category: 'supply' }, { name: 'removeMinter', signature: 'removeMinter(address)', category: 'supply' }], ownershipRenounced: false, pausable: true, paused: false, upgradeable: true },
  token: { determined: true, isErc20: true, name: 'USD Coin', symbol: 'USDC', decimals: 6, totalSupply: '2679132744.346558' },
  approvals: { determined: true, applicable: true, fromBlock: '509990160', toBlock: '510010159', totalApprovals: 3212, unlimitedApprovals: 375, distinctSpenders: 413, topSpenders: [{ spender: '0x0d9D44B6D55f0413C9fD168E78e9e2AAB794bfBd', approvals: 712, unlimitedApprovals: 0, spenderKind: 'contract' }, { spender: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', approvals: 195, unlimitedApprovals: 2, spenderKind: 'contract' }] },
  activity: { determined: true, creator: '0x75237625cc7bDf0739cBb139b06484E05eEE7878', creationTxHash: '0xec773df8d80c83b23c74d0368f63d095f040c5fc6f9e749d0b429a7410c62662', creationTimestamp: '2022-10-31T20:42:12.000Z', ageDays: 1428, ethBalanceWei: '0', sampleSize: 100, firstSampledTx: '2026-09-29T11:09:01.000Z', lastSampledTx: '2026-09-29T11:09:51.000Z', distinctSendersInSample: 48, failedTxInSample: 0, topFunctions: [{ selector: '0xa9059cbb', name: 'transfer', calls: 95 }, { selector: '0x095ea7b3', name: 'approve', calls: 4 }], recentLogsScanned: null },
  riskFlags: [
    { code: 'UPGRADEABLE', severity: 'medium', title: 'Contract logic can be replaced', evidence: 'zeppelinos proxy; admin 0x2E0A67588cfBCAD40f9e4DD76052436190A77a68 can change the implementation' },
    { code: 'ADMIN_IS_EOA', severity: 'high', title: 'Proxy admin is a single externally owned account', evidence: '0x2E0A67588cfBCAD40f9e4DD76052436190A77a68 holds no code; one private key can upgrade the contract' },
    { code: 'OWNER_IS_EOA', severity: 'medium', title: 'Owner is a single externally owned account', evidence: '0xc7a599037fDa4Ff8029df9a042Af6053d061ebc9 holds no code; ABI exposes config, funds, ownership, pause, restriction, supply functions' },
    { code: 'PAUSABLE', severity: 'low', title: 'Contract can be paused', evidence: 'exposes paused(); a privileged account can halt it' },
    { code: 'SUPPLY_CONTROL', severity: 'medium', title: 'Privileged supply functions present', evidence: 'ABI includes configureMinter, mint, removeMinter' },
    { code: 'TRANSFER_RESTRICTIONS', severity: 'medium', title: 'Accounts can be restricted or frozen', evidence: 'ABI includes blacklist, unBlacklist, updateBlacklister' },
    { code: 'FUNDS_WITHDRAWAL', severity: 'low', title: 'Privileged withdrawal or rescue functions present', evidence: 'ABI includes rescueERC20' },
  ],
  undetermined: [],
  dataSources: ['rpc:arb1.arbitrum.io', 'arbiscan (etherscan v2 api, chainid 42161)'],
};

export const analyzeDiscoveryExtension = declareDiscoveryExtension({
  input: { address: EXAMPLE_ADDRESS },
  inputSchema: {
    properties: {
      address: {
        type: 'string',
        pattern: '^0x[a-fA-F0-9]{40}$',
        description: 'Contract address on Arbitrum One (chain id 42161) to analyze',
      },
    },
    required: ['address'],
  },
  output: {
    example: outputExample,
    schema: outputSchema,
  },
});
