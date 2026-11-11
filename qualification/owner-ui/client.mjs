// Local qualification only. No submission or intent generation is implemented.
import { actions, encodeDelegateAction, encodeSignedDelegate, PublicKey } from 'near-api-js';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function units(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid qualification units.');
  return BigInt(value);
}
export function toDelegateAction(generated) {
  const payload = generated?.intent?.payload;
  if (!payload || typeof payload.receiverId !== 'string' || !payload.receiverId || !Array.isArray(payload.actions) || payload.actions.length !== 2) throw new Error('Invalid qualification payload.');
  const methods = ['store_wallet_policy', 'freeze_wallet'];
  return {
    receiverId: payload.receiverId,
    actions: payload.actions.map((action, index) => {
      const p = action.params;
      if (action.type !== 'FunctionCall' || p?.methodName !== methods[index] || !p.args || typeof p.args !== 'object' || Array.isArray(p.args)) throw new Error('Invalid qualification action.');
      return actions.functionCall(p.methodName, new TextEncoder().encode(JSON.stringify(p.args)), units(p.gas), units(p.deposit));
    }),
  };
}
export function prepareBootstrap(source) {
  const boot = structuredClone(source);
  const { generated: g, expectedOwner: owner } = boot || {};
  const policy = g?.preview?.policy;
  const empty = value => Array.isArray(value) && value.length === 0;
  if (!owner?.account_id || !owner.public_key || g?.type !== 'agent_create' || g?.status !== 'PENDING_SIGNATURE' ||
      g.signer?.type !== 'near' || g.signer.account_id !== owner.account_id || g.signer.public_key !== owner.public_key ||
      g.intent?.standard !== 'nep366' || !Number.isFinite(Date.parse(g.expires_at)) ||
      policy?.frozen !== true || !empty(policy.actions) || !empty(policy.assets) ||
      policy.destinations?.mode !== 'only' || !empty(policy.destinations.list) ||
      !['daily_usd', 'weekly_usd', 'monthly_usd'].every(key => policy.budget?.[key] === '0') ||
      typeof boot.csrfToken !== 'string' || !boot.csrfToken || typeof boot.canSign !== 'boolean') {
    throw new Error('The local qualification record is invalid. Signing is blocked.');
  }
  toDelegateAction(g);
  return freeze(boot);
}
export function signedData(boot, output) {
  const rows = output?.signedDelegatesWithHashes;
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]?.signedDelegate?.delegateAction) throw new Error('Unexpected wallet response.');
  const signed = rows[0].signedDelegate;
  // Borsh returns a plain enum, not a PublicKey instance. Normalize only the
  // ed25519 variant and validate bytes before Uint8Array can coerce anything.
  const raw = signed.delegateAction;
  const key = raw.publicKey;
  const data = key?.ed25519Key?.data;
  if ((!Array.isArray(data) && !(data instanceof Uint8Array)) || data.length !== 32 ||
      !Array.from(data).every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) ||
      (key instanceof PublicKey ? key.keyType !== 0 || key.enum !== 'ed25519Key' ||
        key.secp256k1Key !== undefined || key.mlDsa65Key !== undefined :
        Object.getPrototypeOf(key) !== Object.prototype || Object.keys(key).join(',') !== 'ed25519Key' ||
        Object.keys(key.ed25519Key).join(',') !== 'data')) throw new Error('Wallet public key does not match the expected ed25519 key.');
  const delegate = { ...raw, publicKey: new PublicKey({ keyType: 0, data: Uint8Array.from(data) }) };
  const expected = toDelegateAction(boot.generated);
  if (delegate.senderId !== boot.expectedOwner.account_id || delegate.receiverId !== expected.receiverId || delegate.publicKey?.toString() !== boot.expectedOwner.public_key) throw new Error('Wallet signature does not match the expected owner or payload.');
  const actualBytes = encodeDelegateAction(delegate);
  const expectedBytes = encodeDelegateAction({ ...delegate, ...expected });
  if (actualBytes.length !== expectedBytes.length || actualBytes.some((byte, index) => byte !== expectedBytes[index])) throw new Error('Wallet actions do not match the preview.');
  const bytes = encodeSignedDelegate({ ...signed, delegateAction: delegate });
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { ...boot.generated.intent, signed_delegate: btoa(binary) };
}
export function memoryStorage() {
  const values = new Map();
  return {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
    async getKeys(prefix = '') { return [...values.keys()].filter(key => key.startsWith(prefix)); },
  };
}
let walletPromise;
export async function getWallet() {
  if (!walletPromise) walletPromise = (async () => {
    const { MeteorConnect } = await import('@meteorwallet/sdk');
    const wallet = new MeteorConnect({ isDev: false });
    wallet.setLoggingLevel('none');
    // No function-call keys are requested or retained by this utility.
    const noKeys = {
      async getKey() { return null; },
      async setKey() { throw new Error('Local key storage is disabled.'); },
      async removeKey() {}, async clear() {},
      async getNetworks() { return []; }, async getAccounts() { return []; },
    };
    await wallet.initialize({ storage: memoryStorage(), mobileBridge: { enabled: false }, nearKeyStoreProvider: { getKeyStore: () => noKeys } });
    return wallet;
  })().catch(error => { walletPromise = undefined; throw new Error('Wallet initialization failed.', { cause: error }); });
  return walletPromise;
}
function walletError(error, operation) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/cancel|reject|denied|closed/i.test(message)) return 'Wallet request cancelled. Nothing was saved.';
  return `${operation} failed. Nothing was saved. Check Meteor and try again.`;
}
export function createController(source, { wallet = getWallet, fetcher = globalThis.fetch, clock = Date.now, onChange = () => {} } = {}) {
  const bootstrap = prepareBootstrap(source);
  let account = null, busy = false, saved = false, uncertainSave = false, notice = '';
  const snapshot = () => ({ account, busy, saved, notice, block: uncertainSave ? 'Local save outcome unconfirmed. Check the local record before any further signing.' : saved ? 'Signature already saved locally. Submission not enabled.' : signingBlock(bootstrap, account, clock()) });
  const changed = () => onChange(snapshot());
  return {
    bootstrap, snapshot,
    async connect() {
      if (busy || saved || uncertainSave) return false;
      busy = true; account = null; notice = 'Waiting for an account-only Meteor connection…'; changed();
      try {
        const connector = await wallet();
        const action = await connector.createAction({ id: 'near::sign_in', input: { target: { blockchain: 'near', network: 'mainnet' } } });
        const returned = await action.promptForExecution();
        if (returned?.identifier?.blockchain !== 'near' || returned.identifier.network !== 'mainnet' || returned.identifier.accountId !== bootstrap.expectedOwner.account_id) {
          notice = 'Wrong account or network. Connect the expected NEAR mainnet owner.';
          return false;
        }
        account = freeze({ identifier: structuredClone(returned.identifier) });
        notice = 'Expected mainnet owner connected. No transaction was requested.';
        return true;
      } catch (error) { notice = walletError(error, 'Connection'); return false; }
      finally { busy = false; changed(); }
    },
    async sign() {
      if (busy || saved || uncertainSave) return false;
      const blocked = signingBlock(bootstrap, account, clock());
      if (blocked) { notice = blocked; changed(); return false; }
      busy = true; notice = 'Waiting for delegate-signature approval in Meteor…'; changed();
      let saving = false;
      try {
        const connector = await wallet();
        // Recheck after SDK initialization and again after wallet approval.
        if (signingBlock(bootstrap, account, clock())) { notice = signingBlock(bootstrap, account, clock()); return false; }
        const action = await connector.createAction({ id: 'near::sign_delegate_actions', input: { target: { ...account.identifier }, delegateActions: [toDelegateAction(bootstrap.generated)] } });
        if (signingBlock(bootstrap, account, clock())) { notice = signingBlock(bootstrap, account, clock()); return false; }
        const output = await action.promptForExecution();
        const expired = signingBlock(bootstrap, account, clock());
        if (expired) { notice = expired; return false; }
        const signed_data = signedData(bootstrap, output);
        notice = 'Saving the signature to this local server only…'; changed();
        saving = true;
        const response = await fetcher('/api/signature', {
          method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrfToken },
          body: JSON.stringify({ signed_data }), signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error('Local save was not confirmed.');
        saved = true; notice = 'Signature saved locally. Submission not enabled.';
        return true;
      } catch (error) {
        if (saving) { uncertainSave = true; notice = 'Local save outcome unconfirmed. Nothing was submitted. Check the local record before any further signing.'; }
        else notice = walletError(error, 'Signing');
        return false;
      }
      finally { busy = false; changed(); }
    },
  };
}

export function signingBlock(bootstrap, account, now = Date.now()) {
  const expiry = Date.parse(bootstrap?.generated?.expires_at);
  if (!Number.isFinite(expiry) || now >= expiry) return 'Intent expired. Signing is blocked; regeneration is not available here.';
  if (bootstrap?.canSign !== true) return 'Signing is blocked by the local server.';
  if (!account) return 'Connect the expected owner before signing.';
  if (account.identifier?.blockchain !== 'near' || account.identifier?.network !== 'mainnet') return 'A NEAR mainnet account is required.';
  if (account.identifier.accountId !== bootstrap?.expectedOwner?.account_id) return 'Connected account does not match the expected owner.';
  return null;
}

// Render upstream values only as text, never as markup or URLs.
export async function mountOwnerUi(doc, { fetcher = globalThis.fetch, origin = globalThis.location?.origin } = {}) {
  const byId = id => doc.getElementById(id);
  const text = (id, value) => { byId(id).textContent = value; };
  if (origin !== 'http://127.0.0.1:4173') {
    text('load-status', 'Blocked: open this qualification utility at http://127.0.0.1:4173 only.');
    return null;
  }
  let controller;
  const render = state => {
    byId('connect').disabled = state.busy || state.saved || /unconfirmed/i.test(state.block || '');
    byId('sign').disabled = state.busy || Boolean(state.block);
    byId('signing-section').setAttribute('aria-busy', String(state.busy));
    text('connect', state.account ? 'Reconnect Meteor' : 'Connect Meteor');
    text('sign', state.saved ? 'Saved locally' : 'Sign & save locally');
    text('connected-account', state.account ? `${state.account.identifier.accountId} · mainnet` : 'Not connected');
    text('sign-help', state.block || 'Ready for your explicit delegate signature. The server saves and verifies only; it does not submit.');
    text('notice', state.notice);
    const expired = Date.now() >= Date.parse(controller.bootstrap.generated.expires_at);
    text('intent-state', expired ? 'Expired — signing blocked. This intent will not be regenerated here.' : controller.bootstrap.canSign ? 'Fixed intent loaded — review before connecting.' : 'Signing blocked by the local server.');
    byId('intent-state').dataset.kind = expired || !controller.bootstrap.canSign ? 'blocked' : 'ready';
  };
  try {
    const response = await fetcher('/api/intent', { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Local intent unavailable.');
    controller = createController(await response.json(), { fetcher, onChange: render });
    const { generated: g, expectedOwner: owner } = controller.bootstrap;
    const policy = g.preview.policy;
    text('owner-account', owner.account_id);
    text('owner-key', owner.public_key);
    text('intent-id', g.correlation_id || 'Not provided');
    text('agent-id', g.agent_id || 'Not provided');
    text('expiry', new Date(g.expires_at).toISOString());
    byId('expiry').setAttribute('datetime', g.expires_at);
    text('policy-frozen', policy.frozen ? 'Frozen' : 'Not frozen');
    text('policy-budgets', `Daily ${policy.budget.daily_usd} USD · weekly ${policy.budget.weekly_usd} USD · monthly ${policy.budget.monthly_usd} USD`);
    text('policy-actions', `None (${policy.actions.length} allowed)`);
    text('policy-recipients', `None (${policy.destinations.list.length} allowed; allowlist only)`);
    text('policy-assets', `None (${policy.assets.length} configured)`);
    text('receiver', g.intent.payload.receiverId);
    const rows = byId('call-rows');
    rows.replaceChildren();
    let deposit = 0n;
    for (const action of g.intent.payload.actions) {
      const row = doc.createElement('tr');
      for (const value of [action.params.methodName, action.params.gas, action.params.deposit]) {
        const cell = doc.createElement('td');
        const code = doc.createElement('code');
        code.textContent = value;
        cell.append(code); row.append(cell);
      }
      rows.append(row);
      deposit += BigInt(action.params.deposit);
    }
    text('deposit-total', deposit.toString());
    text('payload', JSON.stringify(g.intent, null, 2));
    byId('review').hidden = false;
    byId('load-status').hidden = true;
    byId('connect').addEventListener('click', () => { void controller.connect(); });
    byId('sign').addEventListener('click', () => { void controller.sign(); });
    render(controller.snapshot());
    // Recompute time-based eligibility without fetching or regenerating the intent.
    let lastBlock = controller.snapshot().block;
    const timer = setInterval(() => {
      const state = controller.snapshot();
      if (state.block !== lastBlock) { lastBlock = state.block; render(state); }
    }, 1000);
    doc.defaultView?.addEventListener('pagehide', () => clearInterval(timer), { once: true });
    doc.addEventListener('visibilitychange', () => render(controller.snapshot()));
    return controller;
  } catch {
    text('load-status', 'The fixed local intent could not be loaded or validated. Signing is disabled. Check the local server and record; no regeneration was attempted.');
    byId('connect').disabled = true;
    byId('sign').disabled = true;
    return null;
  }
}
if (typeof document !== 'undefined') void mountOwnerUi(document);
