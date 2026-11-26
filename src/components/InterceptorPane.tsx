import React, { useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  Filter,
  Globe,
  Loader2,
  Pause,
  Play,
  Plus,
  Repeat,
  Shield,
  Sparkles,
  Target,
  X,
} from 'lucide-react';
import type { BreakpointRule, InterceptItem, ReplaceRule } from '../types/proxy';
import { apiFetch } from '../lib/api';

interface InterceptorPaneProps {
  mode?: 'queue' | 'rules';
  interceptMode: boolean;
  responseInterceptMode: boolean;
  activeIntercepts: InterceptItem[];
  ignoredDomains: string[];
  onToggleIntercept: (enabled: boolean) => void;
  onToggleResponseIntercept: (enabled: boolean) => void;
  onResolveIntercept: (
    id: string,
    action: 'forward' | 'drop',
    edits?: {
      modifiedMethod?: string;
      modifiedUrl?: string;
      modifiedHeaders?: Record<string, string>;
      modifiedBody?: string;
      interceptResponse?: boolean;
    }
  ) => void;
  onUpdateIgnoredDomains: (domains: string[]) => void;
  onSendToRepeater: (method: string, url: string, headers: string, body: string) => void;
  onSendToIntruder: (method: string, url: string, headers: string, body: string) => void;
  onSendToDecoder?: (text: string) => void;
}

