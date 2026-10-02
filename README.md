# bazaar-seller
 
x402 proves a payment moved. Nothing proves what came back.
 
This is a working answer to that. A paid API that, once each call has settled, publishes an
on-chain commitment to exactly the bytes it returned. Anyone holding those bytes — the buyer,
an arbiter, the next agent deciding whether to buy here — can check them against the commitment
without the seller's cooperation and without trusting a log the seller controls.
 
The service itself is contract intelligence for Arbitrum One, sold per call over
[x402](https://x402.org) and discoverable through the
[Bazaar extension](https://docs.x402.org/extensions/bazaar) on the notaxyz Arbitrum facilitator.
That is the vehicle. The receipt is the point.
 
One command runs all of it. `npm run agent` reads a catalog it was never told about, finds this
service by its own declaration, pays in USDC, receives the analysis, then finds the seller's
commitment on chain and checks it against the bytes it holds.
[Unedited console output from a real run on Arbitrum Sepolia.](runs/agent-run-2026-10-02.txt)
 
| repo | |
| --- | --- |
| [notaxyz/contracts](https://github.com/notaxyz/contracts) | Nota. `attestReceipt` / `ReceiptAttested`, deployed to Arbitrum Sepolia |
| [notaxyz/x402-facilitator](https://github.com/notaxyz/x402-facilitator) | the x402 facilitator, with the Bazaar discovery extension |
| this repo | the seller: analyzer, x402 route, attestation, verifier |
 
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
cp .env.example .env   # fill MERCHANT_API_KEY, ARBISCAN_API_KEY and the Nota variables below
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
3. `npm run agent` — the discovery demo: reads the facilitator catalog, finds this service
   by its declaration, builds the request from it, pays, prints the analysis, then waits for
   the seller's Nota attestation and verifies it against the exact bytes received. Pass an
   address to analyse a specific contract; with no argument it uses the example address from
   the service's own declaration, so nothing on the command line comes from the buyer.

Step 2 is only needed once per database; afterwards `npm run agent` works on its own.
 
**A seller on localhost needs `DISCOVERY_ALLOW_PRIVATE_RESOURCE_URLS=true` on the facilitator.** The catalog
hands out URLs for agents to call, so the facilitator screens each declared `resource.url` and refuses
loopback, private and IP-literal hosts. Without the flag, the payment in step 2 still settles but the seller
logs `"bazaar":{"status":"rejected","rejectedReason":"resource.url host must not be a loopback address"}`
and the catalog stays empty. That is the screen doing its job. The flag exists for local development
against a seller on `localhost`. A deployed seller has a public URL, and the screen applies to it unchanged.
 
#### The rest
 
- `npm run analyze -- 0x...` — run the analyzer locally, no payment and no facilitator involved.
  Needs only `ARBISCAN_API_KEY` and `ARBITRUM_RPC_URL`; `MERCHANT_API_KEY` and `FACILITATOR_URL`
  may be unset.
- `ENABLE_DEBUG_ROUTE=true npm run dev` — additionally serve `GET /debug/analyze` without payment (development only)
- `npm run verify -- <purchaseRef> [analysis.json]` — buyer-side verification of a Nota attestation;
  see [Nota attestation](#nota-attestation). Reads the analysis bytes from stdin when no file is given.
- `npm run check` — type-check without emitting

## Pricing
 
Single call, `PRICE_USD` (default `$0.25`). Must exceed the facilitator's fixed 0.10 USDC gas fee.
 
At `$0.25` that flat fee is 40% of the price: of 0.25 USDC the merchant receives 0.149253, and the
facilitator keeps the 0.10 gas fee plus a 0.000747 service fee (0.5% of the merchant amount). The
facilitator's actual cost to settle, from the receipts of a real call on Arbitrum Sepolia (2026-10-02,
effective gas price 0.040098 gwei):
 
| transaction | gas used | of which L1 data | fee |
| --- | --- | --- | --- |
| buyer → facilitator, `transferWithAuthorization` ([`0x0e77cb9f…`](https://sepolia.arbiscan.io/tx/0x0e77cb9f69cb511fbdf25c368230f4344703eea412537333fa74aecaa12fc5d7)) | 86,706 | 954 | 0.0000034767 ETH |
| facilitator → merchant, forward ([`0xc02b42ba…`](https://sepolia.arbiscan.io/tx/0xc02b42ba1e39d622fdaedbf79a2fdbd2913d6ab7161947a72f252d7aa8dde7e1)) | 45,508 | 449 | 0.0000018248 ETH |
| total | 132,214 | 1,403 | 0.0000053015 ETH |
 
In USD that is 0.0000053 × the ETH price, and it moves with the gas price. These are testnet figures;
measure on Arbitrum One before setting a fee from them.
 
## Nota attestation
 
After a paid call settles, the seller publishes an on-chain commitment to exactly the bytes it returned:
`attestReceipt(listingId, buyer, purchaseRef, metadataHash, agentId, paymentRef)` on Nota's
`NotaReceiptStore` on Arbitrum Sepolia (chain id 421614). It moves no funds, consumes `purchaseRef` in the
shared `PurchaseRefRegistry`, and emits `ReceiptAttested`. Code: `src/nota/`.
 
Deployment (from `notaxyz/contracts` `deployments/arbitrum-sepolia-attest.json`):
 
| contract | address |
| --- | --- |
| `NotaReceiptStore` | `0x6b13e2077c84e1326111acBbb618E028723e2EA2` |
| `PurchaseRefRegistry` | `0x32aAeC7768adBBFD65C776b129616b8727d0c8bd` |
| settlement token (USDC) | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |
 
### Environment
 
Seller (validated at startup in `src/paymentConfig.ts`; `npm run analyze` does not need any of them):
 
| variable | |
| --- | --- |
| `NOTA_RPC_URL` | Arbitrum Sepolia RPC. Also used by `npm run verify` and `npm run agent` (they fall back to the public RPC) |
| `NOTA_RECEIPT_STORE` | the store address above |
| `NOTA_PURCHASE_REF_REGISTRY` | the registry address above; startup checks the store is wired to it |
| `NOTA_LISTING_ID` | a listing on the store whose seller is the `SELLER_PRIVATE_KEY` address |
| `SELLER_PRIVATE_KEY` | signs `attestReceipt`. Needs Arbitrum Sepolia ETH for gas; holds no USDC role |
 
Buyer (`npm run verify`, `npm run agent`):
 
| variable | |
| --- | --- |
| `NOTA_EXPECTED_SELLER` | the seller address you expect to have bought from (or `--seller` on `verify`). It has to come from the buyer, never from the seller's response |
 
The server refuses to start unless an attestation could succeed: the RPC is on chain 421614, the store uses
the configured registry, the listing exists, is active and belongs to the seller key, and the local
`purchaseRef` hash agrees with the contract's `hashPurchaseRef` for a throwaway bundle.
 
The listing must exist before the seller starts. Create it once from the seller wallet, as a
`SignedQuoteOnly` listing (mode `1`, price `0`), so nobody can buy it directly through the store
and it serves only as the subject of attestations.

Both contracts are verified, so the simplest route is Arbiscan's write tab — connect the seller
wallet and call `createListing` with `listingHash` = any non-zero `bytes32` identifying the
service, `unitPrice` = `0`, `mode` = `1`:

<https://sepolia.arbiscan.io/address/0x6b13e2077c84e1326111acBbb618E028723e2EA2#writeContract>

Or from the command line:

```bash
cast send 0x6b13e2077c84e1326111acBbb618E028723e2EA2 "createListing(bytes32,uint256,uint8)" \
  <listingHash> 0 1 --rpc-url $NOTA_RPC_URL --private-key <seller key>
```

The listing for this deployment uses `keccak256("nota-contract-intel:GET /analyze:v1")`
= `0xccfbae53093baced84a8419f7608f4a27547adb23538c3cc4eb32bb045b2ebea`. The hash is an opaque
commitment; it only has to be reproducible.
 
### Response headers
 
Set on every successful paid `GET /analyze` response, before the body is sent:
 
| header | value |
| --- | --- |
| `X-Nota-Purchase-Ref` | the `purchaseRef` (bytes32 hex) the attestation will carry. This is the lookup key |
| `X-Nota-Receipt-Store` | the store the seller attests on |
| `X-Nota-Chain-Id` | `421614` |
 
The store and chain headers are a convenience. The verifier filters logs to the store from the deployment
record, not the header, and fails step 0 if the header disagrees with it.
 
### What gets committed
 
The paid response body is the [JCS (RFC 8785)](https://www.rfc-editor.org/rfc/rfc8785) serialization of
the analysis, produced once by [`canonicalize`](https://github.com/erdtman/canonicalize). That package is the
JCS reference implementation by one of the RFC's authors; it has no dependencies and reproduces the RFC's
own example output. The same string is sent as the body and hashed: `metadataHash = keccak256(utf8(body))`.
Nothing is serialized twice. Before attesting, the afterSettle hook also checks the hash against the
response bytes the middleware is about to flush. If they differed, it would skip the attestation rather
than commit to something the buyer did not receive.
 
### purchaseRef
 
Each paid request gets a fresh `rawPurchaseRef` (`nota_x402-analyze_<128-bit random hex>`) and a 32-byte
CSPRNG `purchaseRefNonce`. `purchaseRef` is the store's `hashPurchaseRef` preimage, computed locally:
`keccak256(abi.encode("nota.purchaseRef.receipt.v1", chainId, settlementToken, seller, rawPurchaseRef, purchaseRefNonce))`.
It is computed locally so the nonce never reaches an RPC provider. The `(rawPurchaseRef, purchaseRefNonce)`
pair is appended to `.nota/purchase-refs.jsonl` (mode 0600, gitignored) for a future redemption flow. It is
never logged, never sent in a response, and never put in calldata.
 
### Ordering and `paymentRef`
 
The installed `@x402/express` (2.27.0) does not send the handler's response before settling. It wraps
`res.writeHead`, `res.write` and `res.end` and buffers them. When the handler ends, it calls the
facilitator's `/settle`, runs the resource server's `onAfterSettle` hooks, and only then flushes the
buffered response. If settlement fails, the buffered body is discarded and the buyer gets a 402. The
`afterSettle` hook (`@x402/core/server`) receives the facilitator's `SettleResponse`. Its `transaction` is
the settlement transaction hash: on the notaxyz facilitator fork, the confirmed
`transferWithAuthorization` that moved the buyer's USDC. The hook also receives the buffered response
headers and body.
 
So the settlement hash is reachable, and **`paymentRef` is the settlement transaction hash, passed as-is and
never re-hashed**. The EIP-3009 nonce fallback is not used. `buyer` is the payer from the payment payload
(`authorization.from`).
 
`agentId` is zero, since the x402 payload carries no agent identity. The field is in the event because the
next step is an approval flow: an agent requests a purchase, a human approves it, and the receipt records
which identified agent was authorised to buy what — ERC-8004 for who, x402 for how it paid, Nota for what
was agreed and delivered. Nothing in this repo depends on that yet; the slot is deployed and currently unused.
 
The hook runs while the buyer's response is still held, so it only queues the attestation and returns.
Attestations go out one at a time from the seller key. Every failure is caught and logged as a warning:
a revert, a dropped RPC, a commitment that does not match. A paid request never fails because of
attestation. On success the seller logs the attestation tx hash and its Arbiscan link.
 
### Measured cost
 
From the receipts of real `attestReceipt` transactions sent by this seller on Arbitrum Sepolia (2026-10-02):
 
| run | tx | gas used | of which L1 data | effective gas price | fee |
| --- | --- | --- | --- | --- | --- |
| first `npm run pay` (receiptId 1) | [`0xeced00fb…`](https://sepolia.arbiscan.io/tx/0xeced00fbc5386ae54011e492b0b46668a9cce8654ee17d6dc0d3fcc96d00a910) | 78,236 | 6,146 | 0.040082 gwei | 0.0000031359 ETH |
| `npm run agent` (receiptId 3) | [`0x2ec3f8e3…`](https://sepolia.arbiscan.io/tx/0x2ec3f8e313fa6bb9bc4f9392994759d0a5f88a743d8cd60bba65489aa67783df) | 72,850 | 772 | 0.040098 gwei | 0.0000029211 ETH |
 
Without the L1 data component the two are within 12 gas of each other (72,090 and 72,078). The gap between
the runs is the L1 data component, which tracks the L1 price at the time and not anything the contract does.
 
These are receipt figures: they include the transaction's intrinsic cost, calldata and L1 data. The
54,826 gas in `notaxyz/contracts` `docs/benchmarks.md` is EVM execution of the call alone, measured with
`gasleft()` against cold state. It is not directly comparable, and adding fixed overheads to it does not
reproduce the receipt numbers.
 
### Verifying
 
```bash
npm run verify -- <purchaseRef> <analysis.json> [--seller 0x...] [--listing <id>]
```
 
This implements "Verifying a Receipt" from `notaxyz/contracts` `docs/receipt-mode-integration.md`, in order:
 
0. logs are filtered to the store address from the deployment record (and the RPC must be on chain 421614)
1. exactly one `ReceiptAttested` exists for the `purchaseRef` topic (plain `eth_getLogs`, no indexer)
2. the log's `seller` is the expected seller
3. `getListing(listingId).seller` on that store is the expected seller
4. `metadataHash` equals keccak256 over the analysis bytes exactly as received. They are hashed as-is,
   never parsed and re-serialized, so save the response body byte-for-byte (`npm run pay` and
   `npm run agent` write it to `.nota/received/<purchaseRef>.json`)
5. `paymentRef` is reported last and never used as a key. It is followed to its transaction only if 0–4 passed

It prints each step and an overall PASS or FAIL. On failure it names the failing step and the expected value.
It exits 0 on pass and 1 on fail.
 
**What a passing verification establishes, and what it does not.** It establishes that the expected seller,
at that block and on the Nota store from the deployment record, published a commitment to exactly these
bytes under this `purchaseRef`. Because the ref is single-use across the registry, the seller cannot now
claim it delivered something else for it. It does not prove the payment happened: `ReceiptAttested` is a
seller claim, and `paymentRef` is whatever the seller chose to put there. It does not prove delivery
happened either: a commitment to some bytes is not evidence that anyone received them. And it says
nothing about whether the analysis is correct. `buyer` in the log is
likewise only the seller's claim.
 