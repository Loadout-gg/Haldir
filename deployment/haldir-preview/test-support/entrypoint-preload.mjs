// TEST ONLY. Exercises the genuine entrypoint and adapter/SDK serializer offline.
// Emulating the version guard is NOT qualification of Linux or Node 26.13.1.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { Readable } from 'node:stream';
const counters = { pid: process.pid, ppid: process.ppid, nativeNode: process.versions.node,
  versionGuardEmulated: process.versions.node !== (process.env.HALDIR_TEST_NODE_VERSION || '26.13.1'),
  forbiddenTransport: 0, readinessReads: 0, sdkInitializations: 0, sdkTerminations: 0 };
const deny = () => { counters.forbiddenTransport++; throw new Error('TEST_OUTBOUND_TRANSPORT_FORBIDDEN'); };
for (const [object, method] of [[globalThis, 'fetch'], [net.Socket.prototype, 'connect'],
  [tls, 'connect'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [http2, 'connect']]) object[method] = deny;
process.on('exit', () => process.stderr.write('HALDIR_TEST_RECEIPT ' + JSON.stringify(counters) + '\n'));
Object.defineProperty(process.versions, 'node', { value: process.env.HALDIR_TEST_NODE_VERSION || '26.13.1' });
const { Firestore } = await import('@google-cloud/firestore');
Firestore.prototype.initializeIfNeeded = async function () { counters.sdkInitializations++; };
Firestore.prototype.requestStream = async function (method, bidirectional, request) {
  counters.readinessReads++;
  if (method !== 'batchGetDocuments' || bidirectional || request.documents.length !== 1 ||
      !request.documents[0].startsWith('projects/loadout-haldir-demo/databases/preview-auth/documents/namespaces/haldirPreviewTestnetV1/walletChallenges/'))
    throw new Error('TEST_UNEXPECTED_SDK_READ');
  if (process.env.HALDIR_TEST_READINESS === 'deny') throw new Error('TEST_READINESS_DENIED');
  if (process.env.HALDIR_TEST_READINESS === 'hold') {
    process.send({ event: 'readiness-read', pid: process.pid });
    await new Promise(resolve => process.once('message', message => { if (message === 'release-readiness') resolve(); }));
  }
  return Readable.from([{ missing: request.documents[0], readTime: { seconds: '1', nanos: 0 } }], { objectMode: true });
};
const terminate = Firestore.prototype.terminate;
Firestore.prototype.terminate = function () { counters.sdkTerminations++; return terminate.call(this); };
