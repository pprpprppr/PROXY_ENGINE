import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const { dbPath, legacyJsonDbPath } = workerData;

let db = null;
let integrityOk = true;
let recoveryNote = null;
let droppedWrites = 0;

/** @type {Array<{ op: string, payload: any }>} */
const writeQueue = [];
const MAX_QUEUE_SIZE = 5000;
const BATCH_MAX_SIZE = 64;
const BATCH_FLUSH_MS = 75;
let flushTimer = null;

// Prepared statements cache
let stmts = {};

function parseUrlParts(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return { host: u.host || 'unknown', path: `${u.pathname}${u.search}` || '/' };
  } catch {
    return { host: 'unknown', path: rawUrl || '/' };
  }
}

function safeJsonParse(str, fallback) {
  if (typeof str !== 'string') return str ?? fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function ensureDirForFile(filePath) {
  if (filePath === ':memory:') return;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createBackup(reason) {
  if (dbPath === ':memory:' || !fs.existsSync(dbPath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.${reason}.${ts}.bak`;
  try {
    fs.copyFileSync(dbPath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

function openDatabaseWithRecovery() {
  ensureDirForFile(dbPath);
  try {
    const candidate = new DatabaseSync(dbPath);
    candidate.exec('PRAGMA busy_timeout = 5000;');
    if (dbPath !== ':memory:') {
      const check = candidate.prepare('PRAGMA integrity_check;').get();
      if (!check || check.integrity_check !== 'ok') {
        throw new Error(`SQLite integrity_check failed: ${JSON.stringify(check)}`);
      }
    }
    return candidate;
  } catch (err) {
    integrityOk = false;
    recoveryNote = `Recovered from database error: ${err instanceof Error ? err.message : String(err)}`;
    if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptPath = `${dbPath}.corrupt.${ts}`;
      try {
        fs.renameSync(dbPath, corruptPath);
        for (const suffix of ['-wal', '-shm']) {
          if (fs.existsSync(dbPath + suffix)) {
            fs.renameSync(dbPath + suffix, corruptPath + suffix);
          }
        }
      } catch {
        // Ignore rename failure if locked
      }
    }
    const fresh = new DatabaseSync(dbPath);
    fresh.exec('PRAGMA busy_timeout = 5000;');
    return fresh;
  }
}

function applyMigrations() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get();
  const currentVersion = Number(row?.v || 0);

  if (currentVersion < 1) {
    if (currentVersion > 0) createBackup('pre-v1');
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS intercepted_packets (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        host TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        status_code INTEGER,
        duration_ms INTEGER,
        req_headers TEXT,
        req_body TEXT,
        req_body_size INTEGER DEFAULT 0,
        req_body_truncated INTEGER DEFAULT 0,
        req_is_binary INTEGER DEFAULT 0,
        res_headers TEXT,
        res_body TEXT,
        res_body_size INTEGER DEFAULT 0,
        res_body_truncated INTEGER DEFAULT 0,
        res_is_binary INTEGER DEFAULT 0,
        content_type TEXT,
        passive_analysis TEXT,
        ai_analysis TEXT,
        structured_analysis TEXT,
        tags TEXT DEFAULT '[]',
        bookmarked INTEGER DEFAULT 0,
        collection_id TEXT,
        timing_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_packets_timestamp ON intercepted_packets(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_packets_method ON intercepted_packets(method);
      CREATE INDEX IF NOT EXISTS idx_packets_host ON intercepted_packets(host);
      CREATE INDEX IF NOT EXISTS idx_packets_status_code ON intercepted_packets(status_code);
      CREATE INDEX IF NOT EXISTS idx_packets_bookmarked ON intercepted_packets(bookmarked);

      CREATE TABLE IF NOT EXISTS collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS saved_requests (
        id TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL,
        name TEXT NOT NULL,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        headers TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO schema_migrations (version, applied_at) VALUES (1, ${Date.now()});
      COMMIT;
    `);
  }
}

function prepareStatements() {
  stmts = {
    upsertPacket: db.prepare(`
      INSERT INTO intercepted_packets (
        id, timestamp, method, url, host, path, status, status_code, duration_ms,
        req_headers, req_body, req_body_size, req_body_truncated, req_is_binary,
        res_headers, res_body, res_body_size, res_body_truncated, res_is_binary,
        content_type, passive_analysis, ai_analysis, structured_analysis,
        tags, bookmarked, collection_id, timing_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        status = COALESCE(excluded.status, intercepted_packets.status),
        status_code = COALESCE(excluded.status_code, intercepted_packets.status_code),
        duration_ms = COALESCE(excluded.duration_ms, intercepted_packets.duration_ms),
        res_headers = COALESCE(excluded.res_headers, intercepted_packets.res_headers),
        res_body = COALESCE(excluded.res_body, intercepted_packets.res_body),
        res_body_size = COALESCE(excluded.res_body_size, intercepted_packets.res_body_size),
        res_body_truncated = COALESCE(excluded.res_body_truncated, intercepted_packets.res_body_truncated),
        res_is_binary = COALESCE(excluded.res_is_binary, intercepted_packets.res_is_binary),
        content_type = COALESCE(excluded.content_type, intercepted_packets.content_type),
        passive_analysis = COALESCE(excluded.passive_analysis, intercepted_packets.passive_analysis),
        timing_json = COALESCE(excluded.timing_json, intercepted_packets.timing_json)
    `),
    updateResponse: db.prepare(`
      UPDATE intercepted_packets SET
        status = ?,
        status_code = ?,
        duration_ms = ?,
        res_headers = ?,
        res_body = ?,
        res_body_size = ?,
        res_body_truncated = ?,
        res_is_binary = ?,
        content_type = COALESCE(?, content_type),
        passive_analysis = COALESCE(?, passive_analysis),
        timing_json = COALESCE(?, timing_json)
      WHERE id = ?
    `),
    updateAnalysis: db.prepare(`
      UPDATE intercepted_packets SET ai_analysis = ?, structured_analysis = ? WHERE id = ?
    `),
    updatePacketMeta: db.prepare(`
      UPDATE intercepted_packets SET tags = ?, bookmarked = ?, collection_id = ? WHERE id = ?
    `),
    getPacketById: db.prepare(`SELECT * FROM intercepted_packets WHERE id = ?`),
    getSetting: db.prepare(`SELECT value FROM app_settings WHERE key = ?`),
    setSetting: db.prepare(`
      INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    countPackets: db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(req_body_size + res_body_size), 0) AS totalBytes FROM intercepted_packets`),
  };
}

function parseJsonArrayWithSalvage(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Salvage truncated JSON arrays (e.g., trailing comma or mid-record truncation from legacy writeFileSync)
    const trimmed = raw.trim().replace(/,\s*$/, '');
    try {
      const fixed = trimmed.endsWith(']') ? trimmed : `${trimmed}]`;
      const parsed = JSON.parse(fixed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fallback: extract complete top-level objects from the array
    }

    const salvaged = [];
    let depth = 0;
    let inString = false;
    let escape = false;
    let objStart = -1;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        if (depth === 0) objStart = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && objStart !== -1) {
          try {
            salvaged.push(JSON.parse(raw.slice(objStart, i + 1)));
          } catch {
            // Skip malformed object
          }
          objStart = -1;
        }
      }
    }
    return salvaged;
  }
}

