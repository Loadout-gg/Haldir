// Server/offline only: node:crypto and native SDK objects are NOT a JSON/browser transport.
import { createHash } from 'node:crypto';
import { actions } from 'near-api-js';
import { isDeepStrictEqual } from 'node:util';

const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const named = s => typeof s === 'string' && s === s.trim() && s.length >= 2 && s.length <= 64 &&
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(s);
function decimal(value, name, max) {
  if (typeof value !== 'string' || value.length > max.toString().length ||
      value !== value.trim() || !/^[1-9][0-9]*$/.test(value)) throw new Error(`INVALID_${name}`);
  const n = BigInt(value);
  if (n > max) throw new Error(`INVALID_${name}`);
  return n;
}

/** Approval is a separate trusted manifest, not reconstructed from the candidate request.
 * Requires the exact canonical native SDK representation, including ABI bytes and no extras.
 */
export function validateCreateJobRequest(request, approvedManifest) {
  const expected = prepareCreateJob(approvedManifest);
  if (!isDeepStrictEqual(request, expected)) throw new Error('UNAPPROVED_REQUEST');
  return true;
}

/** Input must come from independently approved immutable server storage, never browser fields. */
export function prepareCreateJob(m) {
  if (!m || m.network !== 'testnet' || !named(m.owner) || !named(m.agent) ||
      !named(m.factory) || !m.factory.endsWith('.testnet') || m.factory.length > 30 ||
      typeof m.job_label !== 'string' || m.job_label !== m.job_label.trim() || !/^[a-z0-9_-]{1,32}$/.test(m.job_label) ||
      !Array.isArray(m.allowlist) || m.allowlist.length < 1 || m.allowlist.length > 4 ||
      new Set(m.allowlist).size !== m.allowlist.length || ![...m.allowlist].every(named))
    throw new Error('INVALID_BINDING');
  if (!m.owner.endsWith('.testnet') && !/^[0-9a-f]{64}$/.test(m.owner))
    throw new Error('OWNER_CLASS_NOT_QUALIFIED');
  const child = 'j' + createHash('sha256').update(`${m.owner}:${m.job_label}`)
    .digest('hex').slice(0, 32) + '.' + m.factory;
  if (m.mandate !== child || m.owner === m.agent || m.owner === child || m.agent === child ||
      m.allowlist.some(x => [m.owner, m.agent, child].includes(x))) throw new Error('ROLES');
  const cap = decimal(m.cap, 'CAP', U128_MAX);
  const float = decimal(m.operating_float, 'FLOAT', U128_MAX);
  const gas = decimal(m.create_gas, 'GAS', U64_MAX);
  decimal(m.deadline_ns, 'DEADLINE', U64_MAX);
  if (cap > 100n * 10n ** 24n || cap + float > U128_MAX ||
      gas < 200_000_000_000_000n || gas > 300_000_000_000_000n) throw new Error('LIMIT');
  return {
    id: 'near::sign_transactions',
    input: {
      target: { blockchain: 'near', network: 'testnet', accountId: m.owner },
      useFunctionCallKey: false,
      transactions: [{ receiverId: m.factory, actions: [actions.functionCall('create_job', {
        job_label: m.job_label, agent: m.agent, allowlist: [...m.allowlist],
        cap: m.cap, deadline_ns: m.deadline_ns, operating_float: m.operating_float,
      }, gas, cap + float)] }],
    },
  };
}
