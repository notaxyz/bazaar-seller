import 'dotenv/config';
import { analyzeContract } from '../src/analysis/analyze.js';

// Runs the analyzer directly, no payment, for local inspection: npm run analyze -- 0x...
const address = process.argv[2];
if (!address) {
  console.error('usage: npm run analyze -- <contract address on Arbitrum One>');
  process.exit(1);
}
const started = Date.now();
const result = await analyzeContract(address);
console.log(JSON.stringify(result, null, 2));
console.error(`done in ${Date.now() - started}ms`);
