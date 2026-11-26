import React, { useEffect, useState } from 'react';
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels';
import ReactMarkdown from 'react-markdown';
import {
  ArrowRightLeft,
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
  onSendToDecoder?: (text: string) => void;
  onSendToComparer?: (slot: 'left' | 'right', label: string, text: string) => void;
}

function formatPacketAsRaw(pkt: CapturedPacket): string {
  return [
    `${pkt.method} ${pkt.url}`,
    ...Object.entries(pkt.headers || {}).map(([k, v]) => `${k}: ${v}`),
    '',
    pkt.body || '',
    '',
    `--- RESPONSE (${pkt.response?.statusCode ?? 'Pending'}) ---`,
    ...Object.entries(pkt.response?.headers || {}).map(([k, v]) => `${k}: ${v}`),
    '',
    pkt.response?.body || '',
  ].join('\n');
}

export function InspectorPane({
  selectedId,
  onSendToRepeater,
  onSendToIntruder,
  onSendToDecoder,
  onSendToComparer,
}: InspectorPaneProps) {
  const { detailCache, cacheDetail, updateCachedAnalysis, updatePacketMetaLocal } = useTrafficStore();
  const [loading, setLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [collections, setCollections] = useState<RequestCollection[]>([]);
  const [reqTab, setReqTab] = useState<'pretty' | 'raw' | 'headers'>('pretty');
  const [resTab, setResTab] = useState<'pretty' | 'raw' | 'headers'>('pretty');

  const selectedPacket = selectedId ? detailCache[selectedId] : undefined;

  useEffect(() => {
    if (!selectedId || detailCache[selectedId]) return;
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
      <div className="flex-1 flex flex-col items-center justify-center text-gray-600 p-6">
        <Shield className="w-12 h-12 mb-3 opacity-20" />
        <p className="text-sm font-medium text-gray-400">Select a row above to inspect Request & Response</p>
        <p className="text-xs opacity-70 mt-1">
          Send any captured request to Repeater, Intruder, Decoder, or Comparer with one click.
        </p>
      </div>
    );
  }

  if (loading && !selectedPacket) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 gap-2 text-xs">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading full HTTP message...
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

  const rawRequestText = [
    `${selectedPacket.method} ${safeUrl.pathname}${safeUrl.search} HTTP/1.1`,
    `Host: ${safeUrl.host}`,
    ...Object.entries(selectedPacket.headers || {}).map(([k, v]) => `${k}: ${v}`),
    '',
    selectedPacket.body || '',
  ].join('\n');

  const rawResponseText = selectedPacket.response
    ? [
        `HTTP/1.1 ${selectedPacket.response.statusCode}`,
        ...Object.entries(selectedPacket.response.headers || {}).map(([k, v]) => `${k}: ${v}`),
        '',
        selectedPacket.response.body || '',
      ].join('\n')
    : '';

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Action Toolbar */}
      <div className="border-b border-gray-800 bg-[#161923] px-3 py-2 flex items-center justify-between gap-2 flex-wrap shrink-0">
        <div className="flex items-center gap-3 text-xs font-mono text-gray-400">
          <span className="font-bold text-indigo-300">{selectedPacket.method}</span>
          <span className="text-gray-200 truncate max-w-[260px]" title={selectedPacket.url}>
            {selectedPacket.host}{selectedPacket.path}
          </span>
          <span className="flex items-center gap-1 text-[#00E5FF]">
            <Clock className="w-3 h-3" />
            {selectedPacket.response?.duration ?? selectedPacket.timing?.totalMs ?? '-'}ms
          </span>
          {selectedPacket.timing?.ttfbMs !== undefined && (
            <span className="text-gray-500">TTFB {selectedPacket.timing.ttfbMs}ms</span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => updateMeta(selectedPacket.tags || [], !selectedPacket.bookmarked, selectedPacket.collectionId)}
            className={`px-2 py-1 rounded text-[11px] border flex items-center gap-1 ${
              selectedPacket.bookmarked
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
            }`}
            title="Bookmark request"
          >
            <Bookmark className="w-3 h-3" />
          </button>

          <button
            onClick={() => onSendToRepeater(selectedPacket)}
            className="px-2.5 py-1 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 rounded text-[11px] font-semibold flex items-center gap-1 border border-emerald-500/30"
          >
            <Repeat className="w-3 h-3" /> Send to Repeater
          </button>

          <button
            onClick={() => onSendToIntruder(selectedPacket)}
            className="px-2.5 py-1 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 rounded text-[11px] font-semibold flex items-center gap-1 border border-indigo-500/30"
          >
            <Target className="w-3 h-3" /> Send to Intruder
          </button>

          {onSendToDecoder && (
            <button
              onClick={() => onSendToDecoder(selectedPacket.body || selectedPacket.url)}
              className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded text-[11px] flex items-center gap-1 border border-gray-700"
            >
              <ArrowRightLeft className="w-3 h-3" /> Decoder
            </button>
          )}

          {onSendToComparer && (
            <>
              <button
                onClick={() =>
                  onSendToComparer('left', `${selectedPacket.method} ${selectedPacket.path}`, formatPacketAsRaw(selectedPacket))
                }
                className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded text-[11px] flex items-center gap-1 border border-gray-700"
                title="Load into Comparer Slot A"
              >
                <GitCompare className="w-3 h-3" /> Compare A
              </button>
              <button
                onClick={() =>
                  onSendToComparer('right', `${selectedPacket.method} ${selectedPacket.path}`, formatPacketAsRaw(selectedPacket))
                }
                className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded text-[11px] flex items-center gap-1 border border-gray-700"
                title="Load into Comparer Slot B"
              >
                B
              </button>
            </>
          )}

          <button
            onClick={() => analyzeRequest(selectedPacket)}
            disabled={isAnalyzing}
            className="text-[11px] bg-purple-500/20 text-purple-300 border border-purple-500/30 px-2.5 py-1 rounded flex items-center gap-1 hover:bg-purple-500/30 disabled:opacity-50 font-semibold"
          >
            {isAnalyzing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            AI Audit
          </button>

          {selectedPacket.analysis && (
            <button
              onClick={() => exportReport(selectedPacket)}
              className="text-[11px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-1 rounded flex items-center gap-1 hover:bg-emerald-500/30"
            >
              <FileDown className="w-3 h-3" /> Report
            </button>
          )}
        </div>
      </div>

      {/* Tags & Collection Bar */}
      <div className="px-3 py-1.5 bg-[#12151D] border-b border-gray-800/80 flex items-center gap-2 flex-wrap text-[11px] shrink-0">
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
          placeholder="+ Add tag & press Enter"
          className="bg-transparent text-gray-300 placeholder:text-gray-600 outline-none w-36 font-mono"
        />

        <div className="ml-auto flex items-center gap-1.5">
          <FolderPlus className="w-3 h-3 text-gray-500" />
          <select
            onFocus={loadCollections}
            value={selectedPacket.collectionId || ''}
            onChange={(e) => {
              if (e.target.value) saveToCollection(e.target.value);
            }}
            className="bg-[#0B0D12] border border-gray-800 rounded px-2 py-0.5 text-gray-300"
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
        <div className="px-3 py-2 bg-red-950/40 border-b border-red-500/30 text-xs text-red-300 flex items-center justify-between shrink-0">
          <span>AI Analysis Error: {aiError}</span>
          <button onClick={() => setAiError(null)}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Advisories */}
      {(selectedPacket.response?.passiveAnalysis || selectedPacket.analysis) && (
        <div className="border-b border-gray-800 max-h-48 overflow-auto divide-y divide-gray-800 shrink-0">
          {selectedPacket.response?.passiveAnalysis && (
            <div className="p-3 bg-orange-950/20">
              <div className="text-[10px] text-orange-400 font-bold uppercase mb-1 flex items-center gap-1">
                <Shield className="w-3 h-3" /> Passive Scan Findings
              </div>
              <div className="text-xs text-orange-200 font-mono whitespace-pre-wrap">
                {selectedPacket.response.passiveAnalysis}
              </div>
            </div>
          )}
          {selectedPacket.analysis && (
            <div className="p-3 bg-purple-950/20">
              <div className="text-[10px] text-purple-400 font-bold uppercase mb-1 flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> AI Security Assessment
              </div>
              <div className="text-xs text-purple-200 prose prose-invert prose-sm max-w-none">
                <ReactMarkdown>{selectedPacket.analysis}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Request | Response Split */}
      <div className="flex-1 flex min-h-0">
        <PanelGroup orientation="horizontal" className="flex-1">
          <Panel defaultSize={50} minSize={20} className="flex flex-col border-r border-gray-800 min-h-0">
            <div className="h-8 bg-[#141720] border-b border-gray-800 px-3 flex items-center justify-between text-[11px] shrink-0">
              <span className="font-bold text-blue-300 uppercase">Request ({selectedPacket.bodySize} B)</span>
              <div className="flex gap-1">
                {(['pretty', 'headers', 'raw'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setReqTab(t)}
                    className={`px-2 py-0.5 rounded capitalize ${
                      reqTab === t ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-auto p-3 font-mono text-[11px]">
              {reqTab === 'raw' ? (
                <pre className="whitespace-pre-wrap break-all text-gray-300">{rawRequestText}</pre>
              ) : reqTab === 'headers' ? (
                <div className="space-y-1">
                  {Object.entries(selectedPacket.headers || {}).map(([k, v]) => (
                    <div key={k} className="text-gray-300 break-all border-b border-gray-800/40 pb-1">
                      <span className="text-indigo-300 font-semibold">{k}:</span> {v}
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div className="text-blue-400 font-bold mb-2">
                    {selectedPacket.method} {safeUrl.pathname}{safeUrl.search} HTTP/1.1
                  </div>
                  <div className="mb-2 space-y-0.5">
                    {Object.entries(selectedPacket.headers || {}).map(([k, v]) => (
                      <div key={k} className="text-gray-300 break-all">
                        <span className="text-gray-400">{k}:</span> <span className="text-gray-500">{v}</span>
                      </div>
                    ))}
                  </div>
                  <PrettyViewer
                    body={selectedPacket.body}
                    bodySize={selectedPacket.bodySize}
                    bodyTruncated={selectedPacket.bodyTruncated}
                    isBinary={selectedPacket.isBinary}
                  />
                </>
              )}
            </div>
          </Panel>

          <PanelResizeHandle className="w-1 bg-gray-800 hover:bg-[#00E5FF] cursor-col-resize transition-colors" />

          <Panel defaultSize={50} minSize={20} className="flex flex-col bg-[#0D1017] min-h-0">
            <div className="h-8 bg-[#141720] border-b border-gray-800 px-3 flex items-center justify-between text-[11px] shrink-0">
              <span className="font-bold text-emerald-300 uppercase">
                Response ({selectedPacket.response?.bodySize ?? 0} B)
              </span>
              <div className="flex gap-1">
                {(['pretty', 'headers', 'raw'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setResTab(t)}
                    className={`px-2 py-0.5 rounded capitalize ${
                      resTab === t ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-auto p-3 font-mono text-[11px]">
              {!selectedPacket.response ? (
                <div className="h-full flex items-center justify-center text-gray-600 italic">
                  Waiting for response...
                </div>
              ) : resTab === 'raw' ? (
                <pre className="whitespace-pre-wrap break-all text-gray-300">{rawResponseText}</pre>
              ) : resTab === 'headers' ? (
                <div className="space-y-1">
                  {Object.entries(selectedPacket.response.headers || {}).map(([k, v]) => (
                    <div key={k} className="text-gray-300 break-all border-b border-gray-800/40 pb-1">
                      <span className="text-emerald-300 font-semibold">{k}:</span> {v}
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div
                    className={`font-bold mb-2 ${
                      selectedPacket.response.statusCode < 400 ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    HTTP/1.1 {selectedPacket.response.statusCode}
                  </div>
                  <div className="mb-2 space-y-0.5">
                    {Object.entries(selectedPacket.response.headers || {}).map(([k, v]) => (
                      <div key={k} className="text-gray-300 break-all">
                        <span className="text-gray-400">{k}:</span> <span className="text-gray-500">{v}</span>
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
              )}
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
