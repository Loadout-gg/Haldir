import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { KeyPair } from 'near-api-js';
import { compileManifest } from './manifest.mjs';
export const artifacts = async () => ({
  mandate: await readFile(new URL('../../target/mandate-wasm/u01_mandate_proof.wasm', import.meta.url)),
  factory: await readFile(new URL('../../target/mandate-factory-wasm/u01_mandate_factory.wasm', import.meta.url)),
});
export const fixture = () => ({ network: 'testnet', rpc: 'https://rpc.testnet.near.org',
  provisioner: 'bootstrap.testnet', factory: 'f.bootstrap.testnet', agent: 'a.bootstrap.testnet',
  owner: 'owner.testnet', allowlist: ['vendor.testnet'], job_label: 'qualification',
  bootstrap_public_key: KeyPair.fromRandom('ed25519').getPublicKey().toString(),
  agent_public_key: KeyPair.fromRandom('ed25519').getPublicKey().toString(),
  cap: '1000000000000000000000000', operating_float: '2000000000000000000000000',
  agent_funding: '1000000000000000000000000', allowance: '600000000000000000000000',
  factory_funding: '4000000000000000000000000', factory_gas_reserve: '1000000000000000000000000',
  provisioner_gas_reserve: '2000000000000000000000000', owner_gas_reserve: '2000000000000000000000000',
  max_total_outlay: '20000000000000000000000000', max_jobs: 4,
  deadline_ns: '2000003600000000000', create_gas: '300000000000000',
});
export const protocol = { chain_id: 'testnet', block_hash: 'synthetic-block-only', block_height: 1,
  timestamp_nanosec: '2000000000000000000', protocol_version: 88,
  storage_amount_per_byte: '10000000000000000000', account_overhead: 100, record_overhead: 40,
  gas_price: '100000000', min_gas_purchase_price:'1000000000', account_creation_charge:'7000000000000000000000', rpc: 'https://rpc.testnet.near.org' };
test('manifest freezes exact factory/agent/owner transactions with finite bounds', async () => {
  const m = compileManifest(fixture(), protocol, await artifacts());
  assert.ok(m && m.schema === 'haldir-testnet-provisioning-v1');
  assert.equal(m.steps.length, 3);
  assert.deepEqual(m.steps.map(s => s.kind), ['factory_create', 'factory_finalize', 'agent_create']);
  assert.deepEqual(m.steps[2].actions[2].permission, { receiver_id: m.mandate, method_names: ['pay'], allowance: m.spec.allowance });
  assert.equal(m.owner_create.signer_id, m.spec.owner);
  assert.equal(String(BigInt(Date.parse(m.job_expires_at))*1_000_000n),m.spec.deadline_ns);
  assert.equal(m.owner_create.actions[0].deposit, String(BigInt(m.spec.cap) + BigInt(m.spec.operating_float)));
  assert.ok(BigInt(m.budget.total_outlay) <= BigInt(m.spec.max_total_outlay));
  assert.equal(m.artifacts.mandate.sha256, 'bad53857b2e2f45d2b6947c3c14f4e1d595918cc1d70d7f034549e20169ea12f');
});
test('allowance must fund at least one bounded pay at protocol gas-purchase floor', async () => {
  const bytes = await artifacts();
  assert.throws(()=>compileManifest({...fixture(),allowance:'1'},protocol,bytes),/ALLOWANCE_TOO_SMALL/);
});
test('deadline must be millisecond aligned for the unchanged native executor expiry binding',async()=>{
  const bytes=await artifacts();
  assert.throws(()=>compileManifest({...fixture(),deadline_ns:'2000003600000000001'},protocol,bytes),/RUNTIME_DEADLINE_ALIGNMENT/);
});
test('rejects mainnet, owner bootstrap, noncanonical money, uncapped key, role collision and artifact drift', async () => {
  const bytes=await artifacts(), base=fixture();
  for(const delta of [{network:'mainnet'},{provisioner:base.owner},{cap:'01'},{allowance:null},{agent_public_key:base.bootstrap_public_key},{max_total_outlay:'1'},{operating_float:'1'},{factory_funding:'1'},{max_jobs:257},{extra:'forbidden'}])
    assert.throws(()=>compileManifest({...base,...delta},protocol,bytes));
  assert.throws(()=>compileManifest(base,{...protocol,storage_amount_per_byte:'1'},bytes),/UNQUALIFIED_STORAGE_PROTOCOL/);
  assert.throws(()=>compileManifest(base,protocol,{...bytes,mandate:Buffer.from('bad')}),/ARTIFACT_HASH/);
});