function migrateLegacyJsonIfNeeded() {
  if (!legacyJsonDbPath || !fs.existsSync(legacyJsonDbPath)) return { migrated: 0, skipped: 0 };
  const already = stmts.getSetting.get('legacy_json_migrated');
  if (already?.value === '1') return { migrated: 0, skipped: 0 };

  let records = [];
  try {
    const raw = fs.readFileSync(legacyJsonDbPath, 'utf8');
    records = parseJsonArrayWithSalvage(raw);
  } catch {
    return { migrated: 0, skipped: 0 };
  }

  let migrated = 0;
  let skipped = 0;
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const r of records) {
      if (!r || typeof r.id !== 'string' || typeof r.url !== 'string') {
        skipped++;
        continue;
      }
      const { host, path: urlPath } = parseUrlParts(r.url);
      const reqHeadersObj = safeJsonParse(r.req_headers, {});
      const resHeadersObj = safeJsonParse(r.res_headers, null);
      const reqBody = typeof r.req_body === 'string' ? r.req_body : '';
      const resBody = typeof r.res_body === 'string' ? r.res_body : null;
      const contentType = resHeadersObj?.['content-type'] || reqHeadersObj?.['content-type'] || null;

      stmts.upsertPacket.run(
        r.id,
        Number(r.timestamp) || Date.now(),
        String(r.method || 'GET'),
        r.url,
        host,
        urlPath,
        r.status_code ? 'completed' : 'pending',
        r.status_code ?? null,
        r.duration_ms ?? null,
        JSON.stringify(reqHeadersObj || {}),
        reqBody,
        Buffer.byteLength(reqBody, 'utf8'),
        0,
        0,
        resHeadersObj ? JSON.stringify(resHeadersObj) : null,
        resBody,
        resBody ? Buffer.byteLength(resBody, 'utf8') : 0,
        0,
        0,
        contentType,
        r.passive_analysis ?? null,
        r.analysis ?? null,
        null,
        JSON.stringify(Array.isArray(r.tags) ? r.tags : []),
        r.bookmarked ? 1 : 0,
        r.collectionId ?? null,
        null
      );
      migrated++;
    }
    stmts.setSetting.run('legacy_json_migrated', '1');
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return { migrated, skipped };
}

