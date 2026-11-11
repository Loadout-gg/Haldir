import { createServer } from 'node:http';
import { randomBytes, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { deserialize, serialize } from 'borsh';
import { SCHEMA, PublicKey, actions, encodeDelegateAction } from 'near-api-js';

function validateSignature(signed, generated, expectedOwner) {
  if (!signed || Object.keys(signed).sort().join(',') !== 'payload,signed_delegate,standard' ||
      signed.standard !== 'nep366' || !isDeepStrictEqual(signed.payload, generated.intent.payload)) throw Error('signature_invalid');
  const encoded = signed.signed_delegate;
  if (typeof encoded !== 'string' || encoded.length > 350000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw Error('signature_invalid');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw Error('signature_invalid');
  const parsed = deserialize(SCHEMA.SignedDelegate, bytes);
  if (!Buffer.from(serialize(SCHEMA.SignedDelegate, parsed)).equals(bytes)) throw Error('signature_invalid');
  const d = parsed.delegateAction;
  const publicKey = PublicKey.fromString(expectedOwner.public_key);
  const expected = {
    senderId: expectedOwner.account_id, receiverId: generated.intent.payload.receiverId,
    nonce: d.nonce, maxBlockHeight: d.maxBlockHeight, publicKey,
    actions: generated.intent.payload.actions.map(({type,params:a}) => {
      if (type !== 'FunctionCall') throw Error('signature_invalid');
      return actions.functionCall(a.methodName, Buffer.from(JSON.stringify(a.args)), BigInt(a.gas), BigInt(a.deposit));
    }),
  };
  if (!Buffer.from(encodeDelegateAction(expected)).equals(Buffer.from(encodeDelegateAction(d)))) throw Error('signature_invalid');
  const signature = parsed.signature.ed25519Signature?.data;
  if (!signature) throw Error('signature_invalid');
  const key = createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(publicKey.data)])});
  const digest = createHash('sha256').update(encodeDelegateAction(d)).digest();
  if (!verify(null, digest, key, Buffer.from(signature))) throw Error('signature_invalid');
}

export function createOwnerServer(options) {
  const { now = Date.now, saveSignature, html = '', bundle = '', initialSaveBlocked = false } = options;
  const generated = structuredClone(options.generated);
  const expectedOwner = structuredClone(options.expectedOwner);
  if (generated.type !== 'agent_create' || generated.intent?.standard !== 'nep366' ||
      generated.signer?.account_id !== expectedOwner.account_id || generated.signer?.public_key !== expectedOwner.public_key) throw Error('owner_intent_mismatch');
  const csrfToken = randomBytes(32).toString('hex');
  let saving = false, saved = false, uncertainSave = initialSaveBlocked !== false;
  const fresh = () => generated.status === 'PENDING_SIGNATURE' && Number.isFinite(Date.parse(generated.expires_at)) && now() < Date.parse(generated.expires_at);
  const server = createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://rpc.mainnet.near.org https://free.rpc.fastnear.com; img-src 'self' data:; frame-src https://wallet.meteorwallet.app; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    function json(status,body){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return json(403,{error:'origin_denied'});
    if (req.method === 'GET' && req.url === '/api/intent') return json(200,{generated,expectedOwner,csrfToken,canSign:fresh()&&!saved&&!saving&&!uncertainSave});
    if (req.method === 'GET' && (req.url === '/' || req.url === '/client.js')) {
      const body = req.url === '/' ? html : bundle;
      if (!body) return json(503,{error:'asset_not_built'});
      res.writeHead(200,{'Content-Type':req.url==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8'});res.end(body);return;
    }
    if (req.method !== 'POST' || req.url !== '/api/signature') return json(404,{error:'not_found'});
    const token = req.headers['x-csrf-token'];
    if (req.headers.origin !== origin || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token),Buffer.from(csrfToken))) return json(403,{error:'csrf_denied'});
    if (!fresh() || saving || saved || uncertainSave) return json(409,{error:'expired_or_already_saved'});
    if (req.headers['content-type'] !== 'application/json') return json(415,{error:'json_required'});
    saving = true;
    try {
      const chunks=[];let size=0;
      for await (const chunk of req) {
        size+=chunk.length;if(size>400000) {json(413,{error:'body_too_large'});return;}
        chunks.push(chunk);
      }
      let signed;
      try {
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (Object.keys(body).join(',')!=='signed_data') throw Error('invalid_body');
        signed=body.signed_data;validateSignature(signed,generated,expectedOwner);
      } catch { return json(400,{error:'signature_invalid'}); }
      if (!fresh()) return json(409,{error:'intent_expired'});
      try {
        await saveSignature({correlation_id:generated.correlation_id,type:generated.type,signed_data:signed});
        saved=true;
      } catch { uncertainSave=true;return json(409,{error:'signature_storage_unavailable'}); }
      return json(201,{status:'SAVED_LOCALLY',submitted:false});
    } catch { if(!res.headersSent) json(400,{error:'request_failed'}); }
    finally {saving=false;}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
