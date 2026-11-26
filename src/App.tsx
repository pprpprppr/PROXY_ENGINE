import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  GitCompare,
  Globe,
  LayoutDashboard,
  Pause,
  Play,
  Repeat,
  Settings,
  Shield,
  Target,
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
import { type TrafficFilterState } from './components/TrafficTable';
import { DashboardPane } from './components/DashboardPane';
import { TargetPane } from './components/TargetPane';
import { ProxyWorkspace, type ProxySubTab } from './components/ProxyWorkspace';
import { RepeaterPane } from './components/RepeaterPane';
import { IntruderPane } from './components/IntruderPane';
import { DecoderPane } from './components/DecoderPane';
import { ComparerPane } from './components/ComparerPane';
import { SettingsAndHealthPane } from './components/SettingsAndHealthPane';

type MainTab = 'dashboard' | 'target' | 'proxy' | 'repeater' | 'intruder' | 'decoder' | 'comparer' | 'settings';

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
  const setDecoderInput = useTrafficStore((s) => s.setDecoderInput);
  const setComparerSlot = useTrafficStore((s) => s.setComparerSlot);

  const [mainTab, setMainTab] = useState<MainTab>('proxy');
  const [proxySubTab, setProxySubTab] = useState<ProxySubTab>('history');
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);

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

  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<TrafficFilterState>({
    search: '',
    bodySearch: '',
    method: 'ALL',
    statusGroup: 'ALL',
    contentType: '',
    bookmarkedOnly: false,
  });

  const [repeaterTabs, setRepeaterTabs] = useState<RepeaterTab[]>([
    {
      id: 'tab-1',
      title: '1',
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

  useEffect(() => {
    if (!serverConfig.token) return;
    const timer = setTimeout(() => {
      loadHistory(page, filters);
    }, 150);
    return () => clearTimeout(timer);
  }, [page, filters, serverConfig.token, loadHistory]);

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
            setMainTab('proxy');
            setProxySubTab('intercept');
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
            setMainTab('proxy');
            setProxySubTab('intercept');
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

  const handleClearHistory = useCallback(async () => {
    if (!window.confirm('Clear all stored HTTP history? (An automatic backup will be created first.)')) return;
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

  const openInRepeater = useCallback((method: string, url: string, headers: string, body: string) => {
    const id = `tab-${Date.now()}`;
    let title = 'New';
    try {
      const u = new URL(url);
      title = `${method} ${u.pathname.slice(0, 14) || '/'}`;
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
    setMainTab('repeater');
  }, []);

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
    setMainTab('intruder');
  }, []);

  const navTabs: Array<{ id: MainTab; label: string; icon: any; badge?: number }> = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'target', label: 'Target', icon: Globe },
    { id: 'proxy', label: 'Proxy', icon: Shield, badge: pendingIntercepts.length || undefined },
    { id: 'repeater', label: 'Repeater', icon: Repeat, badge: repeaterTabs.length > 1 ? repeaterTabs.length : undefined },
    { id: 'intruder', label: 'Intruder', icon: Target },
    { id: 'decoder', label: 'Decoder', icon: ArrowRightLeft },
    { id: 'comparer', label: 'Comparer', icon: GitCompare },
    { id: 'settings', label: 'Settings & Health', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-[#0B0D12] text-gray-200 font-sans flex flex-col overflow-hidden h-screen">
      {/* Burp-Suite Style Top Bar */}
      <header className="h-12 border-b border-gray-800 bg-[#141720] flex items-center justify-between px-4 shrink-0 gap-4">
        <div className="flex items-center gap-6 h-full min-w-0">
          <div className="flex items-center gap-2.5 shrink-0">
            <Shield className="w-5 h-5 text-[#00E5FF]" />
            <span className="text-sm font-bold tracking-wide text-white">ProxySuite</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              v2.0
            </span>
          </div>

          <nav className="flex items-center gap-1 h-full overflow-x-auto">
            {navTabs.map((t) => {
              const Icon = t.icon;
              const active = mainTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setMainTab(t.id)}
                  className={`h-full px-3 text-xs font-semibold border-b-2 flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                    active
                      ? 'border-[#00E5FF] text-white bg-[#1B1F2C]/50'
                      : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 ${active ? 'text-[#00E5FF]' : ''}`} />
                  {t.label}
                  {t.badge ? (
                    <span className="px-1.5 py-0.2 rounded-full bg-orange-500/20 text-orange-300 text-[10px] font-bold">
                      {t.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Right Status Controls */}
        <div className="flex items-center gap-2 text-[11px] font-mono shrink-0">
          <button
            onClick={() => {
              setMainTab('proxy');
              setProxySubTab('intercept');
            }}
            className={`px-2.5 py-1 rounded-md border font-semibold flex items-center gap-1.5 ${
              interceptMode
                ? 'bg-orange-500/20 border-orange-500/40 text-orange-300'
                : 'bg-[#0B0D12] border-gray-800 text-gray-400 hover:text-white'
            }`}
            title="Click to open Proxy Intercept"
          >
            <span className={`w-2 h-2 rounded-full ${interceptMode ? 'bg-orange-400 animate-pulse' : 'bg-gray-600'}`} />
            {interceptMode ? 'Intercept ON' : 'Intercept OFF'}
          </button>

          <button
            onClick={() => setCapturing(!isCapturing)}
            className={`px-2.5 py-1 rounded-md border flex items-center gap-1 ${
              isCapturing
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
            }`}
            title={isCapturing ? 'Pause UI live feed' : 'Resume UI live feed'}
          >
            {isCapturing ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
            {isCapturing ? 'Capturing' : 'Paused'}
          </button>

          <button
            onClick={() => setMainTab('settings')}
            className="px-2.5 py-1 rounded-md bg-[#0B0D12] border border-gray-800 text-gray-300 hover:border-gray-600 flex items-center gap-1.5"
            title="Proxy Listener Address"
          >
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-red-500 animate-pulse'}`} />
            {serverConfig.proxyHost}:{serverConfig.proxyPort}
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="flex-1 flex min-h-0">
        {mainTab === 'dashboard' && (
          <DashboardPane
            serverConfig={serverConfig}
            isConnected={isConnected}
            interceptMode={interceptMode}
            summaries={summaries}
            totalCount={totalCount}
            pendingCount={pendingIntercepts.length}
            onNavigate={(tab, sub) => {
              setMainTab(tab);
              if (tab === 'proxy' && sub) setProxySubTab(sub as ProxySubTab);
            }}
            onToggleIntercept={toggleIntercept}
            onSelectPacket={(id) => setSelectedReqId(id)}
          />
        )}

        {mainTab === 'target' && (
          <TargetPane
            summaries={summaries}
            onInspectPacket={(id) => {
              setSelectedReqId(id);
              setMainTab('proxy');
              setProxySubTab('history');
            }}
            onSendHostToRepeater={(pkt) => openInRepeater(pkt.method, pkt.url, '', '')}
          />
        )}

        {mainTab === 'proxy' && (
          <ProxyWorkspace
            subTab={proxySubTab}
            onSubTabChange={setProxySubTab}
            interceptMode={interceptMode}
            responseInterceptMode={responseInterceptMode}
            pendingIntercepts={pendingIntercepts}
            ignoredDomains={ignoredDomains}
            onToggleIntercept={toggleIntercept}
            onToggleResponseIntercept={toggleResponseIntercept}
            onResolveIntercept={resolveIntercept}
            onUpdateIgnoredDomains={updateIgnoredDomains}
            summaries={summaries}
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
            onSelectPacket={setSelectedReqId}
            onIgnoreDomain={(domain) => {
              if (!ignoredDomains.includes(domain)) updateIgnoredDomains([...ignoredDomains, domain]);
            }}
            onToggleBookmark={handleToggleBookmark}
            onClearHistory={handleClearHistory}
            onSendPacketToRepeater={handleSendPacketToRepeater}
            onSendPacketToIntruder={handleSendPacketToIntruder}
            onSendRawToRepeater={openInRepeater}
            onSendRawToIntruder={(m, u, h, b) => {
              setIntruderMethod(m);
              setIntruderUrl(u);
              setIntruderHeaders(h);
              setIntruderBody(b);
              setMainTab('intruder');
            }}
            onSendToDecoder={(text) => {
              setDecoderInput(text);
              setMainTab('decoder');
            }}
            onSendToComparer={(slot, label, text) => {
              setComparerSlot(slot, { label, text });
              setMainTab('comparer');
            }}
            wsConnections={wsConnections}
            wsFrames={wsFrames}
            onClearWs={clearWsLocal}
          />
        )}

        {mainTab === 'repeater' && (
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
                  title: String(prev.length + 1),
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
                if (activeRepeaterTabId === id && next.length > 0) setActiveRepeaterTabId(next[0].id);
                return next;
              });
            }}
            onUpdateTab={(id, patch) => {
              setRepeaterTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
            }}
            onSendToIntruder={(m, u, h, b) => {
              setIntruderMethod(m);
              setIntruderUrl(u);
              setIntruderHeaders(h);
              setIntruderBody(b);
              setMainTab('intruder');
            }}
            onSendToDecoder={(text) => {
              setDecoderInput(text);
              setMainTab('decoder');
            }}
            onSendToComparer={(slot, label, text) => {
              setComparerSlot(slot, { label, text });
              setMainTab('comparer');
            }}
          />
        )}

        {mainTab === 'intruder' && (
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

        {mainTab === 'decoder' && <DecoderPane />}

        {mainTab === 'comparer' && <ComparerPane summaries={summaries} />}

        {mainTab === 'settings' && (
          <SettingsAndHealthPane
            serverConfig={serverConfig}
            onSessionImported={() => loadHistory(0, filters)}
          />
        )}
      </main>
    </div>
  );
}