function executeWriteItem(item) {
  if (item.op === 'upsertPacket') {
    const p = item.payload;
    const { host, path: urlPath } = parseUrlParts(p.url || '');
    stmts.upsertPacket.run(
      p.id,
      p.timestamp || Date.now(),
      p.method || 'GET',
      p.url || '',
      p.host || host,
      p.path || urlPath,
      p.status || 'pending',
      p.statusCode ?? null,
      p.duration ?? null,
      JSON.stringify(p.headers || {}),
      p.body ?? '',
      p.bodySize ?? 0,
      p.bodyTruncated ? 1 : 0,
      p.isBinary ? 1 : 0,
      p.response ? JSON.stringify(p.response.headers || {}) : null,
      p.response ? p.response.body ?? '' : null,
      p.response ? p.response.bodySize ?? 0 : 0,
      p.response?.bodyTruncated ? 1 : 0,
      p.response?.isBinary ? 1 : 0,
      p.contentType ?? p.response?.headers?.['content-type'] ?? p.headers?.['content-type'] ?? null,
      p.response?.passiveAnalysis ?? null,
      p.analysis ?? null,
      p.structuredAnalysis ? JSON.stringify(p.structuredAnalysis) : null,
      JSON.stringify(Array.isArray(p.tags) ? p.tags : []),
      p.bookmarked ? 1 : 0,
      p.collectionId ?? null,
      p.timing ? JSON.stringify(p.timing) : null
    );
  } else if (item.op === 'updateResponse') {
    const r = item.payload;
    const res = stmts.updateResponse.run(
      r.status || 'completed',
      r.statusCode ?? null,
      r.duration ?? null,
      JSON.stringify(r.headers || {}),
      r.body ?? '',
      r.bodySize ?? 0,
      r.bodyTruncated ? 1 : 0,
      r.isBinary ? 1 : 0,
      r.headers?.['content-type'] ?? null,
      r.passiveAnalysis ?? null,
      r.timing ? JSON.stringify(r.timing) : null,
      r.id
    );
    if (res.changes === 0 && r.fallbackPacket) {
      executeWriteItem({ op: 'upsertPacket', payload: r.fallbackPacket });
    }
  } else if (item.op === 'updateAnalysis') {
    const { id, analysis, structuredAnalysis } = item.payload;
    stmts.updateAnalysis.run(
      analysis ?? null,
      structuredAnalysis ? JSON.stringify(structuredAnalysis) : null,
      id
    );
  } else if (item.op === 'updateMeta') {
    const { id, tags, bookmarked, collectionId } = item.payload;
    stmts.updatePacketMeta.run(
      JSON.stringify(Array.isArray(tags) ? tags : []),
      bookmarked ? 1 : 0,
      collectionId ?? null,
      id
    );
  }
}

