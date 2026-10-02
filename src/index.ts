import express, { type Request, type Response } from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { paymentConfig } from './paymentConfig.js';
import { analyzeDiscoveryExtension, EXAMPLE_ADDRESS } from './discovery.js';
import { analyzeContract, AnalysisError } from './analysis/analyze.js';
import { isArbiscanConfigured } from './analysis/arbiscan.js';
import { NotaSeller, canonicalJson } from './nota/index.js';

// Fee split model: buyers pay the facilitator signer, which forwards our share to the
// merchant address registered for MERCHANT_API_KEY. payTo therefore comes from /supported.
const SUPPORTED_ATTEMPTS = 5;
const SUPPORTED_RETRY_MS = 2000;

async function fetchSupportedOnce(): Promise<string> {
  const response = await fetch(`${paymentConfig.facilitatorUrl}/supported`);
  if (!response.ok) {
    throw new Error(`GET ${paymentConfig.facilitatorUrl}/supported failed with ${response.status}`);
  }
  const supported = (await response.json()) as { signers?: Record<string, string[]>; extensions?: string[] };
  const payTo = supported.signers?.['eip155:*']?.[0];
  if (!payTo) {
    throw new Error('Facilitator did not advertise an eip155 signer');
  }
  if (!supported.extensions?.includes('bazaar')) {
    console.warn('Facilitator does not advertise the bazaar extension; this service will not be discoverable through it');
  }
  return payTo;
}

// The facilitator is often still booting when this starts (or not running at all).
// Retry rather than dying on an unhandled rejection, and fail with a line that says what to fix.
async function getFacilitatorPayTo(): Promise<string> {
  for (let attempt = 1; attempt <= SUPPORTED_ATTEMPTS; attempt++) {
    try {
      return await fetchSupportedOnce();
    } catch (error: any) {
      const reason = error?.cause?.message || error?.message || String(error);
      if (attempt === SUPPORTED_ATTEMPTS) {
        console.error(
          `Cannot reach the x402 facilitator at ${paymentConfig.facilitatorUrl} (${reason}). ` +
            `Tried GET ${paymentConfig.facilitatorUrl}/supported ${SUPPORTED_ATTEMPTS} times. ` +
            'The facilitator must be running before this service can start; set FACILITATOR_URL if it listens elsewhere.',
        );
        process.exit(1);
      }
      console.warn(`Facilitator not ready (attempt ${attempt}/${SUPPORTED_ATTEMPTS}: ${reason}); retrying in ${SUPPORTED_RETRY_MS}ms`);
      await new Promise((resolve) => setTimeout(resolve, SUPPORTED_RETRY_MS));
    }
  }
  throw new Error('unreachable');
}

const facilitatorClient = new HTTPFacilitatorClient({
  url: paymentConfig.facilitatorUrl,
  createAuthHeaders: async () => ({
    verify: {},
    settle: { 'X-API-Key': paymentConfig.merchantApiKey },
    supported: {},
  }),
});

// Nota attestation. Startup refuses to continue unless an attestation could succeed; at request
// time attestation is best-effort and never fails a paid call.
const nota = new NotaSeller(paymentConfig.nota);
try {
  await nota.checkStartup();
} catch (error: any) {
  console.error(`Nota attestation is misconfigured: ${error?.shortMessage || error?.message || error}`);
  process.exit(1);
}

// @x402/express buffers the handler's response, calls the facilitator's /settle, runs afterSettle
// hooks with the settle result (including the settlement transaction hash), and only then flushes
// the buffered body to the buyer.
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(paymentConfig.network, new ExactEvmScheme())
  .onAfterSettle(nota.onAfterSettle);
const payTo = await getFacilitatorPayTo();

const app = express();
app.set('trust proxy', true);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', arbiscan: isArbiscanConfigured() ? 'configured' : 'missing', network: paymentConfig.network });
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Nota Contract Intel',
    description: 'Structured risk and control analysis of Arbitrum One smart contracts, paid per call over x402',
    route: 'GET /analyze?address=0x...',
    example: `/analyze?address=${EXAMPLE_ADDRESS}`,
    price: `$${paymentConfig.priceUsd} USDC per call`,
    facilitator: paymentConfig.facilitatorUrl,
    discovery: `${paymentConfig.facilitatorUrl}/discovery/resources?type=http`,
  });
});

app.use(
  paymentMiddleware(
    {
      'GET /analyze': {
        accepts: {
          scheme: 'exact',
          price: `$${paymentConfig.priceUsd}`,
          network: paymentConfig.network,
          payTo,
        },
        description:
          'Risk and control analysis of an Arbitrum One smart contract: proxy status and implementation, verified source, owner and admin accounts with their powers, ERC-20 approval activity, recent transaction summary, and risk flags. Undetermined fields are reported as such, never guessed.',
        mimeType: 'application/json',
        serviceName: 'Nota Contract Intel',
        tags: ['arbitrum', 'smart-contracts', 'security', 'risk', 'defi'],
        // What an agent needs to call this route without guessing: input example, input schema, output shape
        extensions: analyzeDiscoveryExtension,
      },
    },
    resourceServer,
  ),
);

async function analyze(req: Request, res: Response, attest: boolean): Promise<void> {
  const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: 'invalid_address', message: 'address query parameter must be a 0x-prefixed 20-byte hex address' });
    return;
  }
  const started = Date.now();
  try {
    const analysis = await analyzeContract(address);
    console.log(`[analyze] ${analysis.address} flags=${analysis.riskFlags.length} undetermined=${analysis.undetermined.length} ${Date.now() - started}ms`);
    // Serialized exactly once. This string is the body, and the attestation hashes this string.
    const body = canonicalJson(analysis);
    if (attest) {
      try {
        res.set(nota.prepareReceipt(body));
      } catch (error: any) {
        // The buyer is paying for the analysis, not the receipt: serve it unattested.
        console.warn(`[nota] could not prepare a receipt; serving unattested: ${error?.message ?? error}`);
      }
    }
    res.type('application/json').send(body);
  } catch (error: any) {
    if (error instanceof AnalysisError) {
      res.status(error.status).json({ error: error.status === 400 ? 'invalid_address' : 'upstream_unavailable', message: error.message });
      return;
    }
    console.error('[analyze] failed', error);
    res.status(500).json({ error: 'analysis_failed', message: error.message });
  }
}

// Paid route. The middleware above has already verified payment; settlement happens after this
// responds, and the attestation is queued from the afterSettle hook.
app.get('/analyze', (req, res) => analyze(req, res, true));

// Development only: the same handler without payment, for checking analyzer output locally.
if (process.env.ENABLE_DEBUG_ROUTE === 'true') {
  console.warn('ENABLE_DEBUG_ROUTE is set: GET /debug/analyze is served without payment');
  app.get('/debug/analyze', (req, res) => analyze(req, res, false));
}

app.listen(paymentConfig.port, () => {
  console.log(`bazaar-seller listening on http://localhost:${paymentConfig.port}`);
  console.log(`Facilitator:  ${paymentConfig.facilitatorUrl}`);
  console.log(`Network:      ${paymentConfig.network}`);
  console.log(`payTo:        ${payTo}`);
  console.log(`Price:        $${paymentConfig.priceUsd} per GET /analyze`);
  console.log(`Arbiscan key: ${isArbiscanConfigured() ? 'configured' : 'MISSING or placeholder (source/activity fields will be undetermined)'}`);
  console.log(`Nota:         listing ${nota.listingId} on ${nota.receiptStore} (chain ${nota.chain.id}), seller ${nota.account.address}`);
});
