import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalRepository } from '../../src/server/orders.mjs';

test('LOCAL SQLite commits exact records, rolls back failed writes, and reopens durable data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'haldir-repository-'));
  const filename = join(dir, 'journey.sqlite');
  let repo = openLocalRepository({ filename, localTestOnly: true });
  try {
    const value = { ownerId: 'alice.testnet', amountAtomic: '3000000000000000000000000' };
    assert.deepEqual(await repo.runTransaction(async tx => {
      assert.equal(await tx.get('jobs', 'one'), null);
      tx.create('jobs', 'one', value);
      return value;
    }), value);
    await assert.rejects(repo.runTransaction(async tx => {
      assert.deepEqual(await tx.get('jobs', 'one'), value);
      tx.set('jobs', 'one', { ...value, ownerId: 'wrong.testnet' });
      tx.create('claims', 'receipt', { quoteId: 'one' });
      throw new Error('injected transaction abort');
    }), /injected transaction abort/);
    repo.close();
    repo = openLocalRepository({ filename, localTestOnly: true });
    assert.deepEqual(await repo.runTransaction(tx => tx.get('jobs', 'one')), value);
    assert.equal(await repo.runTransaction(tx => tx.get('claims', 'receipt')), null);
    await assert.rejects(repo.runTransaction(tx => { tx.create('jobs', 'one', {}); }), /already exists/);
    await assert.rejects(repo.runTransaction(tx => {
      tx.create('claims', 'must-roll-back-after-SQL-insert', { quoteId: 'one' });
      tx.create('jobs', 'one', {}); // fails after the first INSERT executed
    }), /already exists/);
    assert.equal(await repo.runTransaction(tx => tx.get('claims', 'must-roll-back-after-SQL-insert')), null);
    assert.deepEqual(await repo.runTransaction(tx => tx.get('jobs', 'one')), value);
    await assert.rejects(repo.runTransaction(async tx => {
      tx.set('jobs', 'one', {});
      await tx.get('jobs', 'one');
    }), /reads must precede writes/);
  } finally { repo.close(); await rm(dir, { recursive: true, force: true }); }
});
