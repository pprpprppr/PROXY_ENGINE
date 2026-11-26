import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  Loader2,
  Pause,
  Play,
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
    const payloads = payloadText
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    if (payloads.length === 0) {
      setErrorMsg('Enter at least one payload.');
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
          payloads,
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
        setErrorMsg(data.error || 'Failed to start Intruder job');
        return;
      }
      setSelectedResult(null);
      onJobStarted(data.jobId, data.total, data.baseline);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to start Intruder job');
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

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col space-y-3 font-mono text-xs">
      <div className="flex items-center justify-between">
        <div className="font-bold text-gray-300 uppercase flex items-center gap-2">
          <Target className="w-4 h-4 text-purple-400" /> Controlled Intruder (Scope-Enforced)
        </div>
        <div className="text-[11px] text-gray-500">
          Use <span className="text-[#00E5FF] font-bold">{'{FUZZ}'}</span> marker in URL, Headers, or Body.
        </div>
      </div>

      {errorMsg && (
        <div className="p-2.5 rounded bg-red-950/40 border border-red-500/30 text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="flex gap-2">
        <select
          value={method}
          onChange={(e) => onChangeMethod(e.target.value)}
          className="bg-[#0E1015] border border-gray-700 rounded px-2 py-1.5 text-gray-300"
        >
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input
          className="flex-1 bg-[#0E1015] border border-gray-700 rounded px-3 py-1.5 text-gray-300 focus:outline-none focus:border-[#00E5FF]"
          value={url}
          onChange={(e) => onChangeUrl(e.target.value)}
          placeholder="http://127.0.0.1:4000/api/item/{FUZZ}"
        />
        <button
          onClick={() => onChangeUrl(url + '{FUZZ}')}
          className="bg-[#00E5FF]/10 text-[#00E5FF] hover:bg-[#00E5FF]/20 px-2.5 py-1.5 rounded border border-[#00E5FF]/30"
        >
          + {'{FUZZ}'}
        </button>

        {!isActive ? (
          <button
            onClick={startFuzz}
            className="bg-indigo-600/25 text-indigo-300 hover:bg-indigo-600/40 px-4 py-1.5 rounded flex items-center gap-1.5 border border-indigo-500/40 font-bold"
          >
            <Play className="w-3.5 h-3.5" /> Start
          </button>
        ) : (
          <div className="flex gap-1.5">
            {jobStatus === 'running' ? (
              <button
                onClick={() => controlJob('pause')}
                className="bg-amber-500/20 text-amber-300 px-3 py-1.5 rounded border border-amber-500/30 flex items-center gap-1"
              >
                <Pause className="w-3.5 h-3.5" /> Pause
              </button>
            ) : (
              <button
                onClick={() => controlJob('resume')}
                className="bg-emerald-500/20 text-emerald-300 px-3 py-1.5 rounded border border-emerald-500/30 flex items-center gap-1"
              >
                <Play className="w-3.5 h-3.5" /> Resume
              </button>
            )}
            <button
              onClick={() => controlJob('stop')}
              className="bg-red-500/20 text-red-300 px-3 py-1.5 rounded border border-red-500/30 flex items-center gap-1"
            >
              <Square className="w-3.5 h-3.5" /> Stop
            </button>
          </div>
        )}
      </div>

      {/* Execution Limits */}
      <div className="flex flex-wrap items-center gap-3 bg-[#16181D] border border-gray-800 p-2.5 rounded text-[11px]">
        <span className="text-gray-400 font-bold flex items-center gap-1">
          <Activity className="w-3.5 h-3.5 text-orange-400" /> Bounds:
        </span>
        <label className="flex items-center gap-1.5 text-gray-400">
          Concurrency
          <input
            type="number"
            min={1}
            max={20}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value) || 1)}
            className="w-12 bg-[#0E1015] border border-gray-700 rounded px-1.5 py-0.5 text-gray-200"
          />
        </label>
        <label className="flex items-center gap-1.5 text-gray-400">
          Delay(ms)
          <input
            type="number"
            min={0}
            step={50}
            value={delayMs}
            onChange={(e) => setDelayMs(Number(e.target.value) || 0)}
            className="w-16 bg-[#0E1015] border border-gray-700 rounded px-1.5 py-0.5 text-gray-200"
          />
        </label>
        <label className="flex items-center gap-1.5 text-gray-400">
          Jitter(ms)
          <input
            type="number"
            min={0}
            step={50}
            value={jitterMs}
            onChange={(e) => setJitterMs(Number(e.target.value) || 0)}
            className="w-16 bg-[#0E1015] border border-gray-700 rounded px-1.5 py-0.5 text-gray-200"
          />
        </label>
        <label className="flex items-center gap-1.5 text-gray-400">
          Max Payloads
          <input
            type="number"
            min={1}
            max={500}
            value={maxPayloads}
            onChange={(e) => setMaxPayloads(Number(e.target.value) || 50)}
            className="w-14 bg-[#0E1015] border border-gray-700 rounded px-1.5 py-0.5 text-gray-200"
          />
        </label>
        <label className="flex items-center gap-1.5 text-gray-400">
          Max Sec
          <input
            type="number"
            min={5}
            max={600}
            value={maxDurationSec}
            onChange={(e) => setMaxDurationSec(Number(e.target.value) || 60)}
            className="w-14 bg-[#0E1015] border border-gray-700 rounded px-1.5 py-0.5 text-gray-200"
          />
        </label>
        <label className="flex items-center gap-1.5 text-gray-400">
          Timeout(ms)
          <input
            type="number"
            min={1000}
            max={30000}
            step={1000}
            value={requestTimeoutMs}
            onChange={(e) => setRequestTimeoutMs(Number(e.target.value) || 10000)}
            className="w-16 bg-[#0E1015] border border-gray-700 rounded px-1.5 py-0.5 text-gray-200"
          />
        </label>
        <label className="flex items-center gap-1.5 text-gray-400 cursor-pointer">
          <input type="checkbox" checked={rotateUA} onChange={(e) => setRotateUA(e.target.checked)} />
          Rotate UA
        </label>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-500 uppercase font-bold">Headers</span>
          <textarea
            className="h-24 bg-[#0E1015] border border-gray-700 rounded p-2 text-[11px] text-emerald-400 resize-none"
            value={headers}
            onChange={(e) => onChangeHeaders(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-500 uppercase font-bold">Body Template</span>
          <textarea
            className="h-24 bg-[#0E1015] border border-gray-700 rounded p-2 text-[11px] text-gray-300 resize-none"
            value={body}
            onChange={(e) => onChangeBody(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-500 uppercase font-bold">Payloads (1 per line)</span>
          <textarea
            className="h-24 bg-[#0E1015] border border-gray-700 rounded p-2 text-[11px] text-yellow-300 resize-none"
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
          />
        </div>
      </div>

      {/* Progress & Baseline */}
      {(isActive || results.length > 0) && (
        <div className="flex items-center justify-between bg-[#14161C] border border-gray-800 px-3 py-2 rounded text-[11px]">
          <div className="flex items-center gap-3">
            {jobStatus === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#00E5FF]" />}
            <span>
              Status: <strong className="uppercase text-[#00E5FF]">{jobStatus}</strong> ({progress.current}/{progress.total})
            </span>
            {baseline && (
              <span className="text-gray-400">
                Baseline: <strong className="text-gray-200">{baseline.statusCode}</strong> · {baseline.length}B · {baseline.duration}ms
              </span>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-orange-300 cursor-pointer">
            <input type="checkbox" checked={onlyAnomalies} onChange={(e) => setOnlyAnomalies(e.target.checked)} />
            Anomalies Only ({results.filter((r) => r.isAnomaly).length})
          </label>
        </div>
      )}

      {/* Results Table */}
      <div className="flex-1 flex min-h-[260px] gap-3">
        <div className="flex-1 overflow-auto bg-[#0A0C10] rounded border border-gray-800">
          <table className="w-full text-left text-[11px] text-gray-400 font-mono whitespace-nowrap">
            <thead className="bg-[#14161C] sticky top-0 border-b border-gray-800">
              <tr>
                <th
                  className="px-3 py-2 cursor-pointer hover:text-white"
                  onClick={() => {
                    setSortBy('index');
                    setSortDesc((v) => !v);
                  }}
                >
                  # <ArrowUpDown className="w-2.5 h-2.5 inline" />
                </th>
                <th className="px-3 py-2">Payload</th>
                <th
                  className="px-3 py-2 cursor-pointer hover:text-white"
                  onClick={() => {
                    setSortBy('status');
                    setSortDesc((v) => !v);
                  }}
                >
                  Status <ArrowUpDown className="w-2.5 h-2.5 inline" />
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-white"
                  onClick={() => {
                    setSortBy('length');
                    setSortDesc((v) => !v);
                  }}
                >
                  Length <ArrowUpDown className="w-2.5 h-2.5 inline" />
                </th>
                <th
                  className="px-3 py-2 text-right cursor-pointer hover:text-white"
                  onClick={() => {
                    setSortBy('time');
                    setSortDesc((v) => !v);
                  }}
                >
                  Time <ArrowUpDown className="w-2.5 h-2.5 inline" />
                </th>
                <th className="px-3 py-2">Anomaly</th>
              </tr>
            </thead>
            <tbody>
              {sortedResults.map((r) => (
                <tr
                  key={r.reqId}
                  onClick={() => setSelectedResult(r)}
                  className={`border-b border-gray-800/50 hover:bg-[#16181D] cursor-pointer ${
                    r.isAnomaly ? 'bg-orange-950/20' : ''
                  } ${selectedResult?.reqId === r.reqId ? 'bg-indigo-500/15' : ''}`}
                >
                  <td className="px-3 py-1.5 text-gray-500">{r.index}</td>
                  <td className={`px-3 py-1.5 max-w-[160px] truncate ${r.isAnomaly ? 'text-orange-300 font-bold' : 'text-gray-200'}`}>
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
                  <td className="px-3 py-1.5 text-orange-400 text-[10px] truncate max-w-[180px]">
                    {r.anomalyReasons.join('; ') || (r.error ? r.error : '-')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedResult && (
          <div className="w-2/5 flex flex-col bg-[#0A0C10] rounded border border-gray-800 overflow-hidden">
            <div className="h-8 bg-[#14161C] border-b border-gray-800 flex items-center justify-between px-3">
              <span className="text-[10px] text-gray-400 uppercase font-bold">
                Payload #{selectedResult.index}: {selectedResult.payload}
              </span>
              <button onClick={() => setSelectedResult(null)} className="text-gray-500 hover:text-gray-300">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3 space-y-2">
              {selectedResult.error && (
                <div className="text-red-400 text-xs">{selectedResult.error}</div>
              )}
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
  );
}
