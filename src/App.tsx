import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels';
import {
  Activity,
  Info,
  Pause,
  Play,
  Repeat,
  Send,
  Settings,
  Shield,
  Target,
  Wifi,
  X,
} from 'lucide-react';
import { apiFetch, bootstrapSession, getWebSocketUrl } from './lib/api';
import { toPacketSummary, useTrafficStore } from './hooks/useTraffic';
import type {
  CapturedPacket,
  IntruderResultItem,
  PacketSummary,
  RepeaterTab,
  ServerBootstrapConfig,
} from './types/proxy';
import { TrafficTable, type TrafficFilterState } from './components/TrafficTable';
import { InspectorPane } from './components/InspectorPane';
import { RepeaterPane } from './components/RepeaterPane';
import { IntruderPane } from './components/IntruderPane';
import { WebSocketPane } from './components/WebSocketPane';
import { InterceptorPane } from './components/InterceptorPane';
import { SettingsAndHealthPane } from './components/SettingsAndHealthPane';

const PAGE_SIZE = 100;

export default function App() {
  const summaries = useTrafficStore((s) => s.summaries);
  const totalCount = useTrafficStore((s) => s.totalCount);
  const pendingIntercepts = useTrafficStore((s) => s.pendingIntercepts);
  const wsConnections = useTrafficStore((s) => s.wsConnections);
  const wsFrames = useTrafficStore((s) => s.wsFrames);
  const isCapturing = useTrafficStore((s) => s.isCapturing);

  const setCapturing = useTrafficStore((s) => s.setCapturing);
  const setSummaries = useTrafficStore((s) => s.setSummaries);
  const upsertLiveSummaries = useTrafficStore((s) => s.upsertLiveSummaries);
  const updateLiveResponse = useTrafficStore((s) => s.updateLiveResponse);
  const updatePacketMetaLocal = useTrafficStore((s) => s.updatePacketMetaLocal);
  const enqueueIntercept = useTrafficStore((s) => s.enqueueIntercept);
  const removeIntercept = useTrafficStore((s) => s.removeIntercept);
  const upsertWsConnection = useTrafficStore((s) => s.upsertWsConnection);
  const setWsConnections = useTrafficStore((s) => s.setWsConnections);
  const pushWsFrame = useTrafficStore((s) => s.pushWsFrame);
  const setWsFrames = useTrafficStore((s) => s.setWsFrames);
  const clearWsLocal = useTrafficStore((s) => s.clearWsLocal);
  const clearLocalTraffic = useTrafficStore((s) => s.clearLocalTraffic);

  const [viewMode, setViewMode] = useState<
    'inspector' | 'interceptor' | 'repeater' | 'intruder' | 'websockets' | 'settings'
  >('inspector');
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [showArchInfo, setShowArchInfo] = useState(false);

  const [serverConfig, setServerConfig] = useState<ServerBootstrapConfig>({
    token: '',
    port: 3000,
    host: '127.0.0.1',
    proxyPort: 8082,
    proxyHost: '127.0.0.1',
    proxyStatus: 'UP',
    geminiConfigured: false,
    geminiModel: 'gemini-2.5-flash',
  });

  const [interceptMode, setInterceptMode] = useState(false);
  const [responseInterceptMode, setResponseInterceptMode] = useState(false);
  const [ignoredDomains, setIgnoredDomains] = useState<string[]>([]);

  // Pagination & Server-Side Filters
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<TrafficFilterState>({
    search: '',
    bodySearch: '',
    method: 'ALL',
    statusGroup: 'ALL',
    contentType: '',
    bookmarkedOnly: false,
  });

  // Simulator bar state
  const [simMethod, setSimMethod] = useState('GET');
  const [simUrl, setSimUrl] = useState('http://127.0.0.1:3000/api/health');
  const [simBody, setSimBody] = useState('');
  const [isSimulating, setIsSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);

  // Multi-tab Repeater state
  const [repeaterTabs, setRepeaterTabs] = useState<RepeaterTab[]>([
    {
      id: 'tab-1',
      title: 'Tab 1',
      method: 'GET',
      url: '',
      headers: '',
      body: '',
      response: null,
      previousResponse: null,
      history: [],
    },
  ]);
  const [activeRepeaterTabId, setActiveRepeaterTabId] = useState('tab-1');

  // Intruder state
  const [intruderMethod, setIntruderMethod] = useState('GET');
  const [intruderUrl, setIntruderUrl] = useState('');
  const [intruderHeaders, setIntruderHeaders] = useState('');
  const [intruderBody, setIntruderBody] = useState('');
  const [intruderJobId, setIntruderJobId] = useState<string | null>(null);
  const [intruderStatus, setIntruderStatus] = useState<'idle' | 'running' | 'paused' | 'stopped' | 'completed'>('idle');
  const [intruderProgress, setIntruderProgress] = useState({ current: 0, total: 0 });
  const [intruderResults, setIntruderResults] = useState<IntruderResultItem[]>([]);
  const [intruderBaseline, setIntruderBaseline] = useState<IntruderResultItem | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const liveBatchRef = useRef<PacketSummary[]>([]);
  const liveFlushTimerRef = useRef<number | null>(null);
  const activeIntruderJobRef = useRef<string | null>(null);

  useEffect(() => {
    activeIntruderJobRef.current = intruderJobId;
  }, [intruderJobId]);

  const loadHistory = useCallback(
    async (targetPage = page, targetFilters = filters) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(targetPage * PAGE_SIZE),
      });
      if (targetFilters.method !== 'ALL') params.set('method', targetFilters.method);
      if (targetFilters.statusGroup !== 'ALL') params.set('statusGroup', targetFilters.statusGroup);
      if (targetFilters.search) params.set('search', targetFilters.search);
      if (targetFilters.bodySearch) params.set('bodySearch', targetFilters.bodySearch);
      if (targetFilters.contentType) params.set('contentType', targetFilters.contentType);
      if (targetFilters.bookmarkedOnly) params.set('bookmarkedOnly', 'true');

      try {
        const res = await apiFetch(`/api/history?${params.toString()}`);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.items)) {
          setSummaries(data.items, data.total || data.items.length);
        }
      } catch (e) {
        console.error('History load error:', e);
      }
    },
    [page, filters, setSummaries]
  );

  const hasActiveFilter =
    filters.method !== 'ALL' ||
    filters.statusGroup !== 'ALL' ||
    Boolean(filters.search) ||
    Boolean(filters.bodySearch) ||
    Boolean(filters.contentType) ||
    filters.bookmarkedOnly;

  const hasActiveFilterRef = useRef(hasActiveFilter);
  const pageRef = useRef(page);
  useEffect(() => {
    hasActiveFilterRef.current = hasActiveFilter;
    pageRef.current = page;
  }, [hasActiveFilter, page]);

  // Reload history on filter/page change (debounced slightly for typing)
  useEffect(() => {
    if (!serverConfig.token) return;
    const timer = setTimeout(() => {
      loadHistory(page, filters);
    }, 150);
    return () => clearTimeout(timer);
  }, [page, filters, serverConfig.token, loadHistory]);

  // Single stable Bootstrap + WebSocket connection (never reconnects on pause/play!)
  useEffect(() => {
    let closed = false;
    let reconnectTimer: number | null = null;

    const flushLiveBatch = () => {
      liveFlushTimerRef.current = null;
      const batch = liveBatchRef.current.splice(0);
      if (batch.length > 0 && pageRef.current === 0 && !hasActiveFilterRef.current) {
        upsertLiveSummaries(batch);
      }
    };

    const connectWs = () => {
      if (closed) return;
      const ws = new WebSocket(getWebSocketUrl());
      wsRef.current = ws;

      ws.onopen = () => setIsConnected(true);
      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        if (!closed) {
          reconnectTimer = window.setTimeout(connectWs, 3000);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const capturing = useTrafficStore.getState().isCapturing;

          if (msg.type === 'requestCaptured' && capturing) {
            liveBatchRef.current.push(toPacketSummary(msg.payload));
            if (!liveFlushTimerRef.current) {
              liveFlushTimerRef.current = window.setTimeout(flushLiveBatch, 60);
            }
          } else if (msg.type === 'responseCaptured') {
            updateLiveResponse(msg.payload);
          } else if (msg.type === 'PENDING_REVIEW') {
            enqueueIntercept({
              id: msg.payload.id,
              kind: 'request',
              method: msg.payload.method,
              url: msg.payload.url,
              headers: msg.payload.headers || msg.payload.req_headers || {},
              body: msg.payload.body || msg.payload.req_body || '',
              bodyTruncated: msg.payload.bodyTruncated,
              isBinary: msg.payload.isBinary,
              timestamp: msg.payload.timestamp || Date.now(),
            });
            setViewMode('interceptor');
          } else if (msg.type === 'RESPONSE_PENDING') {
            enqueueIntercept({
              id: msg.payload.id,
              kind: 'response',
              method: 'RESPONSE',
              statusCode: msg.payload.statusCode,
              url: msg.payload.url,
              headers: msg.payload.headers || {},
              body: msg.payload.body || '',
              bodyTruncated: msg.payload.bodyTruncated,
              isBinary: msg.payload.isBinary,
              timestamp: msg.payload.timestamp || Date.now(),
            });
            setViewMode('interceptor');
          } else if (msg.type === 'interceptStatus') {
            setInterceptMode(Boolean(msg.payload.enabled));
            if (msg.payload.responseEnabled !== undefined) {
              setResponseInterceptMode(Boolean(msg.payload.responseEnabled));
            }
          } else if (msg.type === 'wsConnection') {
            upsertWsConnection(msg.payload);
          } else if (msg.type === 'wsFrame') {
            if (msg.payload?.frame) pushWsFrame(msg.payload.frame);
            if (msg.payload?.connection) upsertWsConnection(msg.payload.connection);
          } else if (msg.type === 'fuzzProgress') {
            if (msg.payload.jobId === activeIntruderJobRef.current) {
              setIntruderResults((prev) => [...prev, ...(msg.payload.results || [])]);
              setIntruderProgress({ current: msg.payload.current, total: msg.payload.total });
            }
          } else if (msg.type === 'fuzzStatus') {
            if (msg.payload.jobId === activeIntruderJobRef.current) {
              setIntruderStatus(msg.payload.status);
            }
          } else if (msg.type === 'fuzzComplete') {
            if (msg.payload.jobId === activeIntruderJobRef.current) {
              setIntruderStatus(msg.payload.status || 'completed');
            }
          } else if (msg.type === 'REFRESH_DATA' || msg.type === 'SESSION_RELOADED') {
            loadHistory(0, filters);
          }
        } catch (err) {
          console.error('WS message parse error:', err);
        }
      };
    };

    bootstrapSession()
      .then((cfg) => {
        if (closed) return;
        setServerConfig(cfg);
        connectWs();
        apiFetch('/api/config')
          .then((r) => r.json())
          .then((d) => {
            setInterceptMode(Boolean(d.gateEnabled));
            setResponseInterceptMode(Boolean(d.responseGateEnabled));
          })
          .catch(() => {});
        apiFetch('/api/settings')
          .then((r) => r.json())
          .then((d) => {
            if (Array.isArray(d.ignoredDomains)) setIgnoredDomains(d.ignoredDomains);
          })
          .catch(() => {});
        apiFetch('/api/websockets/connections')
          .then((r) => r.json())
          .then((d) => Array.isArray(d) && setWsConnections(d))
          .catch(() => {});
        apiFetch('/api/websockets/frames')
          .then((r) => r.json())
          .then((d) => Array.isArray(d) && setWsFrames(d))
          .catch(() => {});
      })
      .catch((err) => console.error('Bootstrap error:', err));

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (liveFlushTimerRef.current) clearTimeout(liveFlushTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  const toggleIntercept = useCallback((enabled: boolean) => {
    setInterceptMode(enabled);
    apiFetch('/api/intercept/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch(() => {});
  }, []);

  const toggleResponseIntercept = useCallback((enabled: boolean) => {
    setResponseInterceptMode(enabled);
    apiFetch('/api/intercept/response/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch(() => {});
  }, []);

  const resolveIntercept = useCallback(
    (
      id: string,
      action: 'forward' | 'drop',
      edits?: {
        modifiedMethod?: string;
        modifiedUrl?: string;
        modifiedHeaders?: Record<string, string>;
        modifiedBody?: string;
        interceptResponse?: boolean;
      }
    ) => {
      removeIntercept(id);
      apiFetch('/api/intercept/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, ...(edits || {}) }),
      }).catch(() => {});
    },
    [removeIntercept]
  );

  const updateIgnoredDomains = useCallback((domains: string[]) => {
    setIgnoredDomains(domains);
    apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignoredDomains: domains }),
    }).catch(() => {});
  }, []);

  const simulateRequest = useCallback(async () => {
    setIsSimulating(true);
    setSimError(null);
    let parsedBody: unknown;
    try {
      parsedBody = simBody ? JSON.parse(simBody) : undefined;
    } catch {
      parsedBody = simBody;
    }
    try {
      const res = await apiFetch('/api/simulate-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: simUrl, method: simMethod, body: parsedBody }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSimError(data.error || 'Simulation failed');
      }
    } catch (e) {
      setSimError(e instanceof Error ? e.message : 'Simulation failed');
    }
    setIsSimulating(false);
  }, [simUrl, simMethod, simBody]);

  const handleClearHistory = useCallback(async () => {
    if (!window.confirm('Clear all persisted traffic history? (A backup will be saved first.)')) return;
    await apiFetch('/api/history', { method: 'DELETE' });
    clearLocalTraffic();
    setSelectedReqId(null);
  }, [clearLocalTraffic]);

  const handleToggleBookmark = useCallback(
    (req: PacketSummary) => {
      const nextBookmarked = !req.bookmarked;
      updatePacketMetaLocal(req.id, req.tags || [], nextBookmarked, req.collectionId);
      apiFetch(`/api/history/${encodeURIComponent(req.id)}/meta`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: req.tags || [], bookmarked: nextBookmarked, collectionId: req.collectionId }),
      }).catch(() => {});
    },
    [updatePacketMetaLocal]
  );

  const openInRepeater = useCallback(
    (method: string, url: string, headers: string, body: string) => {
      const id = `tab-${Date.now()}`;
      let title = 'Request';
      try {
        title = new URL(url).pathname.slice(0, 18) || 'Root';
      } catch {
        // ignore
      }
      setRepeaterTabs((prev) => [
        ...prev,
        {
          id,
          title,
          method,
          url,
          headers,
          body,
          response: null,
          previousResponse: null,
          history: [],
        },
      ]);
      setActiveRepeaterTabId(id);
      setViewMode('repeater');
    },
    []
  );

  const handleSendPacketToRepeater = useCallback(
    (pkt: CapturedPacket) => {
      const hdrs = Object.entries(pkt.headers || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      openInRepeater(pkt.method, pkt.url, hdrs, pkt.body || '');
    },
    [openInRepeater]
  );

  const handleSendPacketToIntruder = useCallback((pkt: CapturedPacket) => {
    setIntruderMethod(pkt.method);
    setIntruderUrl(pkt.url);
    setIntruderHeaders(
      Object.entries(pkt.headers || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    );
    setIntruderBody(pkt.body || '');
    setViewMode('intruder');
  }, []);

  const activeIntercept = pendingIntercepts[0];

  return (
    <div className="min-h-screen bg-[#0E1015] text-gray-300 font-sans flex flex-col overflow-hidden h-screen">
      {/* Header */}
      <header className="h-12 border-b border-gray-800 bg-[#14161C] flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3">
          <Shield className="w-5 h-5 text-indigo-500" />
          <h1 className="text-sm font-semibold tracking-wide text-gray-100 flex items-center gap-2">
            PROXY_ENGINE
            <span className="bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded text-[10px] font-mono border border-indigo-500/30">
              v2.0
            </span>
          </h1>
          <span className="text-[11px] font-mono text-gray-500 hidden md:inline">
            Proxy: {serverConfig.proxyHost}:{serverConfig.proxyPort}
          </span>
        </div>

        <div className="flex items-center gap-3 text-xs font-mono">
          <button
            onClick={() => setShowArchInfo(true)}
            className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1 bg-indigo-500/10 px-2 py-1 rounded"
          >
            <Info className="w-3.5 h-3.5" /> Architecture
          </button>

          <div className="flex items-center gap-2 px-2.5 py-1 bg-[#1C1F26] rounded border border-gray-800">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`} />
            <span>ws_bus</span>
          </div>

          <div className="flex gap-1 bg-[#1C1F26] p-0.5 rounded border border-gray-800">
            <button
              onClick={() => setCapturing(true)}
              className={`p-1 rounded ${isCapturing ? 'bg-emerald-600/30 text-emerald-300' : 'text-gray-500 hover:text-gray-300'}`}
              title="Live Capture Active"
            >
              <Play className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setCapturing(false)}
              className={`p-1 rounded ${!isCapturing ? 'bg-amber-600/30 text-amber-300' : 'text-gray-500 hover:text-gray-300'}`}
              title="Pause Live UI Stream"
            >
              <Pause className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex min-h-0">
        {/* Left Navigation */}
        <nav className="w-14 border-r border-gray-800 bg-[#0E1015] flex flex-col items-center py-3 gap-4 shrink-0">
          <button
            onClick={() => setViewMode('inspector')}
            className={`p-2 rounded-xl transition-colors ${viewMode === 'inspector' ? 'text-indigo-400 bg-indigo-500/10' : 'text-gray-600 hover:text-gray-400'}`}
            title="Inspector"
          >
            <Activity className="w-5 h-5" />
          </button>
          <button
            onClick={() => setViewMode('interceptor')}
            className={`p-2 rounded-xl relative transition-colors ${viewMode === 'interceptor' ? 'text-orange-400 bg-orange-500/10' : 'text-gray-600 hover:text-gray-400'}`}
            title="Live Intercept & Rules"
          >
            <Pause className={`w-5 h-5 ${interceptMode || pendingIntercepts.length > 0 ? 'text-orange-400' : ''}`} />
            {(interceptMode || pendingIntercepts.length > 0) && (
              <span className="absolute top-1 right-1 w-2 h-2 bg-orange-500 rounded-full" />
            )}
          </button>
          <button
            onClick={() => setViewMode('repeater')}
            className={`p-2 rounded-xl transition-colors ${viewMode === 'repeater' ? 'text-emerald-400 bg-emerald-400/10' : 'text-gray-600 hover:text-gray-400'}`}
            title="Repeater"
          >
            <Repeat className="w-5 h-5" />
          </button>
          <button
            onClick={() => setViewMode('intruder')}
            className={`p-2 rounded-xl transition-colors ${viewMode === 'intruder' ? 'text-purple-400 bg-purple-500/10' : 'text-gray-600 hover:text-gray-400'}`}
            title="Intruder"
          >
            <Target className="w-5 h-5" />
          </button>
          <button
            onClick={() => setViewMode('websockets')}
            className={`p-2 rounded-xl transition-colors ${viewMode === 'websockets' ? 'text-[#00E5FF] bg-[#00E5FF]/10' : 'text-gray-600 hover:text-gray-400'}`}
            title="WebSocket Inspector"
          >
            <Wifi className="w-5 h-5" />
          </button>
          <button
            onClick={() => setViewMode('settings')}
            className={`p-2 rounded-xl mt-auto transition-colors ${viewMode === 'settings' ? 'text-gray-100 bg-gray-800' : 'text-gray-600 hover:text-gray-400'}`}
            title="Settings & System Health"
          >
            <Settings className="w-5 h-5" />
          </button>
        </nav>

        <PanelGroup orientation="horizontal" className="flex-1 min-w-0">
          {/* Left Panel: Simulator + Traffic Table */}
          <Panel defaultSize={48} minSize={28} className="flex flex-col border-r border-gray-800 min-w-0 relative">
            {/* Simulator Bar */}
            <div className="p-2.5 border-b border-gray-800 bg-[#16181D] shrink-0 space-y-2">
              <div className="text-[11px] text-gray-400 font-mono flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Wifi className="w-3.5 h-3.5 text-[#00E5FF]" />
                  <span>Proxy Test Simulator</span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href="/api/ca-cert"
                    className="text-[10px] uppercase font-bold text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded bg-indigo-500/5"
                  >
                    Root CA
                  </a>
                  <span className="uppercase font-bold text-[10px] text-gray-500">Intercept</span>
                  <button
                    onClick={() => toggleIntercept(!interceptMode)}
                    className={`w-9 h-4.5 rounded-full relative transition-colors border ${
                      interceptMode ? 'bg-[#00E5FF]/20 border-[#00E5FF]' : 'bg-[#0E1015] border-gray-700'
                    }`}
                  >
                    <div
                      className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${
                        interceptMode ? 'left-5 bg-[#00E5FF]' : 'left-0.5 bg-gray-500'
                      }`}
                    />
                  </button>
                </div>
              </div>

              <div className="flex gap-2">
                <select
                  value={simMethod}
                  onChange={(e) => setSimMethod(e.target.value)}
                  className="bg-[#0E1015] border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-300"
                >
                  <option>GET</option>
                  <option>POST</option>
                </select>
                <input
                  type="text"
                  value={simUrl}
                  onChange={(e) => setSimUrl(e.target.value)}
                  className="flex-1 bg-[#0E1015] border border-gray-700 rounded px-2.5 py-1 text-xs font-mono text-gray-300"
                  placeholder="Authorized target URL..."
                />
                <button
                  onClick={simulateRequest}
                  disabled={isSimulating || !isConnected}
                  className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-3 py-1 rounded text-xs font-medium flex items-center gap-1.5"
                >
                  <Send className="w-3 h-3" />
                  {isSimulating ? 'Sending...' : 'Send'}
                </button>
              </div>
              {simMethod === 'POST' && (
                <input
                  type="text"
                  value={simBody}
                  onChange={(e) => setSimBody(e.target.value)}
                  placeholder="JSON body (optional)"
                  className="w-full bg-[#0E1015] border border-gray-700 rounded px-2.5 py-1 text-xs font-mono text-gray-300"
                />
              )}
              {simError && <div className="text-[11px] text-red-400 font-mono">{simError}</div>}
            </div>

            {activeIntercept && (
              <div className="mx-3 mt-2 bg-[#1C1F26] border border-[#00E5FF] rounded-lg p-3 flex items-center justify-between gap-2 shrink-0">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase text-[#00E5FF] font-bold">
                    {activeIntercept.kind === 'response' ? 'Response Intercepted' : 'Request Intercepted'}
                  </div>
                  <div className="font-mono text-xs text-gray-100 truncate">
                    <span className="text-yellow-400 mr-1.5">{activeIntercept.method}</span>
                    {activeIntercept.url}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => resolveIntercept(activeIntercept.id, 'drop')}
                    className="px-2.5 py-1 bg-red-500/20 text-red-400 rounded text-xs font-bold border border-red-500/30"
                  >
                    Drop
                  </button>
                  <button
                    onClick={() => resolveIntercept(activeIntercept.id, 'forward')}
                    className="px-2.5 py-1 bg-[#00E5FF]/20 text-[#00E5FF] rounded text-xs font-bold border border-[#00E5FF]/30"
                  >
                    Forward
                  </button>
                  <button
                    onClick={() => setViewMode('interceptor')}
                    className="px-2.5 py-1 bg-gray-800 text-gray-300 rounded text-xs border border-gray-700"
                  >
                    Edit
                  </button>
                </div>
              </div>
            )}

            <TrafficTable
              items={summaries}
              totalCount={totalCount}
              page={page}
              pageSize={PAGE_SIZE}
              selectedId={selectedReqId}
              filters={filters}
              onFiltersChange={(next) => {
                setPage(0);
                setFilters(next);
              }}
              onPageChange={setPage}
              onSelect={(id) => {
                setSelectedReqId(id);
                setViewMode('inspector');
              }}
              onIgnoreDomain={(domain) => {
                if (!ignoredDomains.includes(domain)) {
                  updateIgnoredDomains([...ignoredDomains, domain]);
                }
              }}
              onToggleBookmark={handleToggleBookmark}
              onClearHistory={handleClearHistory}
            />
          </Panel>

          <PanelResizeHandle className="w-1 bg-gray-800 hover:bg-[#00E5FF] cursor-col-resize transition-colors" />

          {/* Right Panel */}
          <Panel defaultSize={52} minSize={30} className="flex flex-col bg-[#14161C] min-w-0">
            <div className="h-10 border-b border-gray-800 bg-[#1C1F26] flex items-center shrink-0 overflow-x-auto">
              {(
                [
                  ['inspector', 'Inspector'],
                  ['interceptor', `Intercept (${pendingIntercepts.length})`],
                  ['repeater', 'Repeater'],
                  ['intruder', 'Intruder'],
                  ['websockets', `WebSockets (${wsFrames.length})`],
                  ['settings', 'Settings & Health'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setViewMode(key)}
                  className={`h-full px-3.5 text-[11px] font-semibold uppercase tracking-wider border-b-2 transition-colors whitespace-nowrap ${
                    viewMode === key
                      ? 'border-[#00E5FF] text-[#00E5FF]'
                      : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {viewMode === 'inspector' && (
              <InspectorPane
                selectedId={selectedReqId}
                summaries={summaries}
                onSendToRepeater={handleSendPacketToRepeater}
                onSendToIntruder={handleSendPacketToIntruder}
              />
            )}

            {viewMode === 'interceptor' && (
              <InterceptorPane
                interceptMode={interceptMode}
                responseInterceptMode={responseInterceptMode}
                activeIntercepts={pendingIntercepts}
                ignoredDomains={ignoredDomains}
                onToggleIntercept={toggleIntercept}
                onToggleResponseIntercept={toggleResponseIntercept}
                onResolveIntercept={resolveIntercept}
                onUpdateIgnoredDomains={updateIgnoredDomains}
                onSendToRepeater={(m, u, h, b) => openInRepeater(m, u, h, b)}
                onSendToIntruder={(m, u, h, b) => {
                  setIntruderMethod(m);
                  setIntruderUrl(u);
                  setIntruderHeaders(h);
                  setIntruderBody(b);
                  setViewMode('intruder');
                }}
              />
            )}

            {viewMode === 'repeater' && (
              <RepeaterPane
                tabs={repeaterTabs}
                activeTabId={activeRepeaterTabId}
                onSelectTab={setActiveRepeaterTabId}
                onAddTab={() => {
                  const id = `tab-${Date.now()}`;
                  setRepeaterTabs((prev) => [
                    ...prev,
                    {
                      id,
                      title: `Tab ${prev.length + 1}`,
                      method: 'GET',
                      url: '',
                      headers: '',
                      body: '',
                      response: null,
                      previousResponse: null,
                      history: [],
                    },
                  ]);
                  setActiveRepeaterTabId(id);
                }}
                onCloseTab={(id) => {
                  setRepeaterTabs((prev) => {
                    const next = prev.filter((t) => t.id !== id);
                    if (activeRepeaterTabId === id && next.length > 0) {
                      setActiveRepeaterTabId(next[0].id);
                    }
                    return next;
                  });
                }}
                onUpdateTab={(id, patch) => {
                  setRepeaterTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
                }}
              />
            )}

            {viewMode === 'intruder' && (
              <IntruderPane
                method={intruderMethod}
                url={intruderUrl}
                headers={intruderHeaders}
                body={intruderBody}
                onChangeMethod={setIntruderMethod}
                onChangeUrl={setIntruderUrl}
                onChangeHeaders={setIntruderHeaders}
                onChangeBody={setIntruderBody}
                activeJobId={intruderJobId}
                jobStatus={intruderStatus}
                progress={intruderProgress}
                results={intruderResults}
                baseline={intruderBaseline}
                onJobStarted={(jobId, total, baseline) => {
                  setIntruderJobId(jobId);
                  setIntruderStatus('running');
                  setIntruderProgress({ current: 0, total });
                  setIntruderResults([]);
                  setIntruderBaseline(baseline);
                }}
                onJobStatusChange={setIntruderStatus}
              />
            )}

            {viewMode === 'websockets' && (
              <WebSocketPane
                connections={wsConnections}
                frames={wsFrames}
                onClear={clearWsLocal}
              />
            )}

            {viewMode === 'settings' && (
              <SettingsAndHealthPane
                serverConfig={serverConfig}
                onSessionImported={() => loadHistory(0, filters)}
              />
            )}
          </Panel>
        </PanelGroup>
      </main>

      {showArchInfo && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#14161C] border border-gray-800 rounded-xl max-w-xl w-full p-5 space-y-3 text-xs text-gray-300">
            <div className="flex items-center justify-between border-b border-gray-800 pb-2">
              <h2 className="font-bold text-sm text-white">ProxySuite v2.0 Architecture</h2>
              <button onClick={() => setShowArchInfo(false)} className="text-gray-500 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p>
              <strong>Streaming Bounded Capture:</strong> Requests & responses stream directly with configurable byte capture limits and automatic truncation markers, preventing OOM on large or binary responses.
            </p>
            <p>
              <strong>Worker-Isolated SQLite (WAL):</strong> Persistent traffic storage with prepared statements, batched writes, integrity recovery, HAR 1.2 export/import, and zero auto-deletion.
            </p>
            <p>
              <strong>Security Hardened:</strong> Localhost-bound services, session token & origin validation, strict upstream TLS verification by default, SSRF/target-scope guards, ReDoS rule checks, and redacted backend-only Gemini analysis.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