function flushBatch() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!db || writeQueue.length === 0) return;

  const batch = writeQueue.splice(0, BATCH_MAX_SIZE);
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const item of batch) {
      executeWriteItem(item);
    }
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback failure
    }
    console.error('SQLite batch write error:', err);
  }

  if (writeQueue.length > 0) {
    flushTimer = setTimeout(flushBatch, 5);
  }
}

function flushAll() {
  while (writeQueue.length > 0) {
    flushBatch();
  }
}

function formatFullPacket(row) {
  if (!row) return null;
  const reqHeaders = safeJsonParse(row.req_headers, {});
  const resHeaders = row.res_headers ? safeJsonParse(row.res_headers, {}) : null;
  const tags = safeJsonParse(row.tags, []);
  const timing = row.timing_json ? safeJsonParse(row.timing_json, undefined) : undefined;
  const structuredAnalysis = row.structured_analysis ? safeJsonParse(row.structured_analysis, null) : null;

  return {
    id: row.id,
    timestamp: row.timestamp,
    method: row.method,
    url: row.url,
    host: row.host,
    path: row.path,
    headers: reqHeaders,
    body: row.req_body || '',
    bodySize: row.req_body_size || 0,
    bodyTruncated: Boolean(row.req_body_truncated),
    isBinary: Boolean(row.req_is_binary),
    status: row.status || (row.status_code ? 'completed' : 'pending'),
    response: row.status_code !== null && row.status_code !== undefined
      ? {
          statusCode: row.status_code,
          headers: resHeaders || {},
          body: row.res_body || '',
          bodySize: row.res_body_size || 0,
          bodyTruncated: Boolean(row.res_body_truncated),
          isBinary: Boolean(row.res_is_binary),
          timestamp: row.timestamp + (row.duration_ms || 0),
          duration: row.duration_ms ?? undefined,
          passiveAnalysis: row.passive_analysis || null,
        }
      : undefined,
    analysis: row.ai_analysis || undefined,
    structuredAnalysis,
    tags: Array.isArray(tags) ? tags : [],
    bookmarked: Boolean(row.bookmarked),
    collectionId: row.collection_id || null,
    timing,
  };
}

function formatSummary(row) {
  const tags = safeJsonParse(row.tags, []);
  return {
    id: row.id,
    timestamp: row.timestamp,
    method: row.method,
    url: row.url,
    host: row.host,
    path: row.path,
    status: row.status || (row.status_code ? 'completed' : 'pending'),
    statusCode: row.status_code ?? undefined,
    duration: row.duration_ms ?? undefined,
    reqBodySize: row.req_body_size || 0,
    reqBodyTruncated: Boolean(row.req_body_truncated),
    resBodySize: row.res_body_size || 0,
    resBodyTruncated: Boolean(row.res_body_truncated),
    isBinary: Boolean(row.req_is_binary || row.res_is_binary),
    contentType: row.content_type || undefined,
    hasPassiveFindings: Boolean(row.passive_analysis),
    hasAiAnalysis: Boolean(row.ai_analysis),
    tags: Array.isArray(tags) ? tags : [],
    bookmarked: Boolean(row.bookmarked),
    collectionId: row.collection_id || null,
  };
}

