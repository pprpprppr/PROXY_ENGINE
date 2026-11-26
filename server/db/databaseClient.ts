import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AiSecurityAnalysis,
  CapturedPacket,
  HistoryQuery,
  PacketSummary,
  RequestCollection,
  RetentionPolicy,
  SavedRequestItem,
} from '../types.js';
import { logEvent } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class DatabaseClient {
  private worker: Worker;
  private nextRpcId = 1;
  private pending = new Map<number, PendingRpc>();
  private readyPromise: Promise<{
    integrityOk: boolean;
    recoveryNote: string | null;
    legacyMigration: { migrated: number; skipped: number };
  }>;
  private closed = false;

  constructor(dbPath: string, legacyJsonDbPath?: string) {
    const workerPath = path.join(__dirname, 'sqliteWorker.mjs');
    this.worker = new Worker(workerPath, {
      workerData: { dbPath, legacyJsonDbPath },
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const onMessage = (msg: any) => {
        if (msg?.type === 'ready') {
          if (msg.legacyMigration?.migrated > 0) {
            logEvent('info', 'database', 'Migrated legacy proxy-traffic.json records into SQLite', msg.legacyMigration);
          }
          if (!msg.integrityOk) {
            logEvent('warn', 'database', msg.recoveryNote || 'SQLite integrity recovery executed');
          }
          resolve({
            integrityOk: Boolean(msg.integrityOk),
            recoveryNote: msg.recoveryNote || null,
            legacyMigration: msg.legacyMigration || { migrated: 0, skipped: 0 },
          });
        } else if (msg?.type === 'rpcResult') {
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          if (msg.ok) {
            entry.resolve(msg.result);
          } else {
            entry.reject(new Error(msg.error || 'Database RPC failed'));
          }
        }
      };

      this.worker.on('message', onMessage);
      this.worker.on('error', (err) => {
        logEvent('error', 'database', 'SQLite worker error', { error: err.message });
        reject(err);
        for (const [, p] of this.pending) {
          p.reject(err);
        }
        this.pending.clear();
      });
      this.worker.on('exit', (code) => {
        if (!this.closed && code !== 0) {
          const err = new Error(`SQLite worker exited unexpectedly with code ${code}`);
          for (const [, p] of this.pending) {
            p.reject(err);
          }
          this.pending.clear();
        }
      });
    });
  }

  async waitUntilReady() {
    return this.readyPromise;
  }

  private rpc<T>(method: string, payload?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('DatabaseClient is closed'));
    }
    const id = this.nextRpcId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.worker.postMessage({ type: 'rpc', id, method, payload });
    });
  }

  enqueueUpsertPacket(packet: CapturedPacket & { contentType?: string }) {
    if (this.closed) return;
    this.worker.postMessage({
      type: 'enqueue',
      item: { op: 'upsertPacket', payload: packet },
    });
  }

  enqueueUpdateResponse(payload: {
    id: string;
    status: string;
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    bodySize: number;
    bodyTruncated: boolean;
    isBinary: boolean;
    duration?: number;
    passiveAnalysis?: string | null;
    timing?: unknown;
    fallbackPacket?: CapturedPacket;
  }) {
    if (this.closed) return;
    this.worker.postMessage({
      type: 'enqueue',
      item: { op: 'updateResponse', payload },
    });
  }

  enqueueUpdateAnalysis(id: string, analysis: string, structuredAnalysis?: AiSecurityAnalysis | null) {
    if (this.closed) return;
    this.worker.postMessage({
      type: 'enqueue',
      item: { op: 'updateAnalysis', payload: { id, analysis, structuredAnalysis } },
    });
  }

  enqueueUpdateMeta(id: string, tags: string[], bookmarked: boolean, collectionId?: string | null) {
    if (this.closed) return;
    this.worker.postMessage({
      type: 'enqueue',
      item: { op: 'updateMeta', payload: { id, tags, bookmarked, collectionId } },
    });
  }

  flush() {
    return this.rpc<{ ok: boolean }>('flush');
  }

  queryPackets(query: HistoryQuery = {}) {
    return this.rpc<{ items: PacketSummary[]; total: number; limit: number; offset: number }>(
      'queryPackets',
      query
    );
  }

  getPacketById(id: string) {
    return this.rpc<CapturedPacket | null>('getPacketById', { id });
  }

  getTrafficStats() {
    return this.rpc<{
      totals: Record<string, number>;
      topHosts: Array<{ host: string; count: number; avgMs: number }>;
      methods: Array<{ method: string; count: number }>;
      duplicates: Array<{ method: string; url: string; count: number }>;
    }>('getTrafficStats');
  }

  exportSession(limit = 10000) {
    return this.rpc<any[]>('exportSession', { limit });
  }

  importSession(records: any[], mode: 'merge' | 'replace' = 'merge') {
    return this.rpc<{ imported: number; skipped: number }>('importSession', { records, mode });
  }

  clearHistory() {
    return this.rpc<{ cleared: boolean }>('clearHistory');
  }

  enforceRetention(policy: RetentionPolicy) {
    return this.rpc<{ deleted: number }>('enforceRetention', policy);
  }

  getSetting<T = unknown>(key: string) {
    return this.rpc<T | null>('getSetting', { key });
  }

  setSetting(key: string, value: unknown) {
    return this.rpc<{ ok: boolean }>('setSetting', { key, value });
  }

  listCollections() {
    return this.rpc<{ collections: RequestCollection[]; requests: SavedRequestItem[] }>('listCollections');
  }

  createCollection(collection: RequestCollection) {
    return this.rpc<{ ok: boolean }>('createCollection', collection);
  }

  deleteCollection(id: string) {
    return this.rpc<{ ok: boolean }>('deleteCollection', { id });
  }

  saveRequestToCollection(item: SavedRequestItem) {
    return this.rpc<{ ok: boolean }>('saveRequestToCollection', item);
  }

  deleteSavedRequest(id: string) {
    return this.rpc<{ ok: boolean }>('deleteSavedRequest', { id });
  }

  getStatus() {
    return this.rpc<{
      dbPath: string;
      totalPackets: number;
      totalBytesCaptured: number;
      queueDepth: number;
      droppedWrites: number;
      integrityOk: boolean;
      recoveryNote: string | null;
    }>('getStatus');
  }

  backup() {
    return this.rpc<{ backupPath: string | null }>('backup');
  }

  async close() {
    if (this.closed) return;
    try {
      await this.rpc('close');
    } catch {
      // Ignore if already shutting down
    }
    this.closed = true;
    await this.worker.terminate();
  }
}
