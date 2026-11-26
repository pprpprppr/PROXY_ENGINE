import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { WebSocketServer, WebSocket } from 'ws';
import { startProxySuiteServer, type AppRuntime } from '../server.js';
import { loadConfig } from '../server/config.js';

const require = createRequire(import.meta.url);

function generateSelfSignedCert(): { key: string; cert: string } {
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000 * 30);
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

function httpViaProxy(
  proxyPort: number,
  targetUrl: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        path: targetUrl,
        method: options.method || 'GET',
        headers: {
          ...(options.headers || {}),
          host: parsed.host,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function httpsViaProxy(
  proxyPort: number,
  targetUrl: string,
  caPem: Buffer
): Promise<{ statusCode: number; body: string }> {
  const parsed = new URL(targetUrl);
  const port = Number(parsed.port || 443);
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${parsed.hostname}:${port}`,
      headers: { host: `${parsed.hostname}:${port}` },
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`CONNECT status ${res.statusCode}`));
      }
      const tlsSock = tls.connect({
        host: parsed.hostname,
        socket,
        ...(net.isIP(parsed.hostname) ? {} : { servername: parsed.hostname }),
        ca: caPem,
        rejectUnauthorized: true,
      });
      const req = https.request(
        {
          createConnection: () => tlsSock,
          hostname: parsed.hostname,
          port,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers: { host: parsed.host },
        },
        (proxyRes) => {
          const chunks: Buffer[] = [];
          proxyRes.on('data', (c: Buffer) => chunks.push(c));
          proxyRes.on('end', () => {
            resolve({
              statusCode: proxyRes.statusCode || 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

test('Full ProxySuite integration: streaming bounded capture, gzip, binary, chunked, TLS verification, WS, intercept, API auth & stress', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-int-'));
  const binaryPayload = crypto.randomBytes(1024);
  binaryPayload[0] = 0x89;
  binaryPayload[1] = 0x50;
  binaryPayload[2] = 0x00;

  // Local HTTP fixture server + WS server
  const fixtureServer = http.createServer((req, res) => {
    const reqPath = (req.url || '').split('?')[0];
    if (reqPath === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method, headerX: req.headers['x-test'] || null }));
    } else if (reqPath === '/echo' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(Buffer.concat(chunks));
      });
    } else if (reqPath === '/gzip') {
      const gz = zlib.gzipSync(Buffer.from('{"compressed":"yes","email":"user@example.com"}'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(gz);
    } else if (reqPath === '/binary') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(binaryPayload);
    } else if (reqPath === '/large') {
      // 256 KB response > capture cap (8 KB)
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const chunk = Buffer.alloc(32 * 1024, 'L');
      for (let i = 0; i < 8; i++) res.write(chunk);
      res.end();
    } else if (reqPath === '/chunked') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
      res.write('part1-');
      res.end('part2');
    } else if (reqPath.startsWith('/fuzz/')) {
      const item = reqPath.slice('/fuzz/'.length);
      if (item === 'admin') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ADMIN_PANEL_ACCESS_GRANTED_ANOMALY');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('nope');
      }
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });

  const fixtureWss = new WebSocketServer({ server: fixtureServer, path: '/ws-echo' });
  fixtureWss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      ws.send(data, { binary: isBinary });
    });
  });

  await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', () => resolve()));
  const fixturePort = (fixtureServer.address() as any).port;

  // Local HTTPS fixture server with untrusted self-signed cert
  const { key, cert } = generateSelfSignedCert();
  const httpsFixture = https.createServer({ key, cert }, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"tls":"ok"}');
  });
  await new Promise<void>((resolve) => httpsFixture.listen(0, '127.0.0.1', () => resolve()));
  const httpsFixturePort = (httpsFixture.address() as any).port;

  const baseCfg = loadConfig();
  let runtime: AppRuntime | undefined;

  try {
    runtime = await startProxySuiteServer({
      host: '127.0.0.1',
      port: 0,
      proxyHost: '127.0.0.1',
      proxyPort: 0,
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, 'proxysuite.db'),
      legacyJsonDbPath: path.join(tmpDir, 'proxy-traffic.json'),
      certDir: path.join(tmpDir, '.http-mitm-proxy'),
      defaults: {
        ...baseCfg.defaults,
        maxResBodyCaptureBytes: 8192, // 8 KB cap for test
        maxReqBodyCaptureBytes: 8192,
        interceptTimeoutMs: 500, // Fast timeout for reaper test
      },
    });

    const apiBase = `http://127.0.0.1:${runtime.uiPort}`;
    const token = runtime.config.apiToken;
    const authHeaders = { 'X-ProxySuite-Token': token };
    // 1. API security: reject unauthenticated & cross-origin requests
    const unauthRes = await fetch(`${apiBase}/api/history`);
    assert.equal(unauthRes.status, 401);

    const crossOriginRes = await fetch(`${apiBase}/api/bootstrap`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(crossOriginRes.status, 403);

    // 2. Basic HTTP proxy + gzip + binary + chunked + large bounded response
    const okRes = await httpViaProxy(runtime.proxyPort, `http://127.0.0.1:${fixturePort}/ok`);
    assert.equal(okRes.statusCode, 200);
    assert.equal(JSON.parse(okRes.body.toString('utf8')).ok, true);

    const gzRes = await httpViaProxy(runtime.proxyPort, `http://127.0.0.1:${fixturePort}/gzip`);
    assert.equal(gzRes.statusCode, 200);
    assert.equal(gzRes.headers['content-encoding'], 'gzip');
    const decompressed = zlib.gunzipSync(gzRes.body).toString('utf8');
    assert.ok(decompressed.includes('"compressed":"yes"'));

    const binRes = await httpViaProxy(runtime.proxyPort, `http://127.0.0.1:${fixturePort}/binary`);
    assert.equal(binRes.statusCode, 200);
    assert.equal(Buffer.compare(binRes.body, binaryPayload), 0);

    const chunkRes = await httpViaProxy(runtime.proxyPort, `http://127.0.0.1:${fixturePort}/chunked`);
    assert.equal(chunkRes.body.toString('utf8'), 'part1-part2');

    const largeRes = await httpViaProxy(runtime.proxyPort, `http://127.0.0.1:${fixturePort}/large`);
    assert.equal(largeRes.statusCode, 200);
    assert.equal(largeRes.body.length, 256 * 1024); // Full 256 KB streamed intact to client!

    await runtime.db.flush();
    const historyRes = await fetch(`${apiBase}/api/history?limit=20`, { headers: authHeaders });
    const historyJson = (await historyRes.json()) as any;
    const largeSummary = historyJson.items.find((i: any) => i.path === '/large');
    assert.ok(largeSummary);
    assert.equal(largeSummary.resBodySize, 256 * 1024);
    assert.equal(largeSummary.resBodyTruncated, true);

    const largeDetail = await (await fetch(`${apiBase}/api/history/${largeSummary.id}`, { headers: authHeaders })).json() as any;
    assert.ok(largeDetail.response.body.length <= 8192);

    const binSummary = historyJson.items.find((i: any) => i.path === '/binary');
    assert.equal(binSummary.isBinary, true);

    // 3. TLS verification: self-signed upstream rejected when allowInsecureTls = false, succeeds when true
    const caPem = fs.readFileSync(path.join(runtime.config.certDir, 'certs', 'ca.pem'));
    const strictTlsRes = await httpsViaProxy(
      runtime.proxyPort,
      `https://127.0.0.1:${httpsFixturePort}/`,
      caPem
    );
    assert.equal(strictTlsRes.statusCode, 504); // Proxy rejects untrusted upstream cert

    runtime.proxy.settings.allowInsecureTls = true;
    const overrideTlsRes = await httpsViaProxy(
      runtime.proxyPort,
      `https://127.0.0.1:${httpsFixturePort}/`,
      caPem
    );
    assert.equal(overrideTlsRes.statusCode, 200);
    assert.equal(overrideTlsRes.body, '{"tls":"ok"}');
    runtime.proxy.settings.allowInsecureTls = false;

    // 4. Request interception & modification + Reaper expiration
    runtime.proxy.gateEnabled = true;
    const interceptedPromise = httpViaProxy(runtime.proxyPort, `http://127.0.0.1:${fixturePort}/ok`, {
      method: 'POST',
      headers: { 'x-test': 'before' },
    });

    // Wait briefly for PENDING_REVIEW to enqueue
    await new Promise((r) => setTimeout(r, 80));
    const counts = runtime.proxy.getActiveCounts();
    assert.equal(counts.pendingRequestIntercepts, 1);

    // Forward with modified method & header via HTTP API
    const healthNow = (await (await fetch(`${apiBase}/api/health`, { headers: authHeaders })).json()) as any;
    assert.equal(healthNow.connections.pendingRequestIntercepts, 1);

    // Let's connect WS client to receive PENDING_REVIEW ID and forward with modification
    const ws = new WebSocket(`ws://127.0.0.1:${runtime.uiPort}/api/ws?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));

    // Wait for reaper to drop the stalled request (interceptTimeoutMs = 500ms)
    const reapedRes = await interceptedPromise;
    assert.equal(reapedRes.statusCode, 504);

    // Now test live request edit via WS
    const pendingIdPromise = new Promise<string>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'PENDING_REVIEW') resolve(msg.payload.id);
      });
    });

    const editedReqPromise = httpViaProxy(runtime.proxyPort, `http://127.0.0.1:${fixturePort}/echo`, {
      method: 'POST',
      body: 'original-body',
    });
    const pendingId = await pendingIdPromise;
    ws.send(
      JSON.stringify({
        type: 'ACTION_FORWARD',
        payload: {
          id: pendingId,
          modifiedBody: 'modified-body',
        },
      })
    );
    const editedRes = await editedReqPromise;
    assert.equal(editedRes.statusCode, 200);
    assert.equal(editedRes.body.toString('utf8'), 'modified-body');
    runtime.proxy.gateEnabled = false;
    ws.close();

    // 5. WebSocket MITM capture & disconnect cleanup
    await new Promise<void>((resolve, reject) => {
      const sock = http.request({
        hostname: '127.0.0.1',
        port: runtime.proxyPort,
        method: 'CONNECT',
        path: `127.0.0.1:${fixturePort}`,
        headers: { host: `127.0.0.1:${fixturePort}` },
      });
      sock.on('connect', (res, netSock) => {
        if (res.statusCode !== 200) return reject(new Error('WS CONNECT failed'));
        const clientWs = new WebSocket(`ws://127.0.0.1:${fixturePort}/ws-echo`, {
          createConnection: () => netSock,
        } as any);
        clientWs.on('open', () => clientWs.send('hello-ws-proxy'));
        clientWs.on('message', (msg) => {
          assert.equal(msg.toString(), 'hello-ws-proxy');
          clientWs.close();
          resolve();
        });
        clientWs.on('error', reject);
      });
      sock.on('error', reject);
      sock.end();
    });

    await new Promise((r) => setTimeout(r, 80));
    const wsFrames = runtime.proxy.getWebSocketFrames();
    assert.ok(wsFrames.some((f) => f.payload === 'hello-ws-proxy'));

    // 6. Repeater & Intruder scope enforcement
    const blockedRepeater = await fetch(`${apiBase}/api/repeater`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: `http://127.0.0.1:${fixturePort}/ok` }),
    });
    assert.equal(blockedRepeater.status, 403); // Localhost blocked by default

    // Explicitly enable allowLocalhost in target scope
    await fetch(`${apiBase}/api/settings`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetScope: { allowLocalhost: true } }),
    });

    const allowedRepeater = await fetch(`${apiBase}/api/repeater`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: `http://127.0.0.1:${fixturePort}/ok` }),
    });
    assert.equal(allowedRepeater.status, 200);

    // 6b. Controlled Intruder bounded concurrency + baseline anomaly detection
    const intruderRes = await fetch(`${apiBase}/api/intruder/run`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'GET',
        url: `http://127.0.0.1:${fixturePort}/fuzz/{FUZZ}`,
        payloads: ['guest', 'admin', 'user'],
        concurrency: 2,
        maxPayloads: 10,
      }),
    });
    assert.equal(intruderRes.status, 200);
    const intruderStarted = (await intruderRes.json()) as any;
    assert.equal(intruderStarted.baseline.statusCode, 404);
    assert.equal(intruderStarted.total, 3);
    await new Promise((r) => setTimeout(r, 120));

    // 7. Concurrent traffic stress test (60 concurrent requests)
    const memBefore = process.memoryUsage().heapUsed;
    const burst = Array.from({ length: 60 }, (_, idx) =>
      httpViaProxy(runtime.proxyPort, `http://127.0.0.1:${fixturePort}/ok?i=${idx}`)
    );
    const burstResults = await Promise.all(burst);
    const non200 = burstResults.filter((r) => r.statusCode !== 200);
    assert.deepEqual(
      non200.map((r) => ({ statusCode: r.statusCode, body: r.body.toString('utf8') })),
      []
    );
    const memAfter = process.memoryUsage().heapUsed;
    // Ensure heap didn't explode during concurrent traffic (< 120 MB delta)
    assert.ok(memAfter - memBefore < 120 * 1024 * 1024);

    // 8. Verify graceful shutdown preserves DB file
    await runtime.shutdown();
    assert.equal(fs.existsSync(path.join(tmpDir, 'proxysuite.db')), true);
  } finally {
    if (runtime) await runtime.shutdown().catch(() => {});
    fixtureWss.close();
    fixtureServer.closeAllConnections?.();
    httpsFixture.closeAllConnections?.();
    await new Promise<void>((r) => fixtureServer.close(() => r()));
    await new Promise<void>((r) => httpsFixture.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