export function InterceptorPane({
  mode = 'queue',
  interceptMode,
  responseInterceptMode,
  activeIntercepts,
  ignoredDomains,
  onToggleIntercept,
  onToggleResponseIntercept,
  onResolveIntercept,
  onUpdateIgnoredDomains,
  onSendToRepeater,
  onSendToIntruder,
  onSendToDecoder,
}: InterceptorPaneProps) {
  const active = activeIntercepts[0];
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [body, setBody] = useState('');
  const [interceptResponseFlag, setInterceptResponseFlag] = useState(false);
  const [newIgnore, setNewIgnore] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [rulesTab, setRulesTab] = useState<'rules' | 'breakpoints' | 'bypass'>('rules');
  const [viewFmt, setViewFmt] = useState<'pretty' | 'raw'>('pretty');

  const [rules, setRules] = useState<ReplaceRule[]>([]);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [breakpoints, setBreakpoints] = useState<BreakpointRule[]>([]);

  useEffect(() => {
    if (!active) return;
    setMethod(active.kind === 'response' ? String(active.statusCode || 200) : active.method);
    setUrl(active.url);
    setHeaders(
      Object.entries(active.headers || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    );
    setBody(active.body || '');
    setInterceptResponseFlag(false);
  }, [active?.id, active?.kind]);

  useEffect(() => {
    if (mode === 'rules') {
      apiFetch('/api/rules').then((r) => r.json()).then((d) => Array.isArray(d) && setRules(d)).catch(() => {});
      apiFetch('/api/settings')
        .then((r) => r.json())
        .then((d) => Array.isArray(d.breakpointRules) && setBreakpoints(d.breakpointRules))
        .catch(() => {});
    }
  }, [mode]);

  const parseRawHeaders = (raw: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) out[k] = v;
      }
    }
    return out;
  };

  const saveRules = async (next: ReplaceRule[]) => {
    setRuleError(null);
    setRules(next);
    const res = await apiFetch('/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    const data = await res.json();
    if (!res.ok) setRuleError(data.error || 'Failed to save rules');
    else if (Array.isArray(data.rules)) setRules(data.rules);
  };

  const saveBreakpoints = async (next: BreakpointRule[]) => {
    setBreakpoints(next);
    await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ breakpointRules: next }),
    });
  };

  const analyzeIntercept = async () => {
    if (!active) return;
    setIsAnalyzing(true);
    try {
      const res = await apiFetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: active.method,
          url: active.url,
          headers: parseRawHeaders(headers),
          body,
        }),
      });
      const data = await res.json();
      if (data.text) setBody((prev) => `${prev}\n\n/* AI ANALYSIS:\n${data.text}\n*/`);
      else if (data.error) alert(data.error);
    } finally {
      setIsAnalyzing(false);
    }
  };

  if (mode === 'rules') {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[#0B0D12] p-5 space-y-4 overflow-auto text-xs">
        <div className="flex items-center gap-2 border-b border-gray-800 pb-3">
          {(
            [
              ['rules', 'Match & Replace Rules'],
              ['breakpoints', 'Conditional Breakpoints'],
              ['bypass', 'Bypass / Ignored Domains'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setRulesTab(id)}
              className={`px-3 py-1.5 rounded-lg font-semibold border ${
                rulesTab === id
                  ? 'bg-[#00E5FF]/15 border-[#00E5FF]/40 text-[#00E5FF]'
                  : 'bg-[#141720] border-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {rulesTab === 'rules' && (
          <div className="space-y-3">
            <div className="flex justify-between items-center flex-wrap gap-2">
              <p className="text-gray-400">
                Automatically rewrite matching URLs, Headers, or Bodies as traffic passes through the proxy (ReDoS-validated).
              </p>
              <button
                onClick={() =>
                  saveRules([
                    ...rules,
                    { id: crypto.randomUUID(), type: 'header', phase: 'request', match: '', replace: '', active: true },
                  ])
                }
                className="px-3 py-1.5 bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 rounded-lg flex items-center gap-1 font-semibold"
              >
                <Plus className="w-3.5 h-3.5" /> Add Rule
              </button>
            </div>
            {ruleError && (
              <div className="p-2.5 bg-red-950/40 border border-red-500/40 text-red-300 rounded-lg">{ruleError}</div>
            )}
            {rules.length === 0 && (
              <div className="p-8 text-center text-gray-500 border border-dashed border-gray-800 rounded-xl">
                No Match & Replace rules configured. Click "Add Rule" to create one.
              </div>
            )}
            {rules.map((rule, idx) => (
              <div key={rule.id} className="p-3 bg-[#141720] border border-gray-800 rounded-xl grid grid-cols-1 md:grid-cols-5 gap-2 items-center font-mono">
                <select
                  value={rule.type}
                  onChange={(e) => {
                    const next = [...rules];
                    next[idx] = { ...rule, type: e.target.value as any };
                    saveRules(next);
                  }}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200"
                >
                  <option value="url">URL</option>
                  <option value="header">Header</option>
                  <option value="body">Body</option>
                </select>
                <select
                  value={rule.phase || 'request'}
                  onChange={(e) => {
                    const next = [...rules];
                    next[idx] = { ...rule, phase: e.target.value as any };
                    saveRules(next);
                  }}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200"
                >
                  <option value="request">Request</option>
                  <option value="response">Response</option>
                  <option value="both">Both</option>
                </select>
                <input
                  value={rule.match}
                  onChange={(e) => {
                    const next = [...rules];
                    next[idx] = { ...rule, match: e.target.value };
                    saveRules(next);
                  }}
                  placeholder="Match regex..."
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2.5 py-1.5 text-gray-200"
                />
                <input
                  value={rule.replace}
                  onChange={(e) => {
                    const next = [...rules];
                    next[idx] = { ...rule, replace: e.target.value };
                    saveRules(next);
                  }}
                  placeholder="Replace with..."
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2.5 py-1.5 text-gray-200"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => {
                      const next = [...rules];
                      next[idx] = { ...rule, active: !rule.active };
                      saveRules(next);
                    }}
                    className={`px-3 py-1 rounded-lg border font-bold ${
                      rule.active ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-gray-800 text-gray-500 border-gray-700'
                    }`}
                  >
                    {rule.active ? 'Enabled' : 'Disabled'}
                  </button>
                  <button
                    onClick={() => saveRules(rules.filter((r) => r.id !== rule.id))}
                    className="text-gray-500 hover:text-red-400 p-1"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {rulesTab === 'breakpoints' && (
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <p className="text-gray-400">
                Pause matching requests or responses automatically in the Intercept queue even when the master toggle is OFF.
              </p>
              <button
                onClick={() =>
                  saveBreakpoints([
                    ...breakpoints,
                    {
                      id: crypto.randomUUID(),
                      name: 'API POST Breakpoint',
                      enabled: true,
                      phase: 'request',
                      hostPattern: '',
                      pathPattern: '/api/',
                      methods: ['POST'],
                    },
                  ])
                }
                className="px-3 py-1.5 bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 rounded-lg flex items-center gap-1 font-semibold"
              >
                <Plus className="w-3.5 h-3.5" /> Add Breakpoint
              </button>
            </div>
            {breakpoints.map((bp, idx) => (
              <div key={bp.id} className="p-3 bg-[#141720] border border-gray-800 rounded-xl grid grid-cols-1 md:grid-cols-5 gap-2 items-center font-mono">
                <input
                  value={bp.name}
                  onChange={(e) => {
                    const next = [...breakpoints];
                    next[idx] = { ...bp, name: e.target.value };
                    saveBreakpoints(next);
                  }}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2.5 py-1.5 text-gray-200"
                />
                <select
                  value={bp.phase}
                  onChange={(e) => {
                    const next = [...breakpoints];
                    next[idx] = { ...bp, phase: e.target.value as any };
                    saveBreakpoints(next);
                  }}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200"
                >
                  <option value="request">Request</option>
                  <option value="response">Response</option>
                  <option value="both">Both</option>
                </select>
                <input
                  value={bp.hostPattern || ''}
                  onChange={(e) => {
                    const next = [...breakpoints];
                    next[idx] = { ...bp, hostPattern: e.target.value };
                    saveBreakpoints(next);
                  }}
                  placeholder="Host regex (optional)"
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2.5 py-1.5 text-gray-200"
                />
                <input
                  value={bp.pathPattern || ''}
                  onChange={(e) => {
                    const next = [...breakpoints];
                    next[idx] = { ...bp, pathPattern: e.target.value };
                    saveBreakpoints(next);
                  }}
                  placeholder="Path regex (e.g. /login)"
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2.5 py-1.5 text-gray-200"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => {
                      const next = [...breakpoints];
                      next[idx] = { ...bp, enabled: !bp.enabled };
                      saveBreakpoints(next);
                    }}
                    className={`px-3 py-1 rounded-lg border font-bold ${
                      bp.enabled ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-gray-800 text-gray-500 border-gray-700'
                    }`}
                  >
                    {bp.enabled ? 'Active' : 'Off'}
                  </button>
                  <button
                    onClick={() => saveBreakpoints(breakpoints.filter((b) => b.id !== bp.id))}
                    className="text-gray-500 hover:text-red-400 p-1"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {rulesTab === 'bypass' && (
          <div className="p-4 rounded-xl bg-[#141720] border border-gray-800 space-y-3 max-w-2xl">
            <div className="font-semibold text-white flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-400" /> Domains Ignored During Interception
            </div>
            <p className="text-gray-400">
              Requests to these domains still appear in HTTP History, but are never paused in the Intercept queue (useful for browser telemetry or CDNs).
            </p>
            <div className="flex gap-2">
              <input
                value={newIgnore}
                onChange={(e) => setNewIgnore(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newIgnore.trim()) {
                    const d = newIgnore.trim().toLowerCase();
                    if (!ignoredDomains.includes(d)) onUpdateIgnoredDomains([...ignoredDomains, d]);
                    setNewIgnore('');
                  }
                }}
                placeholder="e.g. googleapis.com"
                className="flex-1 bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 font-mono text-gray-200"
              />
              <button
                onClick={() => {
                  const d = newIgnore.trim().toLowerCase();
                  if (d && !ignoredDomains.includes(d)) onUpdateIgnoredDomains([...ignoredDomains, d]);
                  setNewIgnore('');
                }}
                className="px-3 py-1.5 bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 rounded-lg font-semibold"
              >
                Add Domain
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {ignoredDomains.map((d) => (
                <span
                  key={d}
                  className="bg-[#0B0D12] border border-gray-700 rounded-full px-3 py-1 text-gray-200 font-mono flex items-center gap-1.5"
                >
                  <Globe className="w-3 h-3 text-gray-500" />
                  {d}
                  <button
                    onClick={() => onUpdateIgnoredDomains(ignoredDomains.filter((x) => x !== d))}
                    className="hover:text-red-400"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Burp-style Intercept Queue View
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0B0D12]">
      {/* Prominent Burp-Style Action Bar */}
      <div className="p-3 border-b border-gray-800 bg-[#141720] flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => onToggleIntercept(!interceptMode)}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold flex items-center gap-2 border transition-all ${
              interceptMode
                ? 'bg-orange-500 text-black border-orange-400 shadow-lg shadow-orange-500/20'
                : 'bg-[#0B0D12] text-gray-300 border-gray-700 hover:border-gray-500'
            }`}
          >
            {interceptMode ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {interceptMode ? 'Intercept is on' : 'Intercept is off'}
          </button>

          <button
            onClick={() => onToggleResponseIntercept(!responseInterceptMode)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${
              responseInterceptMode
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                : 'bg-[#0B0D12] text-gray-400 border-gray-700 hover:text-gray-200'
            }`}
          >
            Response Intercept: {responseInterceptMode ? 'ON' : 'OFF'}
          </button>

          {active && (
            <>
              <div className="h-6 w-px bg-gray-800 mx-1" />
              <button
                onClick={() =>
                  onResolveIntercept(active.id, 'forward', {
                    modifiedMethod: active.kind === 'request' ? method : undefined,
                    modifiedUrl: active.kind === 'request' ? url : undefined,
                    modifiedHeaders: parseRawHeaders(headers),
                    modifiedBody: body,
                    interceptResponse: interceptResponseFlag,
                  })
                }
                className="px-4 py-1.5 bg-[#00E5FF] hover:bg-[#33ECFF] text-black rounded-lg text-xs font-bold"
              >
                Forward
              </button>
              <button
                onClick={() => onResolveIntercept(active.id, 'drop')}
                className="px-4 py-1.5 bg-red-600/25 hover:bg-red-600/40 text-red-300 rounded-lg text-xs font-bold border border-red-500/40"
              >
                Drop
              </button>
            </>
          )}
        </div>

        {active && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onSendToRepeater(active.method, url, headers, body)}
              className="px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg text-xs flex items-center gap-1 border border-gray-700"
            >
              <Repeat className="w-3.5 h-3.5 text-emerald-400" /> To Repeater
            </button>
            <button
              onClick={() => onSendToIntruder(active.method, url, headers, body)}
              className="px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg text-xs flex items-center gap-1 border border-gray-700"
            >
              <Target className="w-3.5 h-3.5 text-indigo-400" /> To Intruder
            </button>
            {onSendToDecoder && (
              <button
                onClick={() => onSendToDecoder(body || url)}
                className="px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg text-xs flex items-center gap-1 border border-gray-700"
              >
                <ArrowRightLeft className="w-3.5 h-3.5 text-[#00E5FF]" /> Decoder
              </button>
            )}
            <button
              onClick={analyzeIntercept}
              disabled={isAnalyzing}
              className="px-2.5 py-1.5 bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 rounded-lg text-xs flex items-center gap-1 border border-purple-500/30"
            >
              {isAnalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              AI Audit
            </button>
          </div>
        )}
      </div>

      {!active ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-500 p-8 text-center">
          <Shield className="w-14 h-14 mb-3 opacity-25" />
          <div className="text-sm font-semibold text-gray-300">No Requests Currently Paused</div>
          <p className="text-xs text-gray-500 max-w-md mt-1">
            Toggle <strong>Intercept is on</strong> above, then browse through the proxy (<code className="text-gray-300">127.0.0.1:8082</code>) or send a test request from the Dashboard.
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4 space-y-3 font-mono text-xs">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="px-2.5 py-1 rounded bg-orange-500/15 text-orange-300 border border-orange-500/30 font-sans font-semibold">
              {active.kind === 'response' ? 'Intercepted Server Response' : 'Intercepted Client Request'} ({activeIntercepts.length} in queue)
            </span>

            <div className="flex items-center gap-3">
              {active.kind === 'request' && (
                <label className="flex items-center gap-2 text-amber-300 font-sans cursor-pointer">
                  <input
                    type="checkbox"
                    checked={interceptResponseFlag}
                    onChange={(e) => setInterceptResponseFlag(e.target.checked)}
                  />
                  Intercept response to this request
                </label>
              )}
              <div className="flex bg-[#141720] border border-gray-800 rounded-lg overflow-hidden">
                {(['pretty', 'raw'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setViewFmt(f)}
                    className={`px-2.5 py-1 capitalize ${viewFmt === f ? 'bg-indigo-600/30 text-indigo-300' : 'text-gray-400'}`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <input
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              disabled={active.kind === 'response'}
              className="w-24 bg-[#141720] border border-gray-700 rounded-lg px-2.5 py-1.5 font-bold text-orange-300"
            />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={active.kind === 'response'}
              className="flex-1 bg-[#141720] border border-gray-700 rounded-lg px-3 py-1.5 text-gray-200"
            />
          </div>

          {viewFmt === 'raw' ? (
            <textarea
              value={`${headers}\n\n${body}`}
              onChange={(e) => {
                const splitIdx = e.target.value.indexOf('\n\n');
                if (splitIdx >= 0) {
                  setHeaders(e.target.value.slice(0, splitIdx));
                  setBody(e.target.value.slice(splitIdx + 2));
                } else {
                  setHeaders(e.target.value);
                }
              }}
              className="w-full min-h-[380px] bg-[#141720] border border-gray-800 rounded-xl p-3 text-gray-200 resize-y"
            />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-[11px] font-sans font-semibold text-gray-400">HTTP Headers</div>
                <textarea
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                  className="w-full h-80 bg-[#141720] border border-gray-800 rounded-xl p-3 text-emerald-300 resize-none"
                />
              </div>
              <div className="space-y-1">
                <div className="text-[11px] font-sans font-semibold text-gray-400">Message Body</div>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="w-full h-80 bg-[#141720] border border-gray-800 rounded-xl p-3 text-gray-200 resize-none"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