function handleQuery(q = {}) {
  flushAll();
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
  const offset = Math.max(0, Number(q.offset) || 0);
  const where = [];
  const params = [];

  if (q.method && q.method !== 'ALL') {
    where.push('method = ?');
    params.push(String(q.method).toUpperCase());
  }
  if (q.host) {
    where.push('LOWER(host) LIKE ?');
    params.push(`%${String(q.host).toLowerCase()}%`);
  }
  if (q.search) {
    const term = `%${String(q.search).toLowerCase()}%`;
    where.push('(LOWER(url) LIKE ? OR LOWER(host) LIKE ? OR LOWER(path) LIKE ?)');
    params.push(term, term, term);
  }
  if (q.bodySearch) {
    const bTerm = `%${String(q.bodySearch)}%`;
    where.push('(req_body LIKE ? OR res_body LIKE ?)');
    params.push(bTerm, bTerm);
  }
  if (q.contentType) {
    where.push('LOWER(COALESCE(content_type, \'\')) LIKE ?');
    params.push(`%${String(q.contentType).toLowerCase()}%`);
  }
  if (q.bookmarkedOnly) {
    where.push('bookmarked = 1');
  }
  if (q.tag) {
    where.push('tags LIKE ?');
    params.push(`%"${String(q.tag)}"%`);
  }
  if (q.collectionId) {
    where.push('collection_id = ?');
    params.push(String(q.collectionId));
  }
  if (q.statusGroup && q.statusGroup !== 'ALL') {
    if (q.statusGroup === '2xx') where.push('status_code >= 200 AND status_code < 300');
    else if (q.statusGroup === '3xx') where.push('status_code >= 300 AND status_code < 400');
    else if (q.statusGroup === '4xx') where.push('status_code >= 400 AND status_code < 500');
    else if (q.statusGroup === '5xx') where.push('status_code >= 500');
    else if (q.statusGroup === 'errors') where.push("(status = 'error' OR status = 'dropped' OR status_code >= 400)");
    else if (q.statusGroup === 'findings') where.push('(passive_analysis IS NOT NULL OR ai_analysis IS NOT NULL)');
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortMap = {
    timestamp: 'timestamp',
    duration: 'COALESCE(duration_ms, 0)',
    statusCode: 'COALESCE(status_code, 0)',
    size: 'COALESCE(res_body_size, 0)',
  };
  const orderCol = sortMap[q.sortBy] || 'timestamp';
  const orderDir = q.sortDir === 'asc' ? 'ASC' : 'DESC';

  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM intercepted_packets ${whereSql}`).get(...params);
  const rows = db.prepare(`
    SELECT
      id, timestamp, method, url, host, path, status, status_code, duration_ms,
      req_body_size, req_body_truncated, req_is_binary,
      res_body_size, res_body_truncated, res_is_binary,
      content_type, passive_analysis, ai_analysis, tags, bookmarked, collection_id
    FROM intercepted_packets
    ${whereSql}
    ORDER BY ${orderCol} ${orderDir}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    items: rows.map(formatSummary),
    total: Number(countRow?.total || 0),
    limit,
    offset,
  };
}

