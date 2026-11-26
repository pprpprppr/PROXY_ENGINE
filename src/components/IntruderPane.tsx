import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  Loader2,
  Pause,
  Play,
  ShieldCheck,
  Sliders,
  Square,
  Target,
  X,
} from 'lucide-react';
import type { IntruderResultItem } from '../types/proxy';
import { apiFetch } from '../lib/api';
import { PrettyViewer } from './PrettyViewer';

interface IntruderPaneProps {
  method: string;
  url: string;
  headers: string;
  body: string;
  onChangeMethod: (m: string) => void;
  onChangeUrl: (u: string) => void;
  onChangeHeaders: (h: string) => void;
  onChangeBody: (b: string) => void;
  activeJobId: string | null;
  jobStatus: 'idle' | 'running' | 'paused' | 'stopped' | 'completed';
  progress: { current: number; total: number };
  results: IntruderResultItem[];
  baseline: IntruderResultItem | null;
  onJobStarted: (jobId: string, total: number, baseline: IntruderResultItem) => void;
  onJobStatusChange: (status: 'idle' | 'running' | 'paused' | 'stopped' | 'completed') => void;
}

const PAYLOAD_PRESETS: Array<{ name: string; items: string }> = [
  { name: 'Common Endpoints', items: 'admin\nlogin\nhealth\nstatus\nconfig\nmetrics\napi\nusers\ndebug\nswagger' },
  { name: 'Numeric IDs (1-25)', items: Array.from({ length: 25 }, (_, i) => String(i + 1)).join('\n') },
  { name: 'Auth / Role Words', items: 'guest\nuser\nadmin\nsuperadmin\noperator\nviewer\ntest\nnull' },
  { name: 'Input Boundary Probes', items: "test\n'\n\"\n1 OR 1=1\n<probe>\n../\n%00\n999999999" },
];

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

