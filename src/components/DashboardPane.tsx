import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileDown,
  Globe,
  Pause,
  Play,
  Send,
  Shield,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type { PacketSummary, ServerBootstrapConfig } from '../types/proxy';
import { apiFetch } from '../lib/api';

interface DashboardPaneProps {
  serverConfig: ServerBootstrapConfig;
  isConnected: boolean;
  interceptMode: boolean;
  summaries: PacketSummary[];
  totalCount: number;
  pendingCount: number;
  onNavigate: (tab: 'dashboard' | 'target' | 'proxy' | 'repeater' | 'intruder' | 'decoder' | 'comparer' | 'settings', subTab?: string) => void;
  onToggleIntercept: (enabled: boolean) => void;
  onSelectPacket: (id: string) => void;
}

export function DashboardPane({
  serverConfig,
  isConnected,
  interceptMode,
  summaries,
  totalCount,
  pendingCount,
  onNavigate,
  onToggleIntercept,
  onSelectPacket,
}: DashboardPaneProps) {
  const [simMethod, setSimMethod] = useState('GET');
  const [simUrl, setSimUrl] = useState('http://127.0.0.1:3000/api/health');
  const [simBody, setSimBody] = useState('');
  const [simSending, setSimSending] = useState(false);
  const [simResult, setSimResult] = useState<{ ok: boolean; text: string } | null>(null);

  const findingsPackets = summaries.filter((s) => s.hasPassiveFindings || s.hasAiAnalysis);
  const errorPackets = summaries.filter((s) => (s.statusCode || 0) >= 400 || s.status === 'error');
  const uniqueHosts = new Set(summaries.map((s) => s.host)).size;

  const runQuickRequest = async () => {
    setSimSending(true);
    setSimResult(null);
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
        setSimResult({ ok: false, text: data.error || 'Request failed' });
      } else {
        setSimResult({
          ok: true,
          text: `Captured HTTP ${data.status} (${data.bodyLength ?? 0} bytes) through MITM proxy`,
        });
      }
    } catch (err) {
      setSimResult({ ok: false, text: err instanceof Error ? err.message : 'Request failed' });
    }
    setSimSending(false);
  };

  return (
    <div className="flex-1 overflow-auto bg-[#0B0D12] p-6 space-y-6">
      {/* Hero Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-[#141720] border border-gray-800 space-y-2">
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>MITM Proxy Listener</span>
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                serverConfig.proxyStatus === 'UP'
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                  : 'bg-red-500/15 text-red-300 border border-red-500/30'
              }`}
            >
              {serverConfig.proxyStatus}
            </span>
          </div>
          <div className="text-lg font-mono font-bold text-white">
            {serverConfig.proxyHost}:{serverConfig.proxyPort}
          </div>
          <div className="text-[11px] text-gray-500">Point your browser or HTTP client here</div>
        </div>

        <div className="p-4 rounded-xl bg-[#141720] border border-gray-800 space-y-2">
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>Live Interception</span>
            <button
              onClick={() => onToggleIntercept(!interceptMode)}
              className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1 border ${
                interceptMode
                  ? 'bg-orange-500/20 text-orange-300 border-orange-500/40'
                  : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-white'
              }`}
            >
              {interceptMode ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              {interceptMode ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="text-lg font-bold text-white">{pendingCount} Paused</div>
          <button
            onClick={() => onNavigate('proxy', 'intercept')}
            className="text-[11px] text-[#00E5FF] hover:underline flex items-center gap-1"
          >
            Open Intercept Queue <ArrowRight className="w-3 h-3" />
          </button>
        </div>

        <div className="p-4 rounded-xl bg-[#141720] border border-gray-800 space-y-2">
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>Captured Traffic</span>
            <Activity className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-lg font-bold text-white">{totalCount.toLocaleString()} Requests</div>
          <div className="text-[11px] text-gray-500">
            {uniqueHosts} unique host(s) · {errorPackets.length} 4xx/5xx responses
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#141720] border border-gray-800 space-y-2">
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>Security Findings</span>
            <ShieldAlert className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-lg font-bold text-amber-300">{findingsPackets.length} Flagged</div>
          <div className="text-[11px] text-gray-500">
            Passive checks + {serverConfig.geminiConfigured ? `Gemini (${serverConfig.geminiModel})` : 'AI ready when key set'}
          </div>
        </div>
      </div>

      {/* Main Two-Column Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Quick Start & Setup Guide */}
        <div className="p-5 rounded-xl bg-[#141720] border border-gray-800 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Shield className="w-4 h-4 text-[#00E5FF]" /> Quick Start Guide
            </h2>
            <a
              href="/api/ca-cert"
              className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5"
            >
              <FileDown className="w-3.5 h-3.5" /> Download Root CA (.pem)
            </a>
          </div>

          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-[#0D1017] border border-gray-800/80 flex items-start gap-3">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-gray-200">1. Configure Browser or Client Proxy</div>
                <div className="text-gray-400 mt-0.5">
                  Set HTTP & HTTPS proxy to <code className="text-[#00E5FF]">{serverConfig.proxyHost}:{serverConfig.proxyPort}</code>. For HTTPS interception, import the Root CA certificate into your browser or OS trust store.
                </div>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-[#0D1017] border border-gray-800/80 flex items-start gap-3">
              <Globe className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-gray-200">2. Define Authorized Target Scope</div>
                <div className="text-gray-400 mt-0.5">
                  Visit the <strong>Target</strong> tab to add authorized domains (or enable Localhost for local testing) before running Repeater or Intruder.
                </div>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-[#0D1017] border border-gray-800/80 flex items-start gap-3">
              <Sparkles className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-gray-200">3. Inspect, Modify & Test</div>
                <div className="text-gray-400 mt-0.5">
                  Use <strong>Proxy → Intercept</strong> to pause/edit live traffic, <strong>Proxy → HTTP History</strong> to browse stored sessions, and <strong>Repeater / Intruder</strong> to test endpoints.
                </div>
              </div>
            </div>
          </div>

          {/* Quick Request Tester */}
          <div className="pt-3 border-t border-gray-800 space-y-2">
            <div className="text-xs font-semibold text-gray-300">Send a Test Request Through the Proxy</div>
            <div className="flex gap-2">
              <select
                value={simMethod}
                onChange={(e) => setSimMethod(e.target.value)}
                className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-gray-200"
              >
                <option>GET</option>
                <option>POST</option>
              </select>
              <input
                value={simUrl}
                onChange={(e) => setSimUrl(e.target.value)}
                placeholder="http://127.0.0.1:3000/api/health"
                className="flex-1 bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-gray-200 focus:outline-none focus:border-[#00E5FF]"
              />
              <button
                onClick={runQuickRequest}
                disabled={simSending || !isConnected}
                className="px-3.5 py-1.5 rounded-lg bg-[#00E5FF]/20 hover:bg-[#00E5FF]/30 text-[#00E5FF] border border-[#00E5FF]/40 text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                {simSending ? 'Sending...' : 'Test'}
              </button>
            </div>
            {simMethod === 'POST' && (
              <input
                value={simBody}
                onChange={(e) => setSimBody(e.target.value)}
                placeholder='Optional JSON body e.g. {"hello":"world"}'
                className="w-full bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-gray-200"
              />
            )}
            {simResult && (
              <div
                className={`text-xs px-3 py-2 rounded-lg border ${
                  simResult.ok
                    ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300'
                    : 'bg-red-950/30 border-red-500/30 text-red-300'
                }`}
              >
                {simResult.text}
                {!simResult.ok && simResult.text.toLowerCase().includes('scope') && (
                  <button
                    onClick={() => onNavigate('target')}
                    className="ml-2 underline font-semibold text-white"
                  >
                    Configure Target Scope →
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Recent Findings & Issues Feed */}
        <div className="p-5 rounded-xl bg-[#141720] border border-gray-800 flex flex-col space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-400" /> Recent Security Advisories
            </h2>
            <button
              onClick={() => onNavigate('proxy', 'history')}
              className="text-xs text-indigo-400 hover:text-indigo-300"
            >
              View All Traffic →
            </button>
          </div>

          <div className="flex-1 overflow-auto max-h-[340px] space-y-2">
            {findingsPackets.length === 0 ? (
              <div className="text-center py-12 text-xs text-gray-500 border border-dashed border-gray-800 rounded-lg">
                No passive or AI findings detected in the current view yet.
                <br />
                Browse traffic through the proxy or trigger an AI Security Audit on any request.
              </div>
            ) : (
              findingsPackets.slice(0, 20).map((pkt) => (
                <div
                  key={pkt.id}
                  onClick={() => {
                    onSelectPacket(pkt.id);
                    onNavigate('proxy', 'history');
                  }}
                  className="p-3 rounded-lg bg-[#0D1017] border border-gray-800 hover:border-orange-500/40 cursor-pointer transition-colors flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-bold text-indigo-300">{pkt.method}</span>
                      <span className="text-gray-200 font-mono truncate">{pkt.host}{pkt.path}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px]">
                      {pkt.hasPassiveFindings && (
                        <span className="px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300 border border-orange-500/30">
                          Passive Scan Hit
                        </span>
                      )}
                      {pkt.hasAiAnalysis && (
                        <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30">
                          AI Audit Complete
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="text-xs font-mono font-bold text-gray-400 shrink-0">
                    {pkt.statusCode ?? '-'}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
