import { baseEncode } from 'near-api-js';
import { createHash } from 'node:crypto';

/**
 * LOCAL SYNTHETIC EVIDENCE ONLY, not captured chain data/publicchainproof.
 * Derived from syntheticPayment in tests/vendor/payment-proof.test.mjs.
 * This intentionally fabricates a receipt graph for offline integration tests;
 * only payment-proof.mjs validates it. Never use as an RPC/financial adapter.
 */
export function syntheticPayment(input, seed = 1) {
  if (!Number.isInteger(seed) || seed < 1 || seed > 240) throw new Error('synthetic seed out of range');
  const quote = structuredClone(input);
  const hash = n => baseEncode(new Uint8Array(32).fill(n + seed - 1));
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
  const pay = { FunctionCall: { method_name: 'pay', args: encode({ order_id: quote.orderId,
    recipient: quote.vendorId, amount: quote.amountAtomic }), deposit: '0', gas: 100_000_000_000_000 } };
  const signer = 'agent.testnet', publicKey = `ed25519:${hash(8)}`;
  const outcome = (n, executor, children, status = { SuccessValue: '' }) => ({ id: hash(n), block_hash: hash(9),
    outcome: { executor_id: executor, receipt_ids: children.map(hash), status, logs: [], gas_burnt: 0, tokens_burnt: '0' }, proof: [] });
  const receipt = (n, predecessor, receiver, list, input = [], output = []) => ({ receipt_id: hash(n),
    predecessor_id: predecessor, receiver_id: receiver, receipt: { Action: { actions: list,
      signer_id: signer, signer_public_key: publicKey, gas_price: '1000000000',
      input_data_ids: input, output_data_receivers: output } } });
  const finalTransaction = { final_execution_status: 'FINAL', status: { SuccessValue: encode(true) },
    transaction: { hash: hash(1), signer_id: signer, public_key: publicKey, receiver_id: quote.mandateId, actions: [pay] },
    transaction_outcome: outcome(1, signer, [2], { SuccessReceiptId: hash(2) }),
    receipts_outcome: [outcome(2, quote.mandateId, [3, 4], { SuccessReceiptId: hash(4) }),
      outcome(3, quote.vendorId, []), outcome(4, quote.mandateId, [], { SuccessValue: encode(true) })] };
  const receipts = [receipt(2, signer, quote.mandateId, [pay]),
    receipt(3, quote.mandateId, quote.vendorId, [{ Transfer: { deposit: quote.amountAtomic } }], [],
      [{ data_id: hash(5), receiver_id: quote.mandateId }]),
    receipt(4, quote.mandateId, quote.mandateId, [{ FunctionCall: { method_name: 'on_payment',
      args: encode({ order_id: quote.orderId }), deposit: '0', gas: 20_000_000_000_000 } }], [hash(5)])];
  return { quote, evidence: { networkId: quote.networkId, finalTransaction, receipts } };
}

/** Pure deterministic sample builder. Persist its result before returning it. */
export function fictionalArtifact({ quoteId, quote }) {
  const requested = `Northwind is a fictional supplier sample, not a real company finding. Requested sample: ${quote.content ?? 'supplier verification'}.`;
  // Delivery receives the immutable quote, not its TS1 source label. Select only
  // these exact, explicitly fictional descriptions; do not infer from vendor IDs
  // or upgrade arbitrary/legacy quote text into this finite Northwind case.
  let document = '';
  switch (quote.content) {
    case 'Northwind fictional sample: company-records':
      document = 'Company record: Legal name: Northwind Print Ltd (fictional). Registration: NW-FICTION-2048. Registered address: 14 Paper Lane, Testhaven (fictional address). These are declared sample details, not a registry verification.';
      break;
    case 'Northwind fictional sample: background-research':
      document = [
        'Research note: The sample supplier questionnaire lists registration NW-FICTION-2048 and site address 14 Paper Lane, Testhaven; these match the company record, but delivery capacity is self-reported at 12,000 cartons per month.',
        'Certification gap: ISO 9001 certificate number, issuer and expiry are not documented in either sample; certification cannot be confirmed.',
        "Next check: Before signing, request the ISO 9001 certificate number, issuer and expiry, then compare the certificate's legal name and site address with registration NW-FICTION-2048 at 14 Paper Lane, Testhaven."
      ].join('\n');
      break;
  }
  const content = document ? `${requested}\n${document}` : requested;
  return { artifactId: `fictional:${quoteId}`, orderId: quote.orderId, vendorId: quote.vendorId,
    fictionalSample: true, qualification: 'LOCAL_SYNTHETIC_ONLY', mediaType: 'text/plain',
    content, contentDigest: createHash('sha256').update(content).digest('hex') };
}