export function IntruderPane({
  method,
  url,
  headers,
  body,
  onChangeMethod,
  onChangeUrl,
  onChangeHeaders,
  onChangeBody,
  activeJobId,
  jobStatus,
  progress,
  results,
  baseline,
  onJobStarted,
  onJobStatusChange,
}: IntruderPaneProps) {
  const [subTab, setSubTab] = useState<'target' | 'payloads' | 'options' | 'results'>('target');
  const [payloadText, setPayloadText] = useState("admin\ntest\n12345\nstatus\nhealth");
  const [concurrency, setConcurrency] = useState(5);
  const [delayMs, setDelayMs] = useState(0);
  const [jitterMs, setJitterMs] = useState(0);
  const [maxPayloads, setMaxPayloads] = useState(100);
  const [maxDurationSec, setMaxDurationSec] = useState(60);
  const [requestTimeoutMs, setRequestTimeoutMs] = useState(10000);
  const [rotateUA, setRotateUA] = useState(false);
  const [onlyAnomalies, setOnlyAnomalies] = useState(false);
  const [sortBy, setSortBy] = useState<'index' | 'status' | 'length' | 'time'>('index');
  const [sortDesc, setSortDesc] = useState(false);
  const [selectedResult, setSelectedResult] = useState<IntruderResultItem | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const payloadsList = useMemo(
    () => payloadText.split('\n').map((p) => p.trim()).filter(Boolean),
    [payloadText]
  );

  const sortedResults = useMemo(() => {
    const list = onlyAnomalies ? results.filter((r) => r.isAnomaly) : results;
    return [...list].sort((a, b) => {
      let diff = 0;
      if (sortBy === 'index') diff = a.index - b.index;
      else if (sortBy === 'status') diff = a.statusCode - b.statusCode;
      else if (sortBy === 'length') diff = a.length - b.length;
      else if (sortBy === 'time') diff = a.duration - b.duration;
      return sortDesc ? -diff : diff;
    });
  }, [results, onlyAnomalies, sortBy, sortDesc]);

  const startFuzz = async () => {
    setErrorMsg(null);
    if (!url.trim()) {
      setErrorMsg('Enter a target URL in Step 1 (Target & Positions).');
      setSubTab('target');
      return;
    }
    if (payloadsList.length === 0) {
      setErrorMsg('Add at least one payload in Step 2 (Payloads).');
      setSubTab('payloads');
      return;
    }
    try {
      const res = await apiFetch('/api/intruder/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          url,
          headers: parseRawHeaders(headers),
          body,
          payloads: payloadsList,
          concurrency,
          delayMs,
          jitterMs,
          maxPayloads,
          maxDurationMs: maxDurationSec * 1000,
          requestTimeoutMs,
          rotateUserAgent: rotateUA,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'Failed to start Intruder attack');
        return;
      }
      setSelectedResult(null);
      onJobStarted(data.jobId, data.total, data.baseline);
      setSubTab('results');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to start Intruder attack');
    }
  };

  const allowHostInScope = async () => {
    try {
      const cleanUrl = url.replace(/\{FUZZ\}/g, 'test');
      const parsed = new URL(cleanUrl);
      const hostname = parsed.hostname.toLowerCase();
      const sRes = await apiFetch('/api/settings');
      const sData = await sRes.json();
      const scope = sData.settings?.targetScope || {};
      const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
      const updatedScope = isLocal
        ? { ...scope, allowLocalhost: true }
        : { ...scope, allowedHosts: Array.from(new Set([...(scope.allowedHosts || []), hostname])) };
      const putRes = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetScope: updatedScope }),
      });
      if (putRes.ok) {
        setErrorMsg(null);
      }
    } catch {
      // ignore
    }
  };

  const controlJob = async (action: 'pause' | 'resume' | 'stop') => {
    if (!activeJobId) return;
    await apiFetch(`/api/intruder/${encodeURIComponent(activeJobId)}/${action}`, { method: 'POST' });
    if (action === 'pause') onJobStatusChange('paused');
    if (action === 'resume') onJobStatusChange('running');
    if (action === 'stop') onJobStatusChange('stopped');
  };

  const isActive = jobStatus === 'running' || jobStatus === 'paused';
  const isScopeErr = Boolean(errorMsg && (errorMsg.toLowerCase().includes('scope') || errorMsg.toLowerCase().includes('loopback')));

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0B0D12]">
      {/* Burp-style Intruder Header + Sub-tabs */}
      <div className="h-11 border-b border-gray-800 bg-[#141720] px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1 h-full">
          {(
            [
              ['target', '1. Target & Positions'],
              ['payloads', `2. Payloads (${payloadsList.length})`],
              ['options', '3. Resource Pool & Limits'],
              ['results', `4. Results (${results.length})`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSubTab(id)}
              className={`h-full px-3.5 text-xs font-semibold border-b-2 transition-colors ${
                subTab === id ? 'border-[#00E5FF] text-white' : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {!isActive ? (
            <button
              onClick={startFuzz}
              className="px-4 py-1.5 rounded-lg bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 border border-orange-500/40 text-xs font-bold flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5" /> Start Attack
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              {jobStatus === 'running' ? (
                <button
                  onClick={() => controlJob('pause')}
                  className="px-3 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs flex items-center gap-1"
                >
                  <Pause className="w-3.5 h-3.5" /> Pause
                </button>
              ) : (
                <button
                  onClick={() => controlJob('resume')}
                  className="px-3 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs flex items-center gap-1"
                >
                  <Play className="w-3.5 h-3.5" /> Resume
                </button>
              )}
              <button
                onClick={() => controlJob('stop')}
                className="px-3 py-1 rounded bg-red-500/20 text-red-300 border border-red-500/30 text-xs flex items-center gap-1"
              >
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            </div>
          )}
        </div>
      </div>

      {errorMsg && (
        <div className="px-4 py-2.5 bg-red-950/40 border-b border-red-500/30 text-xs text-red-200 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          {isScopeErr && (
            <button
              onClick={allowHostInScope}
              className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1.5"
            >
              <ShieldCheck className="w-3.5 h-3.5" /> Authorize Host in Scope
            </button>
          )}
        </div>
      )}

      {/* Sub-Tab 1: Target & Positions */}
      {subTab === 'target' && (
        <div className="flex-1 overflow-auto p-5 space-y-4 text-xs">
          <div className="p-3 rounded-lg bg-indigo-950/20 border border-indigo-500/20 text-indigo-200 flex items-center justify-between">
            <span>
              Place the marker <code className="text-[#00E5FF] font-bold">{'{FUZZ}'}</code> anywhere in the URL, Headers, or Body where payloads should be injected.
            </span>
            <button
              onClick={() => onChangeUrl(url + '{FUZZ}')}
              className="px-2.5 py-1 rounded bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40 font-mono font-bold"
            >
              + Append {'{FUZZ}'} to URL
            </button>
          </div>

          <div className="flex gap-2">
            <select
              value={method}
              onChange={(e) => onChangeMethod(e.target.value)}
              className="bg-[#141720] border border-gray-700 rounded-lg px-3 py-2 font-mono font-bold text-indigo-300"
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <input
              value={url}
              onChange={(e) => onChangeUrl(e.target.value)}
              placeholder="http://127.0.0.1:4000/api/item/{FUZZ}"
              className="flex-1 bg-[#141720] border border-gray-700 rounded-lg px-3 py-2 font-mono text-gray-200 focus:outline-none focus:border-[#00E5FF]"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="font-semibold text-gray-300">Headers (Raw Key: Value)</div>
              <textarea
                value={headers}
                onChange={(e) => onChangeHeaders(e.target.value)}
                placeholder="Authorization: Bearer {FUZZ}"
                className="w-full h-56 bg-[#141720] border border-gray-800 rounded-xl p-3 font-mono text-emerald-300 resize-none"
              />
            </div>
            <div className="space-y-1.5">
              <div className="font-semibold text-gray-300">Request Body Template</div>
              <textarea
                value={body}
                onChange={(e) => onChangeBody(e.target.value)}
                placeholder='{"username": "{FUZZ}"}'
                className="w-full h-56 bg-[#141720] border border-gray-800 rounded-xl p-3 font-mono text-gray-200 resize-none"
              />
            </div>
          </div>
        </div>
      )}

      {/* Sub-Tab 2: Payloads */}
      {subTab === 'payloads' && (
        <div className="flex-1 overflow-auto p-5 space-y-4 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-gray-400 font-semibold">Quick Payload Presets:</span>
            {PAYLOAD_PRESETS.map((preset) => (
              <button
                key={preset.name}
                onClick={() => setPayloadText(preset.items)}
                className="px-3 py-1 rounded-lg bg-[#141720] hover:bg-indigo-600/25 border border-gray-800 text-gray-200"
              >
                {preset.name}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="text-gray-400">
              Payload List (1 payload per line — {payloadsList.length} configured, max {maxPayloads} executed per run)
            </div>
            <textarea
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              className="w-full h-80 bg-[#141720] border border-gray-800 rounded-xl p-3 font-mono text-amber-300 focus:outline-none focus:border-[#00E5FF]"
            />
          </div>
        </div>
      )}

      {/* Sub-Tab 3: Options & Limits */}
      {subTab === 'options' && (
        <div className="flex-1 overflow-auto p-5 space-y-4 text-xs">
          <div className="p-4 rounded-xl bg-[#141720] border border-gray-800 space-y-4 max-w-2xl">
            <h3 className="font-bold text-sm text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-[#00E5FF]" /> Controlled Concurrency & Rate Limits
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1 text-gray-300">
                <span>Concurrent Workers (1–20)</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value) || 1)}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-gray-300">
                <span>Max Payloads per Job (1–500)</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={maxPayloads}
                  onChange={(e) => setMaxPayloads(Number(e.target.value) || 50)}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-gray-300">
                <span>Delay Between Requests (ms)</span>
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={delayMs}
                  onChange={(e) => setDelayMs(Number(e.target.value) || 0)}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-gray-300">
                <span>Random Jitter (ms)</span>
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={jitterMs}
                  onChange={(e) => setJitterMs(Number(e.target.value) || 0)}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-gray-300">
                <span>Max Job Duration (seconds)</span>
                <input
                  type="number"
                  min={5}
                  max={600}
                  value={maxDurationSec}
                  onChange={(e) => setMaxDurationSec(Number(e.target.value) || 60)}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-gray-300">
                <span>Per-Request Timeout (ms)</span>
                <input
                  type="number"
                  min={1000}
                  max={30000}
                  step={1000}
                  value={requestTimeoutMs}
                  onChange={(e) => setRequestTimeoutMs(Number(e.target.value) || 10000)}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 font-mono"
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-gray-300 cursor-pointer pt-2">
              <input type="checkbox" checked={rotateUA} onChange={(e) => setRotateUA(e.target.checked)} />
              Rotate User-Agent across requests
            </label>
          </div>
        </div>
      )}

      {/* Sub-Tab 4: Results */}
      {subTab === 'results' && (
        <div className="flex-1 flex flex-col min-h-0 p-4 gap-3 text-xs font-mono">
          <div className="flex items-center justify-between bg-[#141720] border border-gray-800 px-3 py-2 rounded-lg shrink-0">
            <div className="flex items-center gap-3">
              {jobStatus === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#00E5FF]" />}
              <span>
                Status: <strong className="uppercase text-[#00E5FF]">{jobStatus}</strong> ({progress.current}/{progress.total})
              </span>
              {baseline && (
                <span className="text-gray-400">
                  Baseline: <strong className="text-white">{baseline.statusCode}</strong> · {baseline.length} B · {baseline.duration}ms
                </span>
              )}
            </div>
            <label className="flex items-center gap-1.5 text-orange-300 cursor-pointer">
              <input type="checkbox" checked={onlyAnomalies} onChange={(e) => setOnlyAnomalies(e.target.checked)} />
              Show Anomalies Only ({results.filter((r) => r.isAnomaly).length})
            </label>
          </div>

          <div className="flex-1 flex min-h-0 gap-3">
            <div className="flex-1 overflow-auto bg-[#141720] rounded-xl border border-gray-800">
              <table className="w-full text-left text-[11px] text-gray-300 whitespace-nowrap">
                <thead className="bg-[#181C27] sticky top-0 border-b border-gray-800 text-gray-400">
                  <tr>
                    <th className="px-3 py-2 cursor-pointer" onClick={() => { setSortBy('index'); setSortDesc((v) => !v); }}>
                      # <ArrowUpDown className="w-2.5 h-2.5 inline" />
                    </th>
                    <th className="px-3 py-2">Payload</th>
                    <th className="px-3 py-2 cursor-pointer" onClick={() => { setSortBy('status'); setSortDesc((v) => !v); }}>
                      Status <ArrowUpDown className="w-2.5 h-2.5 inline" />
                    </th>
                    <th className="px-3 py-2 text-right cursor-pointer" onClick={() => { setSortBy('length'); setSortDesc((v) => !v); }}>
                      Length <ArrowUpDown className="w-2.5 h-2.5 inline" />
                    </th>
                    <th className="px-3 py-2 text-right cursor-pointer" onClick={() => { setSortBy('time'); setSortDesc((v) => !v); }}>
                      Time <ArrowUpDown className="w-2.5 h-2.5 inline" />
                    </th>
                    <th className="px-3 py-2">Anomaly Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedResults.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-gray-500 italic">
                        Click "Start Attack" to run payloads against your authorized target.
                      </td>
                    </tr>
                  )}
                  {sortedResults.map((r) => (
                    <tr
                      key={r.reqId}
                      onClick={() => setSelectedResult(r)}
                      className={`border-b border-gray-800/40 hover:bg-[#1E2331] cursor-pointer ${
                        r.isAnomaly ? 'bg-orange-950/20' : ''
                      } ${selectedResult?.reqId === r.reqId ? 'bg-indigo-500/20' : ''}`}
                    >
                      <td className="px-3 py-1.5 text-gray-500">{r.index}</td>
                      <td className={`px-3 py-1.5 max-w-[180px] truncate ${r.isAnomaly ? 'text-orange-300 font-bold' : ''}`}>
                        {r.payload}
                      </td>
                      <td className="px-3 py-1.5">
                        {r.error ? (
                          <span className="text-red-400">ERR</span>
                        ) : (
                          <span className={r.statusCode < 400 ? 'text-emerald-400' : 'text-yellow-400'}>{r.statusCode}</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right">{r.length}</td>
                      <td className="px-3 py-1.5 text-right">{r.duration}ms</td>
                      <td className="px-3 py-1.5 text-orange-300 truncate max-w-[220px]">
                        {r.anomalyReasons.join('; ') || (r.error ? r.error : '-')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selectedResult && (
              <div className="w-2/5 flex flex-col bg-[#141720] rounded-xl border border-gray-800 overflow-hidden">
                <div className="h-9 bg-[#181C27] border-b border-gray-800 flex items-center justify-between px-3">
                  <span className="text-[11px] font-bold text-gray-300">
                    #{selectedResult.index} Payload: {selectedResult.payload}
                  </span>
                  <button onClick={() => setSelectedResult(null)} className="text-gray-400 hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-auto p-3 space-y-2">
                  {selectedResult.error && <div className="text-red-400">{selectedResult.error}</div>}
                  <PrettyViewer
                    body={selectedResult.body}
                    bodySize={selectedResult.length}
                    bodyTruncated={selectedResult.bodyTruncated}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
