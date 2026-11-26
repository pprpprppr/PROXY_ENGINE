import { create } from 'zustand';
import type {
  CapturedPacket,
  InterceptItem,
  PacketSummary,
  WebSocketConnectionRecord,
  WebSocketFrameRecord,
} from '../types/proxy';

export type { CapturedPacket as CapturedRequest };

interface TrafficState {
  summaries: PacketSummary[];
  totalCount: number;
  detailCache: Record<string, CapturedPacket>;
  detailOrder: string[];
  pendingIntercepts: InterceptItem[];
  wsConnections: WebSocketConnectionRecord[];
  wsFrames: WebSocketFrameRecord[];
  isCapturing: boolean;

  setCapturing: (capturing: boolean) => void;
  setSummaries: (items: PacketSummary[], total: number) => void;
  upsertLiveSummaries: (incoming: PacketSummary[]) => void;
  updateLiveResponse: (payload: {
    id: string;
    status?: PacketSummary['status'];
    statusCode: number;
    duration?: number;
    bodySize?: number;
    bodyTruncated?: boolean;
    isBinary?: boolean;
    headers?: Record<string, string>;
    body?: string;
    passiveAnalysis?: string | null;
    timestamp?: number;
    timing?: CapturedPacket['timing'];
  }) => void;
  cacheDetail: (packet: CapturedPacket) => void;
  updateCachedAnalysis: (id: string, analysis: string, structuredAnalysis?: CapturedPacket['structuredAnalysis']) => void;
  updatePacketMetaLocal: (id: string, tags: string[], bookmarked: boolean, collectionId?: string | null) => void;
  enqueueIntercept: (item: InterceptItem) => void;
  removeIntercept: (id: string) => void;
  upsertWsConnection: (conn: WebSocketConnectionRecord) => void;
  setWsConnections: (conns: WebSocketConnectionRecord[]) => void;
  pushWsFrame: (frame: WebSocketFrameRecord) => void;
  setWsFrames: (frames: WebSocketFrameRecord[]) => void;
  clearWsLocal: () => void;
  clearLocalTraffic: () => void;
}

const MAX_LIVE_SUMMARIES = 500;
const MAX_DETAIL_CACHE = 40;
const MAX_WS_FRAMES = 500;

export function toPacketSummary(p: any): PacketSummary {
  const res = p.response;
  let host = p.host || 'unknown';
  let path = p.path || '/';
  if (!p.host && p.url) {
    try {
      const u = new URL(p.url);
      host = u.host;
      path = `${u.pathname}${u.search}`;
    } catch {
      path = p.url;
    }
  }
  return {
    id: p.id,
    timestamp: p.timestamp || Date.now(),
    method: p.method || 'GET',
    url: p.url || '',
    host,
    path,
    status: p.status || (res ? 'completed' : 'pending'),
    statusCode: p.statusCode ?? res?.statusCode,
    duration: p.duration ?? res?.duration,
    reqBodySize: p.reqBodySize ?? p.bodySize ?? (typeof p.body === 'string' ? p.body.length : 0),
    reqBodyTruncated: Boolean(p.reqBodyTruncated ?? p.bodyTruncated),
    resBodySize: p.resBodySize ?? res?.bodySize ?? (typeof res?.body === 'string' ? res.body.length : 0),
    resBodyTruncated: Boolean(p.resBodyTruncated ?? res?.bodyTruncated),
    isBinary: Boolean(p.isBinary || res?.isBinary),
    contentType: p.contentType ?? res?.headers?.['content-type'] ?? p.headers?.['content-type'],
    hasPassiveFindings: Boolean(p.hasPassiveFindings ?? res?.passiveAnalysis),
    hasAiAnalysis: Boolean(p.hasAiAnalysis ?? p.analysis),
    tags: Array.isArray(p.tags) ? p.tags : [],
    bookmarked: Boolean(p.bookmarked),
    collectionId: p.collectionId ?? null,
  };
}

