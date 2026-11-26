import React, { useEffect, useState } from 'react';
import { Filter, Globe, Loader2, Pause, Plus, Repeat, Shield, Sparkles, Target, X } from 'lucide-react';
import type { BreakpointRule, InterceptItem, ReplaceRule } from '../types/proxy';
import { apiFetch } from '../lib/api';

interface InterceptorPaneProps {
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
}

export function InterceptorPane({
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
}: InterceptorPaneProps) {
  const active = activeIntercepts[0];
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [body, setBody] = useState('');
  const [interceptResponseFlag, setInterceptResponseFlag] = useState(false);
  const [newIgnore, setNewIgnore] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [subTab, setSubTab] = useState<'queue' | 'breakpoints' | 'rules'>('queue');

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
    if (subTab === 'rules') {
      apiFetch('/api/rules').then((r) => r.json()).then((d) => Array.isArray(d) && setRules(d)).catch(() => {});
    } else if (subTab === 'breakpoints') {
      apiFetch('/api/settings')
        .then((r) => r.json())
        .then((d) => Array.isArray(d.breakpointRules) && setBreakpoints(d.breakpointRules))
        .catch(() => {});
    }
  }, [subTab]);

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
    if (!res.ok) {
      setRuleError(data.error || 'Failed to save rules');
    } else if (Array.isArray(data.rules)) {
      setRules(data.rules);
    }
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
      if (data.text) {
        setBody((prev) => `${prev}\n\n/* AI ANALYSIS:\n${data.text}\n*/`);
      } else if (data.error) {
        alert(data.error);
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 font-mono text-xs bg-[#0E1015]">
      {/* Toolbar */}
      <div className="h-11 border-b border-gray-800 bg-[#14161C] flex items-center px-3 gap-2 shrink-0 flex-wrap">
        <button
          onClick={() => onToggleIntercept(!interceptMode)}
          className={`px-3 py-1 rounded font-bold uppercase border flex items-center gap-1.5 ${
            interceptMode
              ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
              : 'bg-gray-800 text-gray-500 border-gray-700'
          }`}
        >
          <Pause className="w-3 h-3" /> Req: {interceptMode ? 'ON' : 'OFF'}
        </button>

        <button
          onClick={() => onToggleResponseIntercept(!responseInterceptMode)}
          className={`px-3 py-1 rounded font-bold uppercase border flex items-center gap-1.5 ${
            responseInterceptMode
              ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
              : 'bg-gray-800 text-gray-500 border-gray-700'
          }`}
        >
          <Pause className="w-3 h-3" /> Res: {responseInterceptMode ? 'ON' : 'OFF'}
        </button>

        <div className="flex bg-[#0E1015] border border-gray-800 rounded overflow-hidden ml-2">
          {(['queue', 'breakpoints', 'rules'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setSubTab(t)}
              className={`px-2.5 py-1 uppercase text-[10px] font-bold ${
                subTab === t ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {t === 'queue' ? `Queue (${activeIntercepts.length})` : t === 'breakpoints' ? 'Breakpoints' : 'Match & Replace'}
            </button>
          ))}
        </div>

        {active && subTab === 'queue' && (
          <div className="ml-auto flex items-center gap-1.5">
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
              className="px-3 py-1 bg-[#00E5FF]/20 hover:bg-[#00E5FF]/30 text-[#00E5FF] rounded font-bold border border-[#00E5FF]/30"
            >
              Forward
            </button>
            <button
              onClick={() => onResolveIntercept(active.id, 'drop')}
              className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded font-bold border border-red-500/30"
            >
              Drop
            </button>
            <button
              onClick={() => onSendToRepeater(active.method, url, headers, body)}
              className="px-2 py-1 bg-gray-800 text-gray-300 rounded border border-gray-700 flex items-center gap-1"
            >
              <Repeat className="w-3 h-3" />
            </button>
            <button
              onClick={() => onSendToIntruder(active.method, url, headers, body)}
              className="px-2 py-1 bg-indigo-900/40 text-indigo-300 rounded border border-indigo-500/30 flex items-center gap-1"
            >
              <Target className="w-3 h-3" />
            </button>
            <button
              onClick={analyzeIntercept}
              disabled={isAnalyzing}
              className="px-2 py-1 bg-purple-500/20 text-purple-300 rounded border border-purple-500/30 flex items-center gap-1"
            >
              {isAnalyzing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            </button>
          </div>
        )}
      </div>

      {/* Ignored Domains Strip */}
      <div className="bg-[#14161C] border-b border-gray-800 px-3 py-2 flex items-center gap-2 overflow-x-auto shrink-0">
        <Filter className="w-3.5 h-3.5 text-gray-500 shrink-0" />
        <span className="text-[10px] uppercase font-bold text-gray-500 shrink-0">Bypass Domains:</span>
        {ignoredDomains.map((d) => (
          <span
            key={d}
            className="bg-gray-800/60 border border-gray-700 rounded-full px-2 py-0.5 text-[10px] text-gray-300 flex items-center gap-1 shrink-0"
          >
            <Globe className="w-2.5 h-2.5 text-gray-500" />
            {d}
            <button
              onClick={() => onUpdateIgnoredDomains(ignoredDomains.filter((x) => x !== d))}
              className="hover:text-red-400"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
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
          placeholder="+ Add ignored domain (Enter)"
          className="bg-transparent text-[11px] text-indigo-300 placeholder:text-gray-600 outline-none w-44"
        />
      </div>

      {subTab === 'queue' &&
        (!active ? (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-600 opacity-60">
            <Shield className="w-14 h-14 mb-2" />
            <div className="font-bold text-gray-400">Intercept Queue Empty</div>
            <div className="text-[11px]">Enable Req/Res Intercept or configure a Breakpoint rule.</div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-4 space-y-3 bg-[#0A0C10]">
            {active.kind === 'request' && (
              <label className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/30 px-2.5 py-1.5 rounded w-max text-orange-300">
                <input
                  type="checkbox"
                  checked={interceptResponseFlag}
                  onChange={(e) => setInterceptResponseFlag(e.target.checked)}
                />
                Also intercept response for this request
              </label>
            )}
            <div className="flex gap-2">
              <input
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                disabled={active.kind === 'response'}
                className="w-24 bg-[#14161C] border border-gray-700 rounded px-2 py-1.5 font-bold text-orange-300"
              />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={active.kind === 'response'}
                className="flex-1 bg-[#14161C] border border-gray-700 rounded px-3 py-1.5 text-gray-200"
              />
            </div>
            <div>
              <div className="text-[10px] uppercase text-gray-500 font-bold mb-1">Headers</div>
              <textarea
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
                className="w-full h-36 bg-[#14161C] border border-gray-700 rounded p-2.5 text-emerald-400 resize-none"
              />
            </div>
            <div className="flex-1 flex flex-col">
              <div className="text-[10px] uppercase text-gray-500 font-bold mb-1">Body</div>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="w-full min-h-[220px] bg-[#14161C] border border-gray-700 rounded p-2.5 text-gray-200 resize-y"
              />
            </div>
          </div>
        ))}

      {subTab === 'breakpoints' && (
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-gray-400">Conditional Breakpoint Rules (pause matching traffic even when global toggle is OFF)</span>
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
              className="px-2.5 py-1 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add Breakpoint
            </button>
          </div>
          {breakpoints.map((bp, idx) => (
            <div key={bp.id} className="p-3 bg-[#14161C] border border-gray-800 rounded grid grid-cols-5 gap-2 items-center">
              <input
                value={bp.name}
                onChange={(e) => {
                  const next = [...breakpoints];
                  next[idx] = { ...bp, name: e.target.value };
                  saveBreakpoints(next);
                }}
                className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-200"
              />
              <select
                value={bp.phase}
                onChange={(e) => {
                  const next = [...breakpoints];
                  next[idx] = { ...bp, phase: e.target.value as any };
                  saveBreakpoints(next);
                }}
                className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-300"
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
                placeholder="Host regex"
                className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-300"
              />
              <input
                value={bp.pathPattern || ''}
                onChange={(e) => {
                  const next = [...breakpoints];
                  next[idx] = { ...bp, pathPattern: e.target.value };
                  saveBreakpoints(next);
                }}
                placeholder="Path regex"
                className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-300"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => {
                    const next = [...breakpoints];
                    next[idx] = { ...bp, enabled: !bp.enabled };
                    saveBreakpoints(next);
                  }}
                  className={`px-2 py-1 rounded border ${
                    bp.enabled ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-gray-800 text-gray-500 border-gray-700'
                  }`}
                >
                  {bp.enabled ? 'ON' : 'OFF'}
                </button>
                <button
                  onClick={() => saveBreakpoints(breakpoints.filter((b) => b.id !== bp.id))}
                  className="text-gray-500 hover:text-red-400"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {subTab === 'rules' && (
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-gray-400">Match & Replace Rules (ReDoS-validated)</span>
            <button
              onClick={() =>
                saveRules([
                  ...rules,
                  { id: crypto.randomUUID(), type: 'header', phase: 'request', match: '', replace: '', active: true },
                ])
              }
              className="px-2.5 py-1 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add Rule
            </button>
          </div>
          {ruleError && (
            <div className="p-2 bg-red-950/40 border border-red-500/40 text-red-300 rounded">{ruleError}</div>
          )}
          {rules.map((rule, idx) => (
            <div key={rule.id} className="p-3 bg-[#14161C] border border-gray-800 rounded grid grid-cols-5 gap-2 items-center">
              <select
                value={rule.type}
                onChange={(e) => {
                  const next = [...rules];
                  next[idx] = { ...rule, type: e.target.value as any };
                  saveRules(next);
                }}
                className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-300"
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
                className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-300"
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
                placeholder="Regex pattern"
                className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-200"
              />
              <input
                value={rule.replace}
                onChange={(e) => {
                  const next = [...rules];
                  next[idx] = { ...rule, replace: e.target.value };
                  saveRules(next);
                }}
                placeholder="Replace with"
                className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-200"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => {
                    const next = [...rules];
                    next[idx] = { ...rule, active: !rule.active };
                    saveRules(next);
                  }}
                  className={`px-2 py-1 rounded border ${
                    rule.active ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-gray-800 text-gray-500 border-gray-700'
                  }`}
                >
                  {rule.active ? 'Active' : 'Off'}
                </button>
                <button
                  onClick={() => saveRules(rules.filter((r) => r.id !== rule.id))}
                  className="text-gray-500 hover:text-red-400"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
