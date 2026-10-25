import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Store } from '../db.ts';
import type { Assistant, CatchupScope } from '../ai/assistant.ts';
import { MobileError, MobileSessions } from './sessions.ts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PREFIX = '/mobile/v1';
export interface MobileServerOptions {
  store: Store;
  assistant: Pick<Assistant, 'ask' | 'catchup' | 'summary'>;
  onSessionChanged?: (sessionId: string) => void;
  host?: string;
  port: number;
  token: string;
  tls?: { key: string | Buffer; cert: string | Buffer };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new MobileError(415, 'content_type', 'Use application/json.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new MobileError(415, 'content_encoding', 'Compressed request bodies are not supported.');
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new MobileError(413, 'body_too_large', 'Snapshot exceeds 4 MiB.');
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const fail = (e: Error) => {
      cleanup();
      // An aborted upload can emit a later ECONNRESET after its aborted event.
      req.once('error', () => {});
      req.resume(); reject(e);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return fail(new MobileError(413, 'body_too_large', 'Snapshot exceeds 4 MiB.'));
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const error = () => fail(new MobileError(400, 'invalid_request', 'Could not read request body.'));
    const aborted = () => fail(new MobileError(400, 'invalid_request', 'Request was interrupted.'));
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')); }
  catch { throw new MobileError(400, 'invalid_json', 'Invalid JSON body.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MobileError(400, 'invalid_request', 'Expected a JSON object.');
  return value as Record<string, unknown>;
}

/** The companion has its own listener and explicit route allowlist; it never proxies the desktop API. */
export async function startMobileServer(options: MobileServerOptions) {
  const { store, assistant, token } = options;
  const host = options.host ?? '127.0.0.1';
  if (!options.tls && !['127.0.0.1', '::1'].includes(host)) throw new Error('The mobile companion requires TLS outside literal loopback addresses.');
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /\s/.test(token)) throw new Error('Mobile token must contain 32–512 non-whitespace characters.');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid mobile port.');
  const expectedToken = createHash('sha256').update(token).digest();
  const sessions = new MobileSessions(store);
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Native apps send no Origin. Reject browser requests even when they possess a token.
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) throw new MobileError(403, 'browser_request', 'Use the paired native app.');
      const auth = req.headers.authorization ?? '';
      const match = /^Bearer ([^\s]{1,512})$/.exec(auth);
      const actual = createHash('sha256').update(match?.[1] ?? '').digest();
      if (!timingSafeEqual(actual, expectedToken) || !match) throw new MobileError(401, 'unauthorized', 'Pair this phone with Chumi.');
      // Avoid absolute-form URLs, decoded paths, query-based dispatch and arbitrary API forwarding.
      const route = req.url ?? '';
      if (route === `${PREFIX}/health` && req.method === 'GET') return send(res, 200, { ok: true, version: 1 });
      if (route === `${PREFIX}/projects` && req.method === 'GET') return send(res, 200, { projects: store.listProjects().map((p) => ({ id: p.id, name: p.name })) });
      if (route === `${PREFIX}/sessions` && req.method === 'POST') {
        const result = sessions.ingest(await body(req));
        if (result.status === 'accepted') options.onSessionChanged?.(result.sessionId);
        return send(res, 200, result);
      }
      const meeting = /^\/mobile\/v1\/sessions\/([A-Za-z0-9_-]+)(?:\/(ask|catchup|summary))?$/.exec(route);
      if (meeting) {
        const [, id, action] = meeting;
        sessions.owned(id);
        if (!action && req.method === 'GET') return send(res, 200, sessions.detail(id));
        if (action && req.method === 'POST') {
          const b = await body(req);
          let outputId: string;
          if (action === 'ask') {
            if (typeof b.question !== 'string' || !b.question.trim() || b.question.length > 2000) throw new MobileError(400, 'invalid_question', 'Question must contain 1–2,000 characters.');
            if (b.projectContext !== undefined && typeof b.projectContext !== 'boolean') throw new MobileError(400, 'invalid_request', 'projectContext must be a boolean.');
            outputId = assistant.ask(id, b.question.trim(), null, 'standard', [], undefined, { projectContext: b.projectContext === true });
          } else if (action === 'catchup') {
            if (!['2m', '5m', 'all'].includes(String(b.scope))) throw new MobileError(400, 'invalid_scope', 'Choose 2m, 5m or all.');
            outputId = assistant.catchup(id, b.scope as CatchupScope);
          } else outputId = assistant.summary(id);
          return send(res, 202, { outputId });
        }
      }
      const output = /^\/mobile\/v1\/outputs\/([A-Za-z0-9_-]+)$/.exec(route);
      if (output && req.method === 'GET') return send(res, 200, sessions.output(output[1]));
      throw new MobileError(404, 'not_found', 'Endpoint not found.');
    } catch (e) {
      if (res.destroyed || res.headersSent) return;
      if (e instanceof MobileError) send(res, e.status, { error: e.message, code: e.code, ...e.details });
      else send(res, 500, { error: 'The companion could not complete this request.', code: 'internal_error' });
    }
  };
  const server = options.tls ? createHttpsServer(options.tls, handler) : createHttpServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server, url: `${options.tls ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${port}`,
    close: () => new Promise<void>((resolve, reject) => { server.close((e) => e ? reject(e) : resolve()); server.closeIdleConnections(); }),
  };
}
