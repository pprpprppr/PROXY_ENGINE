import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseClient } from '../server/db/databaseClient.js';
import { exportPacketsToHar, importHarToRecords } from '../server/proxy/harConverter.js';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('SQLite DatabaseClient CRUD, pagination, body search, collections, and non-destructive restart', async () => {
  const dir = makeTempDir('ps-db-crud-');
  const dbPath = path.join(dir, 'test.db');

  const db1 = new DatabaseClient(dbPath);
  const ready = await db1.waitUntilReady();
  assert.equal(ready.integrityOk, true);

  db1.enqueueUpsertPacket({
    id: 'pkt-1',
    timestamp: 1000,
    method: 'POST',
    url: 'https://example.com/api/login',
    host: 'example.com',
    path: '/api/login',
    headers: { 'content-type': 'application/json', authorization: 'Bearer super-secret' },
    body: '{"user":"alice"}',
    bodySize: 16,
    bodyTruncated: false,
    isBinary: false,
    status: 'pending',
    tags: ['auth'],
    bookmarked: true,
    contentType: 'application/json',
  });

  db1.enqueueUpdateResponse({
    id: 'pkt-1',
    status: 'completed',
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true,"token":"xyz"}',
    bodySize: 25,
    bodyTruncated: false,
    isBinary: false,
    duration: 42,
    passiveAnalysis: '[CORS] Wildcard',
  });

  db1.enqueueUpsertPacket({
    id: 'pkt-2',
    timestamp: 2000,
    method: 'GET',
    url: 'https://example.com/items',
    host: 'example.com',
    path: '/items',
    headers: {},
    body: '',
    bodySize: 0,
    bodyTruncated: false,
    isBinary: false,
    status: 'completed',
    tags: [],
    bookmarked: false,
    response: {
      statusCode: 404,
      headers: { 'content-type': 'text/plain' },
      body: 'Not found needle_body',
      bodySize: 21,
      bodyTruncated: false,
      isBinary: false,
      timestamp: 2010,
      duration: 10,
    },
  });

  await db1.flush();

  const all = await db1.queryPackets({ limit: 10, offset: 0 });
  assert.equal(all.total, 2);
  assert.equal(all.items[0].id, 'pkt-2');

  const bodyMatch = await db1.queryPackets({ bodySearch: 'needle_body' });
  assert.equal(bodyMatch.total, 1);
  assert.equal(bodyMatch.items[0].id, 'pkt-2');

  const bookmarked = await db1.queryPackets({ bookmarkedOnly: true });
  assert.equal(bookmarked.total, 1);
  assert.equal(bookmarked.items[0].id, 'pkt-1');

  const detail = await db1.getPacketById('pkt-1');
  assert.ok(detail);
  assert.equal(detail.response?.statusCode, 200);
  assert.equal(detail.response?.duration, 42);

  // Export & HAR redaction
  const exported = await db1.exportSession();
  assert.equal(exported.length, 2);
  const har = exportPacketsToHar(exported, true);
  assert.equal(har.log.entries.length, 2);
  const loginEntry = har.log.entries.find((e: any) => e.request.url.includes('/login'));
  assert.ok(loginEntry);
  const authHeader = loginEntry.request.headers.find((h: any) => h.name === 'authorization');
  assert.equal(authHeader?.value, '[REDACTED]');

  const harImport = importHarToRecords(har);
  assert.equal(harImport.valid, true);
  assert.equal(harImport.records?.length, 2);

  // Collections CRUD
  await db1.createCollection({ id: 'col-1', name: 'Auth Flows', createdAt: Date.now() });
  await db1.saveRequestToCollection({
    id: 'sr-1',
    collectionId: 'col-1',
    name: 'Login',
    method: 'POST',
    url: 'https://example.com/api/login',
    headers: {},
    body: '{}',
    createdAt: Date.now(),
  });
  const cols = await db1.listCollections();
  assert.equal(cols.collections.length, 1);
  assert.equal(cols.requests.length, 1);

  await db1.close();

  // Reopen and verify records survived shutdown
  const db2 = new DatabaseClient(dbPath);
  await db2.waitUntilReady();
  const afterRestart = await db2.queryPackets();
  assert.equal(afterRestart.total, 2);

  // Retention keeps bookmarked pkt-1 even when maxRecords=1
  const ret = await db2.enforceRetention({ enabled: true, maxRecords: 1, maxAgeHours: 0 });
  assert.ok(ret.deleted >= 0);
  const stillBookmarked = await db2.getPacketById('pkt-1');
  assert.ok(stillBookmarked);

  // Explicit user clear
  await db2.clearHistory();
  const cleared = await db2.queryPackets();
  assert.equal(cleared.total, 0);
  await db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SQLite migrates legacy proxy-traffic.json without losing valid records and recovers from corruption', async () => {
  const dir = makeTempDir('ps-db-mig-');
  const dbPath = path.join(dir, 'proxysuite.db');
  const legacyPath = path.join(dir, 'proxy-traffic.json');

  fs.writeFileSync(
    legacyPath,
    JSON.stringify([
      {
        id: 'legacy-1',
        timestamp: 1700000000000,
        method: 'GET',
        url: 'https://example.com/legacy',
        req_headers: { host: 'example.com' },
        req_body: '',
        res_headers: { 'content-type': 'text/plain' },
        res_body: 'hello legacy',
        status_code: 200,
      },
      { bad: 'record-missing-id' },
    ])
  );

  const db1 = new DatabaseClient(dbPath, legacyPath);
  const ready = await db1.waitUntilReady();
  assert.equal(ready.legacyMigration.migrated, 1);
  assert.equal(ready.legacyMigration.skipped, 1);
  const pkt = await db1.getPacketById('legacy-1');
  assert.ok(pkt);
  assert.equal(pkt.response?.body, 'hello legacy');
  await db1.close();

  // Corrupt DB file and verify automatic recovery
  fs.writeFileSync(dbPath, 'THIS IS NOT A VALID SQLITE DATABASE FILE');
  const db2 = new DatabaseClient(dbPath);
  const recovered = await db2.waitUntilReady();
  assert.equal(recovered.integrityOk, false);
  const status = await db2.getStatus();
  assert.equal(status.totalPackets, 0);
  await db2.close();

  // Verify truncated legacy JSON array salvage
  const truncDir = makeTempDir('ps-db-trunc-');
  const truncDbPath = path.join(truncDir, 'trunc.db');
  const truncJsonPath = path.join(truncDir, 'proxy-traffic.json');
  fs.writeFileSync(
    truncJsonPath,
    '[{"id":"t1","timestamp":1000,"method":"GET","url":"https://example.com/1"},\n{"id":"t2","timestamp":2000,'
  );
  const db3 = new DatabaseClient(truncDbPath, truncJsonPath);
  const truncReady = await db3.waitUntilReady();
  assert.equal(truncReady.legacyMigration.migrated, 1);
  assert.ok(await db3.getPacketById('t1'));
  await db3.close();
  fs.rmSync(truncDir, { recursive: true, force: true });

  fs.rmSync(dir, { recursive: true, force: true });
});
