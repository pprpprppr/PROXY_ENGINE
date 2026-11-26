import React, { useEffect, useState } from 'react';
import {
  Activity,
  ArrowRightLeft,
  Check,
  Copy,
  FolderPlus,
  GitCompare,
  History,
  KeyRound,
  Loader2,
  Plus,
  Send,
  ShieldCheck,
  Target,
  X,
} from 'lucide-react';
import type { RepeaterTab, RequestCollection, SavedRequestItem } from '../types/proxy';
import { apiFetch } from '../lib/api';
import { PrettyViewer } from './PrettyViewer';

interface RepeaterPaneProps {
  tabs: RepeaterTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onAddTab: () => void;
  onCloseTab: (id: string) => void;
  onUpdateTab: (id: string, patch: Partial<RepeaterTab>) => void;
  onSendToIntruder?: (method: string, url: string, headers: string, body: string) => void;
  onSendToDecoder?: (text: string) => void;
  onSendToComparer?: (slot: 'left' | 'right', label: string, text: string) => void;
}

function parseRawHeaders(raw: string): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) obj[k] = v;
    }
  }
  return obj;
}

function buildCurlCommand(tab: RepeaterTab): string {
  const headers = parseRawHeaders(tab.headers);
  const parts = [`curl -X ${tab.method} '${tab.url.replace(/'/g, "'\\''")}'`];
  for (const [k, v] of Object.entries(headers)) {
    parts.push(`  -H '${k}: ${v.replace(/'/g, "'\\''")}'`);
  }
  if (tab.body && tab.method !== 'GET' && tab.method !== 'HEAD') {
    parts.push(`  --data-raw '${tab.body.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(' \\\n');
}

function statusCategoryLabel(code: number): { label: string; color: string } {
  if (code >= 200 && code < 300) return { label: '2xx OK', color: 'text-emerald-400' };
  if (code >= 300 && code < 400) return { label: '3xx Redirect', color: 'text-yellow-400' };
  if (code >= 400 && code < 500) return { label: '4xx Client Error', color: 'text-orange-400' };
  return { label: '5xx Server Error', color: 'text-red-400' };
}

export function RepeaterPane({
  tabs,
  activeTabId,
  onSelectTab,
  onAddTab,
  onCloseTab,
  onUpdateTab,
  onSendToIntruder,
  onSendToDecoder,
  onSendToComparer,
}: RepeaterPaneProps) {
  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const [isSending, setIsSending] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [reqSubTab, setReqSubTab] = useState<'headers' | 'params' | 'body' | 'auth' | 'history' | 'collections'>('headers');
  const [resSubTab, setResSubTab] = useState<'pretty' | 'raw' | 'headers'>('pretty');
  const [showCompare, setShowCompare] = useState(false);
  const [authType, setAuthType] = useState<'bearer' | 'basic' | 'apikey'>('bearer');
  const [authValue, setAuthValue] = useState('');
  const [authKeyName, setAuthKeyName] = useState('X-API-Key');

  const [collections, setCollections] = useState<RequestCollection[]>([]);
  const [savedRequests, setSavedRequests] = useState<SavedRequestItem[]>([]);
  const [newCollectionName, setNewCollectionName] = useState('');

  const loadCollections = () => {
    apiFetch('/api/collections')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.collections)) setCollections(d.collections);
        if (Array.isArray(d.requests)) setSavedRequests(d.requests);
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (reqSubTab === 'collections') loadCollections();
  }, [reqSubTab]);

  if (!activeTab) return null;

  const queryParams = (() => {
    try {
      const u = new URL(activeTab.url);
      return Array.from(u.searchParams.entries());
    } catch {
      return [];
    }
  })();

  const updateQueryParam = (idx: number, key: string, value: string) => {
    try {
      const u = new URL(activeTab.url);
      const entries = Array.from(u.searchParams.entries());
      entries[idx] = [key, value];
      u.search = '';
      for (const [k, v] of entries) {
        if (k) u.searchParams.append(k, v);
      }
      onUpdateTab(activeTab.id, { url: u.toString() });
    } catch {
      // ignore
    }
  };

  const addQueryParam = () => {
    try {
      const u = new URL(activeTab.url);
      u.searchParams.append('param', 'value');
      onUpdateTab(activeTab.id, { url: u.toString() });
    } catch {
      // ignore
    }
  };

  const applyAuthHeader = () => {
    if (!authValue.trim()) return;
    const current = parseRawHeaders(activeTab.headers);
    if (authType === 'bearer') current['Authorization'] = `Bearer ${authValue.trim()}`;
    else if (authType === 'basic') current['Authorization'] = `Basic ${btoa(authValue.trim())}`;
    else current[authKeyName.trim() || 'X-API-Key'] = authValue.trim();
    const serialized = Object.entries(current).map(([k, v]) => `${k}: ${v}`).join('\n');
    onUpdateTab(activeTab.id, { headers: serialized });
  };

  const executeRepeater = async () => {
    if (!activeTab.url.trim()) {
      onUpdateTab(activeTab.id, { error: 'Enter a target URL before sending.' });
      return;
    }
    setIsSending(true);
    onUpdateTab(activeTab.id, { error: null });
    try {
      const parsedHeaders = parseRawHeaders(activeTab.headers);
      const res = await apiFetch('/api/repeater', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: activeTab.method,
          url: activeTab.url,
          headers: parsedHeaders,
          body: activeTab.body,
        }),
      });
      const result = await res.json();
      if (!res.ok || result.error) {
        onUpdateTab(activeTab.id, { error: result.error || `Request failed (${res.status})` });
      } else {
        onUpdateTab(activeTab.id, {
          previousResponse: activeTab.response,
          response: result,
          history: [
            {
              timestamp: Date.now(),
              method: activeTab.method,
              url: activeTab.url,
              statusCode: result.status_code,
              durationMs: result.duration_ms,
            },
            ...activeTab.history,
          ].slice(0, 30),
        });
      }
    } catch (e) {
      onUpdateTab(activeTab.id, { error: e instanceof Error ? e.message : 'Request failed' });
    }
    setIsSending(false);
  };

  const allowCurrentHostInScope = async () => {
    try {
      const parsed = new URL(activeTab.url);
      const hostname = parsed.hostname.toLowerCase();
      const sRes = await apiFetch('/api/settings');
      const sData = await sRes.json();
      const scope = sData.settings?.targetScope || {};
      const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
      const updatedScope = isLocal
        ? { ...scope, allowLocalhost: true }
        : {
            ...scope,
            allowedHosts: Array.from(new Set([...(scope.allowedHosts || []), hostname])),
          };
      const putRes = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetScope: updatedScope }),
      });
      if (putRes.ok) {
        onUpdateTab(activeTab.id, { error: null });
        await executeRepeater();
      }
    } catch {
      // ignore
    }
  };

  const handleCopyCurl = () => {
    navigator.clipboard
      .writeText(buildCurlCommand(activeTab))
      .then(() => {
        setCopiedCurl(true);
        setTimeout(() => setCopiedCurl(false), 1500);
      })
      .catch(() => {});
  };

  const isScopeError = Boolean(
    activeTab.error &&
      (activeTab.error.toLowerCase().includes('scope') || activeTab.error.toLowerCase().includes('loopback'))
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0B0D12]">
      {/* Repeater Tabs Bar */}
      <div className="h-9 bg-[#12151D] border-b border-gray-800 flex items-center px-3 gap-1 overflow-x-auto shrink-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            className={`px-3 py-1 rounded-t text-xs font-mono cursor-pointer flex items-center gap-2 border-t border-x ${
              tab.id === activeTab.id
                ? 'bg-[#191D28] border-gray-700 text-[#00E5FF] font-semibold'
                : 'bg-transparent border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <span className="truncate max-w-[140px]">{tab.title}</span>
            {tabs.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className="hover:text-red-400"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        <button
          onClick={onAddTab}
          className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-800"
          title="New Repeater Tab"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Request Action Bar */}
      <div className="h-12 border-b border-gray-800 flex items-center px-4 gap-2 shrink-0 bg-[#141720]">
        <select
          value={activeTab.method}
          onChange={(e) => onUpdateTab(activeTab.id, { method: e.target.value })}
          className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold text-indigo-300"
        >
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input
          className="flex-1 bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-gray-200 focus:outline-none focus:border-[#00E5FF]"
          value={activeTab.url}
          onChange={(e) => onUpdateTab(activeTab.id, { url: e.target.value })}
          placeholder="https://authorized-target.example/api/resource"
        />
        <button
          onClick={executeRepeater}
          disabled={isSending}
          className="bg-[#00E5FF]/20 hover:bg-[#00E5FF]/30 text-[#00E5FF] px-4 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 border border-[#00E5FF]/40 disabled:opacity-50"
        >
          {isSending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Send
        </button>
        <button
          onClick={handleCopyCurl}
          className="bg-gray-800 hover:bg-gray-700 text-gray-200 px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-1 border border-gray-700"
        >
          {copiedCurl ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          cURL
        </button>
        {onSendToIntruder && (
          <button
            onClick={() => onSendToIntruder(activeTab.method, activeTab.url, activeTab.headers, activeTab.body)}
            className="bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-1 border border-indigo-500/30"
          >
            <Target className="w-3 h-3" /> Intruder
          </button>
        )}
        {onSendToDecoder && (
          <button
            onClick={() => onSendToDecoder(activeTab.body || activeTab.url)}
            className="bg-gray-800 hover:bg-gray-700 text-gray-200 px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-1 border border-gray-700"
          >
            <ArrowRightLeft className="w-3 h-3" /> Decoder
          </button>
        )}
      </div>

      {activeTab.error && (
        <div className="px-4 py-2.5 bg-red-950/40 border-b border-red-500/30 text-xs text-red-200 flex items-center justify-between gap-3">
          <span className="font-mono">{activeTab.error}</span>
          {isScopeError && (
            <button
              onClick={allowCurrentHostInScope}
              className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1.5 shrink-0"
            >
              <ShieldCheck className="w-3.5 h-3.5" /> Authorize This Host & Retry
            </button>
          )}
        </div>
      )}

      {/* Side-by-Side Request | Response */}
      <div className="flex-1 flex min-h-0 divide-x divide-gray-800 overflow-hidden">
        {/* Request Editor */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex border-b border-gray-800 bg-[#141720] text-[11px] font-semibold">
            {(
              [
                ['headers', 'Headers'],
                ['params', 'Query Params'],
                ['body', 'Body'],
                ['auth', 'Auth Helper'],
                ['history', 'History'],
                ['collections', 'Collections'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setReqSubTab(id)}
                className={`px-3 py-2 border-b-2 transition-colors ${
                  reqSubTab === id ? 'border-[#00E5FF] text-[#00E5FF]' : 'border-transparent text-gray-400 hover:text-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 text-xs font-mono">
            {reqSubTab === 'headers' && (
              <textarea
                className="w-full h-full min-h-[260px] bg-[#12151D] border border-gray-800 rounded-lg p-3 text-emerald-300 focus:outline-none focus:border-[#00E5FF] resize-none"
                value={activeTab.headers}
                onChange={(e) => onUpdateTab(activeTab.id, { headers: e.target.value })}
                placeholder="Content-Type: application/json"
              />
            )}

            {reqSubTab === 'params' && (
              <div className="space-y-2">
                <div className="flex justify-between items-center text-gray-400">
                  <span>Query Parameters (synced automatically with URL)</span>
                  <button
                    onClick={addQueryParam}
                    className="px-2.5 py-1 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                  >
                    + Add Parameter
                  </button>
                </div>
                {queryParams.length === 0 && <div className="text-gray-600 italic">No query parameters in URL.</div>}
                {queryParams.map(([k, v], i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={k}
                      onChange={(e) => updateQueryParam(i, e.target.value, v)}
                      className="flex-1 bg-[#12151D] border border-gray-700 rounded px-2 py-1 text-indigo-300"
                    />
                    <input
                      value={v}
                      onChange={(e) => updateQueryParam(i, k, e.target.value)}
                      className="flex-1 bg-[#12151D] border border-gray-700 rounded px-2 py-1 text-gray-200"
                    />
                  </div>
                ))}
              </div>
            )}

            {reqSubTab === 'body' && (
              <textarea
                className="w-full h-full min-h-[260px] bg-[#12151D] border border-gray-800 rounded-lg p-3 text-gray-200 focus:outline-none focus:border-[#00E5FF] resize-none"
                value={activeTab.body}
                onChange={(e) => onUpdateTab(activeTab.id, { body: e.target.value })}
                placeholder="Request body..."
              />
            )}

            {reqSubTab === 'auth' && (
              <div className="space-y-3 bg-[#141720] p-4 rounded-xl border border-gray-800">
                <div className="flex items-center gap-2 text-gray-200 font-bold font-sans">
                  <KeyRound className="w-4 h-4 text-amber-400" /> Quick Authentication Header Builder
                </div>
                <select
                  value={authType}
                  onChange={(e) => setAuthType(e.target.value as 'bearer' | 'basic' | 'apikey')}
                  className="w-full bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200"
                >
                  <option value="bearer">Bearer Token (Authorization: Bearer ...)</option>
                  <option value="basic">Basic Auth (username:password)</option>
                  <option value="apikey">Custom API Key Header</option>
                </select>
                {authType === 'apikey' && (
                  <input
                    value={authKeyName}
                    onChange={(e) => setAuthKeyName(e.target.value)}
                    placeholder="Header Name (e.g. X-API-Key)"
                    className="w-full bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200"
                  />
                )}
                <input
                  value={authValue}
                  onChange={(e) => setAuthValue(e.target.value)}
                  placeholder={authType === 'basic' ? 'username:password' : 'Token or API key value'}
                  className="w-full bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200"
                />
                <button
                  onClick={applyAuthHeader}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold"
                >
                  Inject into Headers
                </button>
              </div>
            )}

            {reqSubTab === 'history' && (
              <div className="space-y-1.5">
                {activeTab.history.length === 0 && (
                  <div className="text-gray-600 italic flex items-center gap-2">
                    <History className="w-4 h-4" /> No requests sent from this tab yet.
                  </div>
                )}
                {activeTab.history.map((h, i) => (
                  <div
                    key={i}
                    onClick={() => onUpdateTab(activeTab.id, { method: h.method, url: h.url })}
                    className="p-2.5 rounded-lg bg-[#141720] border border-gray-800 hover:border-gray-700 cursor-pointer flex justify-between"
                  >
                    <span className="truncate">
                      <span className="text-indigo-400 font-bold mr-2">{h.method}</span>
                      {h.url}
                    </span>
                    <span className="text-gray-400 shrink-0 ml-2">
                      {h.statusCode} · {h.durationMs}ms
                    </span>
                  </div>
                ))}
              </div>
            )}

            {reqSubTab === 'collections' && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    value={newCollectionName}
                    onChange={(e) => setNewCollectionName(e.target.value)}
                    placeholder="New collection name..."
                    className="flex-1 bg-[#12151D] border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200"
                  />
                  <button
                    onClick={async () => {
                      if (!newCollectionName.trim()) return;
                      await apiFetch('/api/collections', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: newCollectionName.trim() }),
                      });
                      setNewCollectionName('');
                      loadCollections();
                    }}
                    className="px-3 py-1.5 bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 rounded-lg flex items-center gap-1"
                  >
                    <FolderPlus className="w-3.5 h-3.5" /> Create
                  </button>
                </div>
                {collections.map((c) => {
                  const items = savedRequests.filter((r) => r.collectionId === c.id);
                  return (
                    <div key={c.id} className="p-3 rounded-xl bg-[#141720] border border-gray-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-gray-200">{c.name}</span>
                        <button
                          onClick={async () => {
                            await apiFetch(`/api/collections/${encodeURIComponent(c.id)}/requests`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                name: activeTab.title,
                                method: activeTab.method,
                                url: activeTab.url,
                                headers: parseRawHeaders(activeTab.headers),
                                body: activeTab.body,
                              }),
                            });
                            loadCollections();
                          }}
                          className="text-[11px] px-2.5 py-0.5 bg-emerald-500/15 text-emerald-300 rounded border border-emerald-500/30"
                        >
                          + Save Current Tab
                        </button>
                      </div>
                      {items.map((item) => (
                        <div
                          key={item.id}
                          onClick={() =>
                            onUpdateTab(activeTab.id, {
                              method: item.method,
                              url: item.url,
                              headers: Object.entries(item.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
                              body: item.body || '',
                            })
                          }
                          className="p-2 rounded bg-[#0B0D12] hover:bg-gray-800/70 cursor-pointer flex justify-between text-[11px]"
                        >
                          <span className="truncate">
                            <span className="text-indigo-400 mr-1.5">{item.method}</span>
                            {item.name}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Response Viewer */}
        <div className="flex-1 flex flex-col bg-[#0D1017] min-w-0">
          {activeTab.response ? (
            <>
              <div className="h-9 border-b border-gray-800 bg-[#141720] px-3 flex items-center justify-between text-[11px] font-mono shrink-0">
                <div className="flex items-center gap-3">
                  <span className={`font-bold ${statusCategoryLabel(activeTab.response.status_code).color}`}>
                    {activeTab.response.status_code} ({statusCategoryLabel(activeTab.response.status_code).label})
                  </span>
                  <span className="text-gray-400">{activeTab.response.duration_ms}ms</span>
                  <span className="text-gray-500">{activeTab.response.bodySize ?? activeTab.response.body.length} B</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {(['pretty', 'headers', 'raw'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setResSubTab(t)}
                      className={`px-2 py-0.5 rounded capitalize ${
                        resSubTab === t ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                  {activeTab.previousResponse && (
                    <button
                      onClick={() => setShowCompare((v) => !v)}
                      className={`px-2 py-0.5 rounded border flex items-center gap-1 ${
                        showCompare ? 'bg-[#00E5FF]/20 border-[#00E5FF]/40 text-[#00E5FF]' : 'border-gray-700 text-gray-400'
                      }`}
                    >
                      <GitCompare className="w-3 h-3" /> Delta
                    </button>
                  )}
                  {onSendToComparer && (
                    <button
                      onClick={() =>
                        onSendToComparer('right', `Repeater: ${activeTab.method} ${activeTab.url}`, activeTab.response?.body || '')
                      }
                      className="px-2 py-0.5 rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
                    >
                      To Comparer
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed">
                {showCompare && activeTab.previousResponse && (
                  <div className="mb-4 p-2.5 rounded-lg bg-[#141720] border border-gray-800 text-[11px]">
                    <div className="text-[#00E5FF] font-bold mb-1">
                      Comparison vs Previous ({activeTab.previousResponse.status_code} · {activeTab.previousResponse.duration_ms}ms)
                    </div>
                    <div>
                      Size Δ: {activeTab.response.body.length - activeTab.previousResponse.body.length} B · Time Δ:{' '}
                      {activeTab.response.duration_ms - activeTab.previousResponse.duration_ms}ms
                    </div>
                  </div>
                )}

                {resSubTab === 'raw' ? (
                  <pre className="whitespace-pre-wrap break-all text-gray-300">
                    {[
                      `HTTP/1.1 ${activeTab.response.status_code}`,
                      ...Object.entries(activeTab.response.headers || {}).map(([k, v]) => `${k}: ${v}`),
                      '',
                      activeTab.response.body,
                    ].join('\n')}
                  </pre>
                ) : resSubTab === 'headers' ? (
                  <div className="space-y-1">
                    {Object.entries(activeTab.response.headers || {}).map(([k, v]) => (
                      <div key={k} className="text-gray-300 break-all border-b border-gray-800/40 pb-1">
                        <span className="text-emerald-300">{k}:</span> {v}
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    <div className="space-y-0.5 mb-3">
                      {Object.entries(activeTab.response.headers || {}).map(([k, v]) => (
                        <div key={k} className="text-gray-300 break-all">
                          {k}: <span className="text-gray-500">{v}</span>
                        </div>
                      ))}
                    </div>
                    <PrettyViewer
                      body={activeTab.response.body}
                      bodySize={activeTab.response.bodySize}
                      bodyTruncated={activeTab.response.bodyTruncated}
                    />
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-600 italic space-y-2 opacity-50">
              <Activity className="w-10 h-10" />
              <p className="text-xs">Click Send to execute request and inspect response</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
