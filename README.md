# bazaar-seller

Arbitrum contract intelligence sold per call over [x402](https://x402.org) and discoverable through the
[Bazaar extension](https://docs.x402.org/extensions/bazaar) on the notaxyz Arbitrum facilitator.

One paid route:

```
GET /analyze?address=0x...
```

Given a contract address on **Arbitrum One**, it returns a structured analysis:

- proxy status, pattern (EIP-1967, beacon, EIP-1822, EIP-1167 minimal, `implementation()`), implementation and admin
- verified source on Arbiscan, for the contract and for the implementation when proxied
- owner / pending owner / proxy admin accounts, whether each is a contract or a single key, and the privileged
  functions the ABI exposes (upgrade, ownership, pause, supply, restriction, fees, funds, config)
- ERC-20 approval activity in a recent block window: total, unlimited, distinct spenders, top spenders
- recent activity: creator, age, ETH balance, a sample of the latest transactions with the most-called functions
- risk flags with the evidence behind each one

Data comes from an Arbitrum One RPC and the Etherscan V2 API (Arbiscan). Nothing is guessed: a field that could
not be determined is `null` and listed under `undetermined` with the reason.

## Run

```bash
npm install
cp .env.example .env   # fill MERCHANT_API_KEY and ARBISCAN_API_KEY
npm run dev
```

The server reads `payTo` from the facilitator's `GET /supported`, protects `GET /analyze` with
`@x402/express` `paymentMiddleware`, and sends the merchant API key only on `/settle`.

The route declares its discovery metadata with `declareDiscoveryExtension` (see `src/discovery.ts`): example
input, input JSON Schema, and the output shape. After the first paid call settles, the facilitator indexes it and
`GET {FACILITATOR_URL}/discovery/resources?type=http` lists it.

### Scripts

#### First run, in order

The facilitator writes its catalog only after a payment settles, so on a fresh database
`npm run agent` has nothing to discover until a direct paid call has gone through. Run these
in sequence (the facilitator must already be listening):

1. `npm run dev` — start the seller.
2. `npm run pay -- "http://localhost:3100/analyze?address=0x..."` — one direct paid call. This is
   the settlement that gets the service indexed into the facilitator's catalog.
3. `npm run agent -- 0x...` — the discovery demo: reads the facilitator catalog, finds this service
   by its declaration, builds the request from it, pays, and prints the analysis.

Step 2 is only needed once per database; afterwards `npm run agent` works on its own.

#### The rest

- `npm run analyze -- 0x...` — run the analyzer locally, no payment and no facilitator involved.
  Needs only `ARBISCAN_API_KEY` and `ARBITRUM_RPC_URL`; `MERCHANT_API_KEY` and `FACILITATOR_URL`
  may be unset.
- `ENABLE_DEBUG_ROUTE=true npm run dev` — additionally serve `GET /debug/analyze` without payment (development only)
- `npm run check` — type-check without emitting

## Pricing

Single call, `PRICE_USD` (default `$0.25`). Must exceed the facilitator's fixed 0.10 USDC gas fee.
