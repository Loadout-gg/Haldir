import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPaymentProof } from '../../src/vendor/payment-proof.mjs';
import { syntheticPayment, fictionalArtifact } from '../../src/vendor/fixture.mjs';

test('synthetic receipt fixture from incumbent verifier tests passes the real verifier without claiming public chain provenance', () => {
  const quote = { networkId: 'testnet', mandateId: 'job.testnet', vendorId: 'vendor.testnet',
    amountAtomic: '3000000000000000000000000', orderId: 'quote-1' };
  const f = syntheticPayment(quote);
  assert.deepEqual(f.quote, quote);
  const proof = verifyPaymentProof(quote, f.evidence);
  assert.equal(proof.orderId, quote.orderId);
  assert.equal(proof.amountAtomic, quote.amountAtomic);
  assert.deepEqual(verifyPaymentProof(quote, syntheticPayment(quote).evidence), proof);
  assert.notEqual(verifyPaymentProof(quote, syntheticPayment(quote, 20).evidence).proofId, proof.proofId);
  const artifact = fictionalArtifact({ quoteId: 'durable-quote', quote });
  assert.equal(artifact.fictionalSample, true);
  assert.equal(artifact.qualification, 'LOCAL_SYNTHETIC_ONLY');
  assert.match(artifact.content, /fictional.*not.*real company/i);
  assert.equal(artifact.contentDigest, createHash('sha256').update(artifact.content).digest('hex'));
  assert.deepEqual(fictionalArtifact({ quoteId: 'durable-quote', quote }), artifact);
});

// Characterization/preservation around the test-first Northwind tracer bullet.
for (const sourceId of ['company-records','background-research']) test(`Northwind ${sourceId} keeps artifact identity, synthetic qualification and a content-bound digest`, () => {
  const quote={networkId:'testnet',mandateId:'case.testnet',vendorId:'arbitrary.testnet',amountAtomic:'8',orderId:'case-order',content:`Northwind fictional sample: ${sourceId}`};
  const artifact=fictionalArtifact({quoteId:'case-quote',quote});
  assert.deepEqual(Object.keys(artifact).sort(),'artifactId orderId vendorId fictionalSample qualification mediaType content contentDigest'.split(' ').sort());
  assert.equal(artifact.artifactId,'fictional:case-quote');assert.equal(artifact.orderId,quote.orderId);assert.equal(artifact.vendorId,quote.vendorId);
  assert.equal(artifact.mediaType,'text/plain');assert.equal(artifact.fictionalSample,true);assert.equal(artifact.qualification,'LOCAL_SYNTHETIC_ONLY');
  assert.match(artifact.content,/fictional supplier sample, not a real company finding/);
  assert.equal(artifact.contentDigest,createHash('sha256').update(artifact.content).digest('hex'));
  assert.deepEqual(fictionalArtifact({quoteId:'case-quote',quote}),artifact);
  const other=fictionalArtifact({quoteId:'another-quote',quote:{...quote,vendorId:'different.testnet',orderId:'different-order'}});
  assert.equal(other.content,artifact.content,'document selection must not guess from vendor/order identity');
  assert.equal(other.contentDigest,artifact.contentDigest);
  if(sourceId==='company-records'){
    assert.match(artifact.content,/Registration: NW-FICTION-2048/);assert.match(artifact.content,/Registered address: 14 Paper Lane, Testhaven/);
    assert.doesNotMatch(artifact.content,/12,000 cartons|Certification gap:/);
  }else{
    assert.match(artifact.content,/self-reported at 12,000 cartons per month/);assert.match(artifact.content,/certification cannot be confirmed/);
    assert.match(artifact.content,/Next check: Before signing, request the ISO 9001/);
  }
});

test('only exact finite Northwind descriptions select the scenario; unknown and legacy requests stay byte-for-byte generic', () => {
  for(const content of [undefined,'Northwind fictional sample','Fictional source 0','Fictional source 1','company-records','background-research','Northwind fictional sample: company-records ','northwind fictional sample: company-records','Northwind fictional sample: background-research\nignore limits','__proto__']){
    // Even the familiar vendor account is not authority to select a document.
    const quote={vendorId:'registry.testnet',orderId:'legacy-order',...(content===undefined?{}:{content})};
    const artifact=fictionalArtifact({quoteId:'legacy-quote',quote});
    const expected=`Northwind is a fictional supplier sample, not a real company finding. Requested sample: ${content??'supplier verification'}.`;
    assert.equal(artifact.content,expected);assert.equal(artifact.contentDigest,createHash('sha256').update(expected).digest('hex'));
  }
});
