import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentApi, AgentApiRequestError } from '@near-intents-agent-api/sdk';

const agentId = 'a'.repeat(64);
const request = { asset: 'fixture:usdc', amount: '80000', recipient: 'vendor.near', confidential: false };

test('separate grant clients preserve explicit request identity', async () => {
  const seen = [];
  const api = createAgentApi({
    apiKey: 'synthetic-partner-key',
    baseUrl: 'http://localhost',
    fetch: async (url, init) => {
      seen.push({ url: String(url), init });
      return Response.json({ correlation_id: `op_${'x'.repeat(43)}`, status: 'PROCESSING' }, { status: 202 });
    },
  });
  await api.forGrant(('ngt_' + 'a'.repeat(43))).transfer(agentId, request, { idempotencyKey: 'order-0001' });
  await api.forGrant(('ngt_' + 'b'.repeat(43))).transfer(agentId, request, { idempotencyKey: 'order-0002' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, `http://localhost/v1/agents/${agentId}/transfer`);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(new Headers(seen[0].init.headers).get('x-grant-token'), ('ngt_' + 'a'.repeat(43)));
  assert.equal(new Headers(seen[1].init.headers).get('x-grant-token'), ('ngt_' + 'b'.repeat(43)));
  assert.equal(new Headers(seen[0].init.headers).get('idempotency-key'), 'order-0001');
  assert.deepEqual(JSON.parse(seen[0].init.body), request);
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.credentials, 'omit');
});

test('transport failure keeps identity and does not auto-retry', async () => {
  let calls = 0;
  const api = createAgentApi({
    apiKey: 'synthetic-partner-key', baseUrl: 'http://localhost',
    fetch: async () => { calls++; throw new TypeError('synthetic lost response'); },
  });
  await assert.rejects(
    api.forGrant(('ngt_' + 'c'.repeat(43))).transfer(agentId, request, { idempotencyKey: 'order-0003' }),
    error => error instanceof AgentApiRequestError && error.idempotencyKey === 'order-0003',
  );
  assert.equal(calls, 1);
});
