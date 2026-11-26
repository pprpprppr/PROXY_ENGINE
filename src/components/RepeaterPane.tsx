import React, { useEffect, useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  FolderPlus,
  GitCompare,
  History,
  KeyRound,
  Loader2,
  Plus,
  Send,
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
}: RepeaterPaneProps) {
  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const [isSending, setIsSending] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [reqSubTab, setReqSubTab] = useState<'headers' | 'params' | 'body' | 'auth' | 'history' | 'collections'>('headers');
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
      // ignore invalid URL
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
    if (authType === 'bearer') {
      current['Authorization'] = `Bearer ${authValue.trim()}`;
    } else if (authType === 'basic') {
      current['Authorization'] = `Basic ${btoa(authValue.trim())}`;
    } else {
      current[authKeyName.trim() || 'X-API-Key'] = authValue.trim();
    }
    const serialized = Object.entries(current)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    onUpdateTab(activeTab.id, { headers: serialized });
  };

  const executeRepeater = async () => {
    if (!activeTab.url.trim()) {
      onUpdateTab(activeTab.id, { error: 'Target URL is required' });
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

  const handleCopyCurl = () => {
    navigator.clipboard
      .writeText(buildCurlCommand(activeTab))
      .then(() => {
        setCopiedCurl(true);
        setTimeout(() => setCopiedCurl(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0E1015]">
      {/* Repeater Tabs Bar */}
      <div className="h-9 bg-[#12141A] border-b border-gray-800 flex items-center px-2 gap-1 overflow-x-auto shrink-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            className={`px-2.5 py-1 rounded-t text-[11px] font-mono cursor-pointer flex items-center gap-2 border-t border-x ${
              tab.id === activeTab.id
                ? 'bg-[#1C1F26] border-gray-700 text-[#00E5FF]'
                : 'bg-transparent border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <span className="truncate max-w-[120px]">{tab.title}</span>
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
          className="p-1 rounded text-gray-400 hover:text-white hover:bg-gray-800"
          title="New Repeater Tab"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Request Action Bar */}
      <div className="h-12 border-b border-gray-800 flex items-center px-3 gap-2 shrink-0 bg-[#14161C]">
        <select
          value={activeTab.method}
          onChange={(e) => onUpdateTab(activeTab.id, { method: e.target.value })}
          className="bg-[#0E1015] border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none"
        >
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input
          className="flex-1 bg-[#0E1015] border border-gray-700 rounded px-3 py-1 text-xs font-mono text-gray-300 focus:outline-none focus:border-[#00E5FF]"
          value={activeTab.url}
          onChange={(e) => onUpdateTab(activeTab.id, { url: e.target.value })}
          placeholder="https://authorized-target.example/api/resource"
        />
        <button
          onClick={handleCopyCurl}
          className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2.5 py-1.5 rounded text-xs flex items-center gap-1 border border-gray-700"
          title="Copy as cURL"
        >
          {copiedCurl ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          cURL
        </button>
        <button
          onClick={executeRepeater}
          disabled={isSending}
          className="bg-[#00E5FF]/15 hover:bg-[#00E5FF]/25 text-[#00E5FF] px-3.5 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 border border-[#00E5FF]/30 disabled:opacity-50"
        >
          {isSending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          Send
        </button>
      </div>

      {activeTab.error && (
        <div className="px-3 py-2 bg-red-950/40 border-b border-red-500/30 text-xs text-red-300 font-mono">
          {activeTab.error}
        </div>
      )}

      {/* Split Workspace */}
      <div className="flex-1 flex min-h-0 divide-x divide-gray-800 overflow-hidden">
        {/* Left: Request Editor */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex border-b border-gray-800 bg-[#14161C] text-[10px] uppercase font-bold">
            {(['headers', 'params', 'body', 'auth', 'history', 'collections'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setReqSubTab(t)}
                className={`px-3 py-2 border-b-2 transition-colors ${
                  reqSubTab === t ? 'border-[#00E5FF] text-[#00E5FF]' : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-3 text-xs font-mono">
            {reqSubTab === 'headers' && (
              <textarea
                className="w-full h-full min-h-[260px] bg-[#0A0C10] border border-gray-800 rounded p-3 text-emerald-400 focus:outline-none focus:border-[#00E5FF] resize-none"
                value={activeTab.headers}
                onChange={(e) => onUpdateTab(activeTab.id, { headers: e.target.value })}
                placeholder="Content-Type: application/json"
              />
            )}

            {reqSubTab === 'params' && (
              <div className="space-y-2">
                <div className="flex justify-between items-center text-[11px] text-gray-400">
                  <span>Query Parameters (synced with URL)</span>
                  <button
                    onClick={addQueryParam}
                    className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                  >
                    + Add Param
                  </button>
                </div>
                {queryParams.length === 0 && <div className="text-gray-600 italic">No query parameters in URL.</div>}
                {queryParams.map(([k, v], i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      value={k}
                      onChange={(e) => updateQueryParam(i, e.target.value, v)}
                      className="flex-1 bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-indigo-300"
                    />
                    <input
                      value={v}
                      onChange={(e) => updateQueryParam(i, k, e.target.value)}
                      className="flex-1 bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-300"
                    />
                  </div>
                ))}
              </div>
            )}

            {reqSubTab === 'body' && (
              <textarea
                className="w-full h-full min-h-[260px] bg-[#0A0C10] border border-gray-800 rounded p-3 text-gray-300 focus:outline-none focus:border-[#00E5FF] resize-none"
                value={activeTab.body}
                onChange={(e) => onUpdateTab(activeTab.id, { body: e.target.value })}
                placeholder="Request body..."
              />
            )}

            {reqSubTab === 'auth' && (
              <div className="space-y-3 bg-[#14161C] p-3 rounded border border-gray-800">
                <div className="flex items-center gap-2 text-gray-300 font-bold">
                  <KeyRound className="w-4 h-4 text-amber-400" /> Authentication Header Helper
                </div>
                <select
                  value={authType}
                  onChange={(e) => setAuthType(e.target.value as 'bearer' | 'basic' | 'apikey')}
                  className="w-full bg-[#0A0C10] border border-gray-700 rounded px-2 py-1.5 text-gray-300"
                >
                  <option value="bearer">Bearer Token</option>
                  <option value="basic">Basic Auth (user:password)</option>
                  <option value="apikey">Custom API Key Header</option>
                </select>
                {authType === 'apikey' && (
                  <input
                    value={authKeyName}
                    onChange={(e) => setAuthKeyName(e.target.value)}
                    placeholder="Header Name (e.g. X-API-Key)"
                    className="w-full bg-[#0A0C10] border border-gray-700 rounded px-2 py-1.5 text-gray-300"
                  />
                )}
                <input
                  value={authValue}
                  onChange={(e) => setAuthValue(e.target.value)}
                  placeholder={authType === 'basic' ? 'username:password' : 'Token / Key value'}
                  className="w-full bg-[#0A0C10] border border-gray-700 rounded px-2 py-1.5 text-gray-300"
                />
                <button
                  onClick={applyAuthHeader}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-bold"
                >
                  Apply to Headers
                </button>
              </div>
            )}

            {reqSubTab === 'history' && (
              <div className="space-y-1.5">
                {activeTab.history.length === 0 && (
                  <div className="text-gray-600 italic flex items-center gap-2">
                    <History className="w-4 h-4" /> No Repeater requests executed in this tab yet.
                  </div>
                )}
                {activeTab.history.map((h, i) => (
                  <div
                    key={i}
                    onClick={() => onUpdateTab(activeTab.id, { method: h.method, url: h.url })}
                    className="p-2 rounded bg-[#14161C] border border-gray-800 hover:border-gray-700 cursor-pointer flex justify-between"
                  >
                    <span className="truncate">
                      <span className="text-indigo-400 font-bold mr-2">{h.method}</span>
                      {h.url}
                    </span>
                    <span className="text-gray-500 shrink-0 ml-2">
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
                    className="flex-1 bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-300"
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
                    className="px-3 py-1 bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 rounded flex items-center gap-1"
                  >
                    <FolderPlus className="w-3.5 h-3.5" /> Create
                  </button>
                </div>
                {collections.map((c) => {
                  const items = savedRequests.filter((r) => r.collectionId === c.id);
                  return (
                    <div key={c.id} className="p-2 rounded bg-[#14161C] border border-gray-800 space-y-2">
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
                          className="text-[10px] px-2 py-0.5 bg-emerald-500/15 text-emerald-300 rounded border border-emerald-500/30"
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
                              headers: Object.entries(item.headers || {})
                                .map(([k, v]) => `${k}: ${v}`)
                                .join('\n'),
                              body: item.body || '',
                            })
                          }
                          className="p-1.5 rounded bg-[#0A0C10] hover:bg-gray-800/70 cursor-pointer flex justify-between text-[11px]"
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

        {/* Right: Response Viewer */}
        <div className="flex-1 flex flex-col bg-[#0A0C10] min-w-0">
          {activeTab.response ? (
            <>
              <div className="h-9 border-b border-gray-800 bg-[#14161C] px-3 flex items-center justify-between text-[11px] font-mono shrink-0">
                <div className="flex items-center gap-3">
                  <span className={`font-bold ${statusCategoryLabel(activeTab.response.status_code).color}`}>
                    {activeTab.response.status_code} ({statusCategoryLabel(activeTab.response.status_code).label})
                  </span>
                  <span className="text-gray-400">{activeTab.response.duration_ms}ms</span>
                  <span className="text-gray-500">{activeTab.response.bodySize ?? activeTab.response.body.length} B</span>
                  {activeTab.response.redirectsFollowed ? (
                    <span className="text-indigo-400">{activeTab.response.redirectsFollowed} redirect(s)</span>
                  ) : null}
                </div>
                {activeTab.previousResponse && (
                  <button
                    onClick={() => setShowCompare((v) => !v)}
                    className={`px-2 py-0.5 rounded border flex items-center gap-1 text-[10px] ${
                      showCompare
                        ? 'bg-[#00E5FF]/20 border-[#00E5FF]/40 text-[#00E5FF]'
                        : 'border-gray-700 text-gray-400'
                    }`}
                  >
                    <GitCompare className="w-3 h-3" /> Compare Prev
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed">
                {showCompare && activeTab.previousResponse && (
                  <div className="mb-4 p-2.5 rounded bg-[#14161C] border border-gray-800 text-[10px]">
                    <div className="text-[#00E5FF] font-bold mb-1">
                      Delta vs Previous ({activeTab.previousResponse.status_code} / {activeTab.previousResponse.duration_ms}ms /{' '}
                      {activeTab.previousResponse.body.length}B)
                    </div>
                    <div>
                      Size Δ: {activeTab.response.body.length - activeTab.previousResponse.body.length} bytes · Time Δ:{' '}
                      {activeTab.response.duration_ms - activeTab.previousResponse.duration_ms}ms
                    </div>
                  </div>
                )}

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
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-600 italic space-y-2 opacity-40">
              <Activity className="w-10 h-10" />
              <p className="text-[10px] uppercase font-bold tracking-widest">Awaiting execution</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