export const useTrafficStore = create<TrafficState>((set) => ({
  summaries: [],
  totalCount: 0,
  detailCache: {},
  detailOrder: [],
  pendingIntercepts: [],
  wsConnections: [],
  wsFrames: [],
  isCapturing: true,

  setCapturing: (isCapturing) => set({ isCapturing }),

  setSummaries: (items, total) => set({ summaries: items, totalCount: total }),

  upsertLiveSummaries: (incoming) =>
    set((state) => {
      if (incoming.length === 0) return state;
      const existingMap = new Map<string, number>();
      state.summaries.forEach((s, idx) => existingMap.set(s.id, idx));

      const next = [...state.summaries];
      let added = 0;
      for (const item of incoming) {
        const idx = existingMap.get(item.id);
        if (idx !== undefined) {
          next[idx] = { ...next[idx], ...item };
        } else {
          next.unshift(item);
          added++;
        }
      }
      if (next.length > MAX_LIVE_SUMMARIES) {
        next.length = MAX_LIVE_SUMMARIES;
      }
      return { summaries: next, totalCount: state.totalCount + added };
    }),

  updateLiveResponse: (payload) =>
    set((state) => {
      let changed = false;
      const summaries = state.summaries.map((s) => {
        if (s.id !== payload.id) return s;
        changed = true;
        return {
          ...s,
          status: payload.status || ('completed' as const),
          statusCode: payload.statusCode,
          duration: payload.duration ?? s.duration,
          resBodySize: payload.bodySize ?? (typeof payload.body === 'string' ? payload.body.length : s.resBodySize),
          resBodyTruncated: payload.bodyTruncated ?? s.resBodyTruncated,
          isBinary: s.isBinary || Boolean(payload.isBinary),
          contentType: payload.headers?.['content-type'] ?? s.contentType,
          hasPassiveFindings: Boolean(payload.passiveAnalysis) || s.hasPassiveFindings,
        };
      });

      const cached = state.detailCache[payload.id];
      let detailCache = state.detailCache;
      if (cached) {
        detailCache = {
          ...state.detailCache,
          [payload.id]: {
            ...cached,
            status: payload.status || 'completed',
            timing: payload.timing ?? cached.timing,
            response: {
              statusCode: payload.statusCode,
              headers: payload.headers || {},
              body: payload.body || '',
              bodySize: payload.bodySize ?? (payload.body ? payload.body.length : 0),
              bodyTruncated: Boolean(payload.bodyTruncated),
              isBinary: Boolean(payload.isBinary),
              timestamp: payload.timestamp || Date.now(),
              duration: payload.duration,
              passiveAnalysis: payload.passiveAnalysis ?? null,
            },
          },
        };
      }

      if (!changed && !cached) return state;
      return { summaries, detailCache };
    }),

  cacheDetail: (packet) =>
    set((state) => {
      const order = [packet.id, ...state.detailOrder.filter((id) => id !== packet.id)];
      const nextCache = { ...state.detailCache, [packet.id]: packet };
      while (order.length > MAX_DETAIL_CACHE) {
        const evicted = order.pop()!;
        delete nextCache[evicted];
      }
      return { detailCache: nextCache, detailOrder: order };
    }),

  updateCachedAnalysis: (id, analysis, structuredAnalysis) =>
    set((state) => {
      const summaries = state.summaries.map((s) => (s.id === id ? { ...s, hasAiAnalysis: true } : s));
      const cached = state.detailCache[id];
      const detailCache = cached
        ? { ...state.detailCache, [id]: { ...cached, analysis, structuredAnalysis } }
        : state.detailCache;
      return { summaries, detailCache };
    }),

  updatePacketMetaLocal: (id, tags, bookmarked, collectionId) =>
    set((state) => {
      const summaries = state.summaries.map((s) =>
        s.id === id ? { ...s, tags, bookmarked, collectionId } : s
      );
      const cached = state.detailCache[id];
      const detailCache = cached
        ? { ...state.detailCache, [id]: { ...cached, tags, bookmarked, collectionId } }
        : state.detailCache;
      return { summaries, detailCache };
    }),

  enqueueIntercept: (item) =>
    set((state) => {
      if (state.pendingIntercepts.some((p) => p.id === item.id && p.kind === item.kind)) {
        return state;
      }
      return { pendingIntercepts: [...state.pendingIntercepts, item].slice(0, 100) };
    }),

  removeIntercept: (id) =>
    set((state) => ({
      pendingIntercepts: state.pendingIntercepts.filter((p) => p.id !== id),
    })),

  upsertWsConnection: (conn) =>
    set((state) => {
      const exists = state.wsConnections.some((c) => c.id === conn.id);
      const next = exists
        ? state.wsConnections.map((c) => (c.id === conn.id ? conn : c))
        : [conn, ...state.wsConnections].slice(0, 200);
      return { wsConnections: next };
    }),

  setWsConnections: (wsConnections) => set({ wsConnections }),

  pushWsFrame: (frame) =>
    set((state) => ({
      wsFrames: [frame, ...state.wsFrames].slice(0, MAX_WS_FRAMES),
    })),

  setWsFrames: (wsFrames) => set({ wsFrames: wsFrames.slice(0, MAX_WS_FRAMES) }),

  clearWsLocal: () => set({ wsFrames: [] }),

  clearLocalTraffic: () =>
    set({
      summaries: [],
      totalCount: 0,
      detailCache: {},
      detailOrder: [],
    }),
}));
