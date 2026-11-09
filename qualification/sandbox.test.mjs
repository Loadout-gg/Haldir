import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox, GenesisAccount } from 'near-sandbox';
import { Account, JsonRpcProvider, actions } from 'near-api-js';
import { readFile } from 'node:fs/promises';

// Only an ephemeral local chain. No user wallet or remote RPC is accepted.
test('compiled WASM executes through a real local Sandbox transaction', async () => {
  assert.equal(process.versions.node, '26.13.0');
  const sandbox = await Sandbox.start({ version: '2.14.0' });
  try {
    assert.equal(new URL(sandbox.rpcUrl).hostname, '127.0.0.1');
    const genesis = GenesisAccount.createDefault();
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const account = new Account(genesis.accountId, provider, genesis.privateKey);
    const wasm = await readFile(new URL('../target/qualification/u01_toolchain_probe.wasm', import.meta.url));
    await account.signAndSendTransaction({
      receiverId: account.accountId,
      actions: [actions.deployContract(wasm)],
    });
    const result = await account.callFunction({
      contractId: account.accountId,
      methodName: 'answer',
      args: {},
      gas: 30000000000000n,
      deposit: 0n,
    });
    assert.equal(result, 42);
  } finally {
    await sandbox.tearDown();
  }
});