function handleRpc(method, payload) {
  switch (method) {
    case 'flush':
      flushAll();
      return { ok: true };

    case 'queryPackets':
      return handleQuery(payload);

    case 'getPacketById': {
      flushAll();
      const row = stmts.getPacketById.get(payload.id);
      return formatFullPacket(row);
    }

    case 'getTrafficStats': {
      flushAll();
      const totals = db.prepare(`
        SELECT
          COUNT(*) AS totalRequests,
          SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS s2xx,
          SUM(CASE WHEN status_code >= 300 AND status_code < 400 THEN 1 ELSE 0 END) AS s3xx,
          SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS s4xx,
          SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS s5xx,
          SUM(CASE WHEN passive_analysis IS NOT NULL THEN 1 ELSE 0 END) AS passiveFindings,
          SUM(CASE WHEN ai_analysis IS NOT NULL THEN 1 ELSE 0 END) AS aiFindings,
          COALESCE(AVG(duration_ms), 0) AS avgDurationMs,
          COALESCE(SUM(req_body_size), 0) AS totalReqBytes,
          COALESCE(SUM(res_body_size), 0) AS totalResBytes
        FROM intercepted_packets
      `).get();
      const topHosts = db.prepare(`
        SELECT host, COUNT(*) AS count, COALESCE(AVG(duration_ms), 0) AS avgMs
        FROM intercepted_packets
        GROUP BY host
        ORDER BY count DESC
        LIMIT 10
      `).all();
      const methods = db.prepare(`
        SELECT method, COUNT(*) AS count FROM intercepted_packets GROUP BY method ORDER BY count DESC
      `).all();
      const duplicates = db.prepare(`
        SELECT method, url, COUNT(*) AS count
        FROM intercepted_packets
        GROUP BY method, url
        HAVING count > 1
        ORDER BY count DESC
        LIMIT 20
      `).all();
      return { totals, topHosts, methods, duplicates };
    }

    case 'exportSession': {
      flushAll();
      const limit = Math.min(20000, Number(payload?.limit) || 10000);
      const rows = db.prepare(`
        SELECT * FROM intercepted_packets ORDER BY timestamp DESC LIMIT ?
      `).all(limit);
      return rows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        method: row.method,
        url: row.url,
        req_headers: safeJsonParse(row.req_headers, {}),
        req_body: row.req_body || '',
        res_headers: row.res_headers ? safeJsonParse(row.res_headers, {}) : null,
        res_body: row.res_body ?? null,
        status_code: row.status_code ?? null,
        duration_ms: row.duration_ms ?? null,
        passive_analysis: row.passive_analysis ?? null,
        analysis: row.ai_analysis ?? null,
        tags: safeJsonParse(row.tags, []),
        bookmarked: Boolean(row.bookmarked),
        req_body_size: row.req_body_size ?? 0,
        req_body_truncated: Boolean(row.req_body_truncated),
        res_body_size: row.res_body_size ?? 0,
        res_body_truncated: Boolean(row.res_body_truncated),
      }));
    }

    case 'importSession': {
      flushAll();
      const { records, mode = 'merge' } = payload;
      createBackup('pre-import');
      let imported = 0;
      let skipped = 0;
      db.exec('BEGIN IMMEDIATE;');
      try {
        if (mode === 'replace') {
          db.exec('DELETE FROM intercepted_packets;');
        }
        for (const r of records) {
          if (!r || typeof r.id !== 'string' || typeof r.url !== 'string') {
            skipped++;
            continue;
          }
          const { host, path: urlPath } = parseUrlParts(r.url);
          const reqHeaders = safeJsonParse(r.req_headers ?? r.headers, {});
          const resHeaders = safeJsonParse(r.res_headers ?? r.response?.headers, null);
          const reqBody = typeof (r.req_body ?? r.body) === 'string' ? (r.req_body ?? r.body) : '';
          const resBody = typeof (r.res_body ?? r.response?.body) === 'string'
            ? (r.res_body ?? r.response?.body)
            : null;
          const statusCode = r.status_code ?? r.response?.statusCode ?? null;
          const durationMs = r.duration_ms ?? r.response?.duration ?? null;
          const passive = r.passive_analysis ?? r.response?.passiveAnalysis ?? null;
          const contentType = resHeaders?.['content-type'] || reqHeaders?.['content-type'] || null;

          stmts.upsertPacket.run(
            r.id,
            Number(r.timestamp) || Date.now(),
            String(r.method || 'GET').toUpperCase(),
            r.url,
            host,
            urlPath,
            statusCode ? 'completed' : 'pending',
            statusCode,
            durationMs,
            JSON.stringify(reqHeaders || {}),
            reqBody,
            r.req_body_size ?? Buffer.byteLength(reqBody, 'utf8'),
            r.req_body_truncated ? 1 : 0,
            0,
            resHeaders ? JSON.stringify(resHeaders) : null,
            resBody,
            r.res_body_size ?? (resBody ? Buffer.byteLength(resBody, 'utf8') : 0),
            r.res_body_truncated ? 1 : 0,
            0,
            contentType,
            passive,
            r.analysis ?? null,
            null,
            JSON.stringify(Array.isArray(r.tags) ? r.tags : []),
            r.bookmarked ? 1 : 0,
            r.collectionId ?? null,
            null
          );
          imported++;
        }
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
      return { imported, skipped };
    }

    case 'clearHistory': {
      flushAll();
      createBackup('pre-clear');
      db.exec('DELETE FROM intercepted_packets;');
      if (dbPath !== ':memory:') {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      }
      return { cleared: true };
    }

    case 'enforceRetention': {
      flushAll();
      const { enabled, maxRecords, maxAgeHours } = payload;
      if (!enabled) return { deleted: 0 };
      let deleted = 0;
      db.exec('BEGIN IMMEDIATE;');
      try {
        if (maxAgeHours > 0) {
          const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
          const r1 = db.prepare('DELETE FROM intercepted_packets WHERE timestamp < ? AND bookmarked = 0').run(cutoff);
          deleted += Number(r1.changes || 0);
        }
        if (maxRecords > 0) {
          const r2 = db.prepare(`
            DELETE FROM intercepted_packets
            WHERE bookmarked = 0 AND id NOT IN (
              SELECT id FROM intercepted_packets ORDER BY timestamp DESC LIMIT ?
            )
          `).run(maxRecords);
          deleted += Number(r2.changes || 0);
        }
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
      return { deleted };
    }

    case 'getSetting': {
      const row = stmts.getSetting.get(payload.key);
      return row ? safeJsonParse(row.value, null) : null;
    }

    case 'setSetting': {
      stmts.setSetting.run(payload.key, JSON.stringify(payload.value));
      return { ok: true };
    }

    case 'listCollections': {
      const collections = db.prepare('SELECT * FROM collections ORDER BY created_at DESC').all();
      const items = db.prepare('SELECT * FROM saved_requests ORDER BY created_at DESC').all();
      return {
        collections: collections.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description || '',
          createdAt: c.created_at,
        })),
        requests: items.map((i) => ({
          id: i.id,
          collectionId: i.collection_id,
          name: i.name,
          method: i.method,
          url: i.url,
          headers: safeJsonParse(i.headers, {}),
          body: i.body,
          createdAt: i.created_at,
        })),
      };
    }

    case 'createCollection': {
      db.prepare('INSERT INTO collections (id, name, description, created_at) VALUES (?, ?, ?, ?)')
        .run(payload.id, payload.name, payload.description || '', payload.createdAt || Date.now());
      return { ok: true };
    }

    case 'deleteCollection': {
      db.prepare('DELETE FROM collections WHERE id = ?').run(payload.id);
      return { ok: true };
    }

    case 'saveRequestToCollection': {
      db.prepare(`
        INSERT INTO saved_requests (id, collection_id, name, method, url, headers, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        payload.id,
        payload.collectionId,
        payload.name,
        payload.method,
        payload.url,
        JSON.stringify(payload.headers || {}),
        payload.body || '',
        payload.createdAt || Date.now()
      );
      return { ok: true };
    }

    case 'deleteSavedRequest': {
      db.prepare('DELETE FROM saved_requests WHERE id = ?').run(payload.id);
      return { ok: true };
    }

    case 'getStatus': {
      const counts = stmts.countPackets.get();
      return {
        dbPath,
        totalPackets: Number(counts?.count || 0),
        totalBytesCaptured: Number(counts?.totalBytes || 0),
        queueDepth: writeQueue.length,
        droppedWrites,
        integrityOk,
        recoveryNote,
      };
    }

    case 'backup': {
      flushAll();
      const backupPath = createBackup('manual');
      return { backupPath };
    }

    case 'close': {
      flushAll();
      if (db) {
        try {
          if (dbPath !== ':memory:') {
            db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
          }
          db.close();
        } catch {
          // Ignore close errors
        }
        db = null;
      }
      return { closed: true };
    }

    default:
      throw new Error(`Unknown DB RPC method: ${method}`);
  }
}

// Initialize DB on worker startup
db = openDatabaseWithRecovery();
applyMigrations();
prepareStatements();
const legacyMigration = migrateLegacyJsonIfNeeded();

parentPort.on('message', (msg) => {
  if (!msg) return;
  if (msg.type === 'enqueue') {
    if (writeQueue.length >= MAX_QUEUE_SIZE) {
      droppedWrites++;
      return;
    }
    writeQueue.push(msg.item);
    if (writeQueue.length >= BATCH_MAX_SIZE) {
      flushBatch();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushBatch, BATCH_FLUSH_MS);
    }
    return;
  }

  if (msg.type === 'rpc') {
    const { id, method, payload } = msg;
    try {
      const result = handleRpc(method, payload);
      parentPort.postMessage({ type: 'rpcResult', id, ok: true, result });
    } catch (err) {
      parentPort.postMessage({
        type: 'rpcResult',
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
});

parentPort.postMessage({
  type: 'ready',
  integrityOk,
  recoveryNote,
  legacyMigration,
});
