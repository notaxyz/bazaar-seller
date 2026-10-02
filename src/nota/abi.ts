import { parseAbi } from 'viem';

/** The subset of NotaReceiptStore (notaxyz/contracts src/NotaReceiptStore.sol) this repo calls. */
export const notaReceiptStoreAbi = parseAbi([
  'struct Listing { address seller; bytes32 listingHash; uint256 unitPrice; bool active; uint8 mode; }',
  'function attestReceipt(uint256 listingId, address buyer, bytes32 purchaseRef, bytes32 metadataHash, bytes32 agentId, bytes32 paymentRef) returns (uint256 receiptId)',
  'function getListing(uint256 listingId) view returns (Listing)',
  'function hashPurchaseRef(address seller, uint256 listingId, string rawPurchaseRef, bytes32 purchaseRefNonce) view returns (bytes32)',
  'function SETTLEMENT_TOKEN() view returns (address)',
  'function PURCHASE_REF_REGISTRY() view returns (address)',
  'function purchasesPaused() view returns (bool)',
  'event ReceiptAttested(uint256 receiptId, address indexed seller, address indexed buyer, uint256 listingId, bytes32 indexed purchaseRef, bytes32 metadataHash, bytes32 agentId, bytes32 paymentRef)',
  'error ListingNotFound()',
  'error NotListingSeller()',
  'error ListingInactive()',
  'error InvalidParams()',
  'error InvalidPurchaseRef()',
  'error PurchaseRefAlreadyUsed()',
  'error PurchasesPaused()',
]);
