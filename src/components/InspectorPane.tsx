import React, { useEffect, useState } from 'react';
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels';
import ReactMarkdown from 'react-markdown';
import {
  Bookmark,
  Clock,
  FileDown,
  FolderPlus,
  GitCompare,
  Loader2,
  Repeat,
  Shield,
  Sparkles,
  Tag,
  Target,
  X,
} from 'lucide-react';
import type { CapturedPacket, PacketSummary, RequestCollection } from '../types/proxy';
import { apiFetch } from '../lib/api';
import { useTrafficStore } from '../hooks/useTraffic';
import { PrettyViewer } from './PrettyViewer';

interface InspectorPaneProps {
  selectedId: string | null;
  summaries: PacketSummary[];
  onSendToRepeater: (pkt: CapturedPacket) => void;
  onSendToIntruder: (pkt: CapturedPacket) => void;
}

function computeSimpleDiff(aText: string, bText: string): Array<{ type: 'same' | 'add' | 'del'; line: string }> {
  const aLines = aText.split('\n').slice(0, 400);
  const bLines = bText.split('\n').slice(0, 400);
  const bSet = new Set(bLines);
  const aSet = new Set(aLines);
  const out: Array<{ type: 'same' | 'add' | 'del'; line: string }> = [];
  const maxLen = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < maxLen; i++) {
    const la = aLines[i];
    const lb = bLines[i];
    if (la === lb && la !== undefined) {
      out.push({ type: 'same', line: la });
    } else {
      if (la !== undefined && !bSet.has(la)) out.push({ type: 'del', line: la });
      else if (la !== undefined) out.push({ type: 'same', line: la });
      if (lb !== undefined && !aSet.has(lb)) out.push({ type: 'add', line: lb });
    }
  }
  return out;
}

