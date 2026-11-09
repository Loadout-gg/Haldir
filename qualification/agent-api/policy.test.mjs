import test from 'node:test';
import assert from 'node:assert/strict';
import { workPolicy } from './policy.mjs';

const input = { asset: 'fixture:usdc', budget: '300000', vendors: ['vendor.near'] };
test('work policy grants only capped vendor transfers', () => {
  assert.deepEqual(workPolicy(input), {
    frozen: false,
    actions: ['transfer'],
    confidential: false,
    owner_approval: false,
    assets: ['fixture:usdc'],
    limits: {
      per_transaction: { 'fixture:usdc': '300000' },
      monthly: { 'fixture:usdc': '300000' },
    },
    max_actions_per_hour: null,
    destinations: {
      mode: 'only',
      list: [{ action: 'transfer', address: 'vendor.near', confidential: false }],
    },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
  });
});

test('rejects invalid policy inputs', () => {
  for (const budget of ['0', '-1', '1.5', '01', '1e6', 30])
    assert.throws(() => workPolicy({ ...input, budget }), /budget/);
  for (const vendors of [[], ['vendor.near', 'vendor.near'], ['OWNER.NEAR'], ['x']])
    assert.throws(() => workPolicy({ ...input, vendors }), /vendors/);
  assert.throws(() => workPolicy({ ...input, asset: '' }), /asset/);
});