export function InspectorPane({
  selectedId,
  summaries,
  onSendToRepeater,
  onSendToIntruder,
}: InspectorPaneProps) {
  const { detailCache, cacheDetail, updateCachedAnalysis, updatePacketMetaLocal } = useTrafficStore();
  const [loading, setLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [compareTargetId, setCompareTargetId] = useState<string>('');
  const [comparePacket, setComparePacket] = useState<CapturedPacket | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [collections, setCollections] = useState<RequestCollection[]>([]);

  const selectedPacket = selectedId ? detailCache[selectedId] : undefined;

  useEffect(() => {
    if (!selectedId) return;
    if (detailCache[selectedId]) return;
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/history/${encodeURIComponent(selectedId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((pkt: CapturedPacket | null) => {
        if (!cancelled && pkt) cacheDetail(pkt);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, detailCache, cacheDetail]);

  useEffect(() => {
    if (!compareTargetId) {
      setComparePacket(null);
      return;
    }
    if (detailCache[compareTargetId]) {
      setComparePacket(detailCache[compareTargetId]);
      return;
    }
    apiFetch(`/api/history/${encodeURIComponent(compareTargetId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((pkt) => {
        if (pkt) setComparePacket(pkt);
      })
      .catch(() => {});
  }, [compareTargetId, detailCache]);

  const loadCollections = () => {
    apiFetch('/api/collections')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.collections)) setCollections(d.collections);
      })
      .catch(() => {});
  };

  const analyzeRequest = async (req: CapturedPacket) => {
    setIsAnalyzing(true);
    setAiError(null);
    try {
      const response = await apiFetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: req.id,
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: req.body,
          response: req.response,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setAiError(data.error || 'AI Analysis failed');
      } else if (data.text) {
        updateCachedAnalysis(req.id, data.text, data.structured || null);
      }
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'AI Analysis failed');
    }
    setIsAnalyzing(false);
  };

  const updateMeta = (tags: string[], bookmarked: boolean, collectionId?: string | null) => {
    if (!selectedPacket) return;
    updatePacketMetaLocal(selectedPacket.id, tags, bookmarked, collectionId);
    apiFetch(`/api/history/${encodeURIComponent(selectedPacket.id)}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags, bookmarked, collectionId }),
    }).catch(() => {});
  };

  const exportReport = (req: CapturedPacket) => {
    const docContent = [
      '# ProxySuite Security Assessment Report',
      '',
      `- **Target:** ${req.url}`,
      `- **Method:** ${req.method}`,
      `- **Timestamp:** ${new Date(req.timestamp).toISOString()}`,
      `- **Status:** ${req.response?.statusCode ?? 'N/A'}`,
      '',
      '## Findings & Analysis',
      '',
      req.analysis || 'No AI analysis available.',
      '',
      req.response?.passiveAnalysis ? `## Passive Scan\n\n${req.response.passiveAnalysis}` : '',
    ].join('\n');

    const blob = new Blob([docContent], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ProxySuite_Report_${req.id.slice(0, 8)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const saveToCollection = async (collectionId: string) => {
    if (!selectedPacket) return;
    await apiFetch(`/api/collections/${encodeURIComponent(collectionId)}/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${selectedPacket.method} ${selectedPacket.path.slice(0, 40)}`,
        method: selectedPacket.method,
        url: selectedPacket.url,
        headers: selectedPacket.headers,
        body: selectedPacket.body,
      }),
    });
    updateMeta(selectedPacket.tags || [], selectedPacket.bookmarked, collectionId);
  };

  if (!selectedId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-600">
        <Shield className="w-16 h-16 mb-4 opacity-20" />
        <p className="text-sm font-medium">Select a request to inspect</p>
        <p className="text-xs opacity-60 mt-1 max-w-xs text-center">
          Click any row in the traffic table to lazy-load full headers, bodies, timing, and analysis.
        </p>
      </div>
    );
  }

  if (loading && !selectedPacket) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 gap-2 text-xs">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading packet details...
      </div>
    );
  }

  if (!selectedPacket) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 text-xs">
        Packet details unavailable.
      </div>
    );
  }

  const safeUrl = (() => {
    try {
      return new URL(selectedPacket.url);
    } catch {
      return { host: selectedPacket.host || 'unknown', pathname: selectedPacket.url, search: '' };
    }
  })();

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="h-11 border-b border-gray-800 bg-[#14161C] flex items-center px-3 shrink-0 justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-[11px] font-mono text-gray-400">
          <span className="flex items-center gap-1 text-gray-300">
            <Clock className="w-3 h-3 text-[#00E5FF]" />
            {selectedPacket.response?.duration ?? selectedPacket.timing?.totalMs ?? '-'}ms
          </span>
          {selectedPacket.timing?.ttfbMs !== undefined && (
            <span className="text-gray-500">TTFB: {selectedPacket.timing.ttfbMs}ms</span>
          )}
          <span className="text-gray-600">|</span>
          <span>Req: {selectedPacket.bodySize}B</span>
          <span>Res: {selectedPacket.response?.bodySize ?? 0}B</span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => updateMeta(selectedPacket.tags || [], !selectedPacket.bookmarked, selectedPacket.collectionId)}
            className={`px-2 py-1 rounded text-[10px] border flex items-center gap-1 ${
              selectedPacket.bookmarked
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
            }`}
          >
            <Bookmark className="w-3 h-3" />
          </button>

          <button
            onClick={() => {
              loadCollections();
              setShowDiff((v) => !v);
            }}
            className={`px-2 py-1 rounded text-[10px] border flex items-center gap-1 ${
              showDiff
                ? 'bg-[#00E5FF]/20 border-[#00E5FF]/40 text-[#00E5FF]'
                : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
            }`}
          >
            <GitCompare className="w-3 h-3" /> Diff
          </button>

          <button
            onClick={() => onSendToIntruder(selectedPacket)}
            className="px-2 py-1 bg-indigo-900/40 hover:bg-indigo-900/60 text-indigo-300 rounded text-[10px] font-medium flex items-center gap-1 border border-indigo-500/30"
          >
            <Target className="w-3 h-3" /> Intruder
          </button>

          <button
            onClick={() => onSendToRepeater(selectedPacket)}
            className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-[10px] font-medium flex items-center gap-1 border border-gray-700"
          >
            <Repeat className="w-3 h-3" /> Repeater
          </button>

          <button
            onClick={() => analyzeRequest(selectedPacket)}
            disabled={isAnalyzing}
            className="text-[10px] bg-purple-500/20 text-purple-300 border border-purple-500/30 px-2 py-1 rounded flex items-center gap-1 hover:bg-purple-500/30 disabled:opacity-50"
          >
            {isAnalyzing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            AI Analyze
          </button>

          {selectedPacket.analysis && (
            <button
              onClick={() => exportReport(selectedPacket)}
              className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-1 rounded flex items-center gap-1 hover:bg-emerald-500/30"
            >
              <FileDown className="w-3 h-3" /> Report
            </button>
          )}
        </div>
      </div>

      {/* Tagging & Collections Strip */}
      <div className="px-3 py-1.5 bg-[#12141A] border-b border-gray-800/80 flex items-center gap-2 flex-wrap text-[10px]">
        <Tag className="w-3 h-3 text-gray-500" />
        {(selectedPacket.tags || []).map((t) => (
          <span
            key={t}
            className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 flex items-center gap-1"
          >
            {t}
            <button
              onClick={() =>
                updateMeta(
                  selectedPacket.tags.filter((x) => x !== t),
                  selectedPacket.bookmarked,
                  selectedPacket.collectionId
                )
              }
              className="hover:text-red-400"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}
        <input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && tagInput.trim()) {
              const nextTag = tagInput.trim();
              if (!selectedPacket.tags.includes(nextTag)) {
                updateMeta([...selectedPacket.tags, nextTag], selectedPacket.bookmarked, selectedPacket.collectionId);
              }
              setTagInput('');
            }
          }}
          placeholder="+ Add tag (Enter)"
          className="bg-transparent text-gray-300 placeholder:text-gray-600 outline-none w-28 font-mono"
        />

        <div className="ml-auto flex items-center gap-1.5">
          <FolderPlus className="w-3 h-3 text-gray-500" />
          <select
            onFocus={loadCollections}
            value={selectedPacket.collectionId || ''}
            onChange={(e) => {
              if (e.target.value) saveToCollection(e.target.value);
            }}
            className="bg-[#0A0C10] border border-gray-800 rounded px-1.5 py-0.5 text-gray-400"
          >
            <option value="">Save to Collection...</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {aiError && (
        <div className="px-3 py-2 bg-red-900/20 border-b border-red-500/30 text-xs text-red-300 flex items-center justify-between">
          <span>AI Analysis Error: {aiError}</span>
          <button onClick={() => setAiError(null)}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {showDiff && (
        <div className="p-3 bg-[#101319] border-b border-gray-800 space-y-2 max-h-64 overflow-auto">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-bold text-[#00E5FF] uppercase text-[10px]">Response Body Diff</span>
            <select
              value={compareTargetId}
              onChange={(e) => setCompareTargetId(e.target.value)}
              className="flex-1 bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-300"
            >
              <option value="">Select another request to compare...</option>
              {summaries
                .filter((s) => s.id !== selectedPacket.id)
                .slice(0, 50)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    [{s.method}] {s.statusCode ?? '?'} {s.host}
                    {s.path.slice(0, 40)}
                  </option>
                ))}
            </select>
          </div>
          {comparePacket && (
            <pre className="text-[10px] font-mono bg-[#0A0C10] p-2 rounded border border-gray-800 overflow-auto max-h-40">
              {computeSimpleDiff(selectedPacket.response?.body || '', comparePacket.response?.body || '').map((d, idx) => (
                <div
                  key={idx}
                  className={
                    d.type === 'add'
                      ? 'text-emerald-400 bg-emerald-950/20'
                      : d.type === 'del'
                        ? 'text-red-400 bg-red-950/20'
                        : 'text-gray-500'
                  }
                >
                  {d.type === 'add' ? '+ ' : d.type === 'del' ? '- ' : '  '}
                  {d.line}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {selectedPacket.response?.passiveAnalysis && (
          <div className="p-3 bg-orange-900/20 border-b border-orange-500/20 shrink-0 max-h-36 overflow-auto">
            <div className="text-[10px] text-orange-400 font-bold uppercase mb-1 flex items-center gap-1">
              <Shield className="w-3 h-3" /> Passive Security Scan
            </div>
            <div className="text-xs text-orange-200 leading-relaxed font-mono whitespace-pre-wrap">
              {selectedPacket.response.passiveAnalysis}
            </div>
          </div>
        )}

        {selectedPacket.analysis && (
          <div className="p-3 bg-purple-900/20 border-b border-purple-500/20 shrink-0 max-h-56 overflow-auto">
            <div className="text-[10px] text-purple-400 font-bold uppercase mb-1 flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> AI Defensive Security Assessment
            </div>
            <div className="text-xs text-purple-200 leading-relaxed font-sans prose prose-invert prose-sm max-w-none">
              <ReactMarkdown>{selectedPacket.analysis}</ReactMarkdown>
            </div>
          </div>
        )}

        <div className="flex-1 flex min-h-0">
          <PanelGroup orientation="horizontal" className="flex-1">
            <Panel defaultSize={50} minSize={20} className="flex flex-col border-r border-gray-800">
              <div className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed relative">
                <div className="text-[10px] text-gray-500 uppercase border border-gray-800 px-1.5 py-0.5 rounded float-right">
                  Request
                </div>
                <div className="text-blue-400 font-bold mb-2">
                  {selectedPacket.method} {safeUrl.pathname}
                  {safeUrl.search} HTTP/1.1
                </div>
                <div className="mb-3 space-y-0.5">
                  <div className="text-gray-300">
                    Host: <span className="text-gray-500">{safeUrl.host}</span>
                  </div>
                  {Object.entries(selectedPacket.headers || {}).map(([k, v]) => (
                    <div key={k} className="text-gray-300 break-all">
                      {k}: <span className="text-gray-500">{v}</span>
                    </div>
                  ))}
                </div>
                <PrettyViewer
                  body={selectedPacket.body}
                  bodySize={selectedPacket.bodySize}
                  bodyTruncated={selectedPacket.bodyTruncated}
                  isBinary={selectedPacket.isBinary}
                />
              </div>
            </Panel>

            <PanelResizeHandle className="w-1 bg-gray-800 hover:bg-[#00E5FF] cursor-col-resize transition-colors" />

            <Panel defaultSize={50} minSize={20} className="flex flex-col bg-[#0E1015]">
              <div className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed relative">
                <div className="text-[10px] text-gray-500 uppercase border border-gray-800 px-1.5 py-0.5 rounded float-right">
                  Response
                </div>
                {selectedPacket.response ? (
                  <>
                    <div
                      className={`font-bold mb-2 ${
                        selectedPacket.response.statusCode < 400 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      HTTP/1.1 {selectedPacket.response.statusCode}
                    </div>
                    <div className="mb-3 space-y-0.5">
                      {Object.entries(selectedPacket.response.headers || {}).map(([k, v]) => (
                        <div key={k} className="text-gray-300 break-all">
                          {k}: <span className="text-gray-500">{v}</span>
                        </div>
                      ))}
                    </div>
                    <PrettyViewer
                      body={selectedPacket.response.body}
                      bodySize={selectedPacket.response.bodySize}
                      bodyTruncated={selectedPacket.response.bodyTruncated}
                      isBinary={selectedPacket.response.isBinary}
                    />
                  </>
                ) : (
                  <div className="h-full flex items-center justify-center text-gray-600 italic">
                    Waiting for response...
                  </div>
                )}
              </div>
            </Panel>
          </PanelGroup>
        </div>
      </div>
    </div>
  );
}
