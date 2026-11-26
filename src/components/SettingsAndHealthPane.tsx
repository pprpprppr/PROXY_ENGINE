import React, { useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  Cpu,
  Database,
  FileDown,
  HardDrive,
  Lock,
  RefreshCw,
  Save,
  Shield,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import type { RuntimeProxySettings, SystemHealthSnapshot } from '../types/proxy';
import { apiFetch, getAuthenticatedDownloadUrl } from '../lib/api';

interface SettingsAndHealthPaneProps {
  serverConfig: {
    port: number;
    host: string;
    proxyPort: number;
    proxyHost: string;
    proxyStatus: 'UP' | 'DOWN';
    geminiConfigured?: boolean;
    geminiModel?: string;
  };
  onSessionImported: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function SettingsAndHealthPane({ serverConfig, onSessionImported }: SettingsAndHealthPaneProps) {
  const [section, setSection] = useState<'proxy' | 'scope' | 'limits' | 'session' | 'health' | 'stats'>('proxy');
  const [settings, setSettings] = useState<RuntimeProxySettings | null>(null);
  const [allowedHostsText, setAllowedHostsText] = useState('');
  const [excludedHostsText, setExcludedHostsText] = useState('');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [redactExport, setRedactExport] = useState(true);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [health, setHealth] = useState<SystemHealthSnapshot | null>(null);
  const [stats, setStats] = useState<any>(null);

  const loadSettings = () => {
    apiFetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        if (d.settings) {
          setSettings(d.settings);
          setAllowedHostsText((d.settings.targetScope?.allowedHosts || []).join('\n'));
          setExcludedHostsText((d.settings.targetScope?.excludedHosts || []).join('\n'));
        }
      })
      .catch(() => {});
  };

  const loadHealth = () => {
    apiFetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => {});
  };

  const loadStats = () => {
    apiFetch('/api/history/stats').then((r) => r.json()).then(setStats).catch(() => {});
  };

  useEffect(() => {
    loadSettings();
    loadHealth();
  }, []);

  useEffect(() => {
    if (section === 'health') {
      loadHealth();
      const t = setInterval(loadHealth, 5000);
      return () => clearInterval(t);
    }
    if (section === 'stats') loadStats();
  }, [section]);

  const saveSettings = async () => {
    if (!settings) return;
    const payload: Partial<RuntimeProxySettings> = {
      ...settings,
      targetScope: {
        ...settings.targetScope,
        allowedHosts: allowedHostsText.split('\n').map((s) => s.trim()).filter(Boolean),
        excludedHosts: excludedHostsText.split('\n').map((s) => s.trim()).filter(Boolean),
      },
    };
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setSaveMessage('Settings saved successfully.');
      setTimeout(() => setSaveMessage(null), 2500);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const res = await apiFetch(`/api/session/import?mode=${importMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      });
      const data = await res.json();
      if (!res.ok) alert(data.error || 'Import failed');
      else {
        setSaveMessage(`Imported ${data.count} record(s).`);
        onSessionImported();
      }
    } catch (err) {
      alert(`Invalid JSON/HAR file: ${err instanceof Error ? err.message : String(err)}`);
    }
    e.target.value = '';
  };

  const navItems = [
    { id: 'proxy', label: 'Proxy & Certificates', icon: Lock },
    { id: 'scope', label: 'Target Scope & SSRF', icon: Shield },
    { id: 'limits', label: 'Memory & Retention', icon: Activity },
    { id: 'session', label: 'Session & HAR Files', icon: Database },
    { id: 'stats', label: 'Traffic Analytics', icon: BarChart3 },
    { id: 'health', label: 'System Health', icon: Cpu },
  ] as const;

  return (
    <div className="flex-1 flex min-h-0 bg-[#0B0D12] text-gray-300">
      {/* Left Category Navigation */}
      <aside className="w-60 border-r border-gray-800 bg-[#12151D] p-3 flex flex-col gap-1 shrink-0">
        <div className="px-2.5 py-2 text-[11px] font-bold uppercase tracking-wider text-gray-500">
          Settings & Diagnostics
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={`px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2.5 text-left transition-colors ${
                section === item.id
                  ? 'bg-[#00E5FF]/15 text-[#00E5FF] border border-[#00E5FF]/30'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800/50 border border-transparent'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {item.label}
            </button>
          );
        })}

        {saveMessage && (
          <div className="mt-auto p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs">
            {saveMessage}
          </div>
        )}
      </aside>

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-6 space-y-5 text-xs">
        {settings?.allowInsecureTls && (
          <div className="p-3 rounded-xl bg-red-950/50 border border-red-500/50 text-red-200 flex items-center gap-2.5">
            <ShieldAlert className="w-5 h-5 text-red-400 shrink-0" />
            <div>
              <strong>Insecure Upstream TLS Override is Active:</strong> Upstream certificate verification is disabled. Disable this after testing self-signed local targets.
            </div>
          </div>
        )}

        {section === 'proxy' && (
          <div className="max-w-3xl space-y-5">
            <div className="p-5 rounded-xl bg-[#141720] border border-gray-800 space-y-4">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Lock className="w-4 h-4 text-[#00E5FF]" /> Proxy Listener & TLS Certificates
              </h2>
              <div className="grid grid-cols-2 gap-3 font-mono">
                <div className="p-3 rounded-lg bg-[#0B0D12] border border-gray-800">
                  <div className="text-gray-500 text-[10px]">Proxy Bind Address</div>
                  <div className="text-sm font-bold text-[#00E5FF] mt-0.5">
                    {serverConfig.proxyHost}:{serverConfig.proxyPort}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-[#0B0D12] border border-gray-800">
                  <div className="text-gray-500 text-[10px]">Gemini AI Backend</div>
                  <div className="text-sm font-bold text-purple-300 mt-0.5">
                    {serverConfig.geminiConfigured ? serverConfig.geminiModel : 'Disabled (no API key)'}
                  </div>
                </div>
              </div>

              {settings && (
                <label className="flex items-center gap-2.5 p-3 rounded-lg bg-[#0B0D12] border border-gray-800 cursor-pointer text-amber-300">
                  <input
                    type="checkbox"
                    checked={settings.allowInsecureTls}
                    onChange={(e) => setSettings({ ...settings, allowInsecureTls: e.target.checked })}
                  />
                  <span>Allow insecure upstream TLS certificates (for self-signed staging/local targets only)</span>
                </label>
              )}

              <div className="flex items-center gap-3">
                <a
                  href="/api/ca-cert"
                  className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-semibold"
                >
                  <FileDown className="w-4 h-4" /> Download ProxySuite Root CA (.pem)
                </a>
                {settings && (
                  <button
                    onClick={saveSettings}
                    className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg font-semibold"
                  >
                    <Save className="w-4 h-4" /> Save
                  </button>
                )}
              </div>
            </div>

            <div className="p-5 rounded-xl bg-[#141720] border border-gray-800 space-y-2">
              <h3 className="font-bold text-white">Browser Setup Instructions</h3>
              <p className="text-gray-400">
                1. Set HTTP and HTTPS proxy in Firefox, Chrome (FoxyProxy), or OS settings to{' '}
                <code className="text-[#00E5FF]">{serverConfig.proxyHost}:{serverConfig.proxyPort}</code>.
              </p>
              <p className="text-gray-400">
                2. Import the downloaded <strong>ProxySuiteRootCA.pem</strong> under Certificate Authorities and trust it to identify websites.
              </p>
            </div>
          </div>
        )}

        {section === 'scope' && settings && (
          <div className="max-w-3xl p-5 rounded-xl bg-[#141720] border border-gray-800 space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-400" /> Authorized Target Scope & SSRF Protection
            </h2>
            <p className="text-gray-400">
              All active requests (Repeater, Intruder, Simulator) validate DNS resolution and redirect hops against these rules to prevent accidental external requests or internal SSRF.
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.targetScope.enforceScope}
                  onChange={(e) =>
                    setSettings({ ...settings, targetScope: { ...settings.targetScope, enforceScope: e.target.checked } })
                  }
                />
                Enforce Target Scope allowlist
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.targetScope.allowLocalhost}
                  onChange={(e) =>
                    setSettings({ ...settings, targetScope: { ...settings.targetScope, allowLocalhost: e.target.checked } })
                  }
                />
                Allow Localhost / Loopback (127.0.0.1)
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.targetScope.allowPrivateNetworks}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      targetScope: { ...settings.targetScope, allowPrivateNetworks: e.target.checked },
                    })
                  }
                />
                Allow Private RFC1918 Networks
              </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-gray-400 font-semibold mb-1">Allowed Hosts (1 per line, supports *.domain.com)</div>
                <textarea
                  value={allowedHostsText}
                  onChange={(e) => setAllowedHostsText(e.target.value)}
                  className="w-full h-28 bg-[#0B0D12] border border-gray-700 rounded-lg p-2.5 font-mono text-gray-200"
                />
              </div>
              <div>
                <div className="text-gray-400 font-semibold mb-1">Excluded Hosts (always blocked)</div>
                <textarea
                  value={excludedHostsText}
                  onChange={(e) => setExcludedHostsText(e.target.value)}
                  className="w-full h-28 bg-[#0B0D12] border border-gray-700 rounded-lg p-2.5 font-mono text-gray-200"
                />
              </div>
            </div>

            <button
              onClick={saveSettings}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2"
            >
              <Save className="w-4 h-4" /> Save Scope Settings
            </button>
          </div>
        )}

        {section === 'limits' && settings && (
          <div className="max-w-3xl p-5 rounded-xl bg-[#141720] border border-gray-800 space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-amber-400" /> Memory Capture Budgets & Retention Policy
            </h2>
            <div className="grid grid-cols-2 gap-4 font-mono">
              <label className="flex flex-col gap-1">
                <span className="text-gray-400 font-sans">Max Request Body Capture (KB)</span>
                <input
                  type="number"
                  value={Math.round(settings.maxReqBodyCaptureBytes / 1024)}
                  onChange={(e) =>
                    setSettings({ ...settings, maxReqBodyCaptureBytes: (Number(e.target.value) || 1024) * 1024 })
                  }
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-gray-400 font-sans">Max Response Body Capture (KB)</span>
                <input
                  type="number"
                  value={Math.round(settings.maxResBodyCaptureBytes / 1024)}
                  onChange={(e) =>
                    setSettings({ ...settings, maxResBodyCaptureBytes: (Number(e.target.value) || 2048) * 1024 })
                  }
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-gray-400 font-sans">Max Concurrent Active Proxy Requests</span>
                <input
                  type="number"
                  value={settings.maxActiveRequests}
                  onChange={(e) => setSettings({ ...settings, maxActiveRequests: Number(e.target.value) || 500 })}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-gray-400 font-sans">Max Pending Intercept Queue</span>
                <input
                  type="number"
                  value={settings.maxPendingIntercepts}
                  onChange={(e) => setSettings({ ...settings, maxPendingIntercepts: Number(e.target.value) || 100 })}
                  className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5"
                />
              </label>
            </div>

            <div className="pt-3 border-t border-gray-800 space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.retention.enabled}
                  onChange={(e) =>
                    setSettings({ ...settings, retention: { ...settings.retention, enabled: e.target.checked } })
                  }
                />
                Enable automatic history pruning (bookmarked requests are always preserved)
              </label>
              <div className="grid grid-cols-2 gap-4 font-mono">
                <label className="flex flex-col gap-1">
                  <span className="text-gray-400 font-sans">Max Stored Records</span>
                  <input
                    type="number"
                    value={settings.retention.maxRecords}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        retention: { ...settings.retention, maxRecords: Number(e.target.value) || 10000 },
                      })
                    }
                    className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-gray-400 font-sans">Max Age (Hours)</span>
                  <input
                    type="number"
                    value={settings.retention.maxAgeHours}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        retention: { ...settings.retention, maxAgeHours: Number(e.target.value) || 168 },
                      })
                    }
                    className="bg-[#0B0D12] border border-gray-700 rounded-lg px-3 py-1.5"
                  />
                </label>
              </div>
            </div>

            <button
              onClick={saveSettings}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2"
            >
              <Save className="w-4 h-4" /> Save Limits
            </button>
          </div>
        )}

        {section === 'session' && (
          <div className="max-w-3xl p-5 rounded-xl bg-[#141720] border border-gray-800 space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Database className="w-4 h-4 text-purple-400" /> Session Backup, JSON & HAR 1.2 Import/Export
            </h2>
            <p className="text-gray-400">
              All traffic is stored in local SQLite (WAL mode) and preserved across restarts. Export sessions as JSON or HAR 1.2 (with optional secret redaction).
            </p>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={redactExport} onChange={(e) => setRedactExport(e.target.checked)} />
                Redact Authorization, Cookies & tokens in HAR export
              </label>
              <select
                value={importMode}
                onChange={(e) => setImportMode(e.target.value as 'merge' | 'replace')}
                className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2.5 py-1 text-gray-200"
              >
                <option value="merge">Import Mode: Merge</option>
                <option value="replace">Import Mode: Replace (with auto-backup)</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-2.5">
              <a
                href={getAuthenticatedDownloadUrl('/api/session/export?format=json')}
                className="bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 px-3.5 py-2 rounded-lg border border-emerald-500/30 flex items-center gap-1.5 font-semibold"
              >
                <FileDown className="w-4 h-4" /> Export JSON Session
              </a>
              <a
                href={getAuthenticatedDownloadUrl(`/api/session/export?format=har&redact=${redactExport}`)}
                className="bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 px-3.5 py-2 rounded-lg border border-cyan-500/30 flex items-center gap-1.5 font-semibold"
              >
                <FileDown className="w-4 h-4" /> Export HAR 1.2
              </a>
              <label className="bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 px-3.5 py-2 rounded-lg border border-purple-500/30 cursor-pointer flex items-center gap-1.5 font-semibold">
                <Upload className="w-4 h-4" /> Import JSON / HAR
                <input type="file" className="hidden" accept=".json,.har" onChange={handleImportFile} />
              </label>
              <button
                onClick={async () => {
                  const res = await apiFetch('/api/session/backup', { method: 'POST' });
                  const d = await res.json();
                  if (d.backupPath) setSaveMessage(`Backup saved: ${d.backupPath}`);
                }}
                className="bg-gray-800 hover:bg-gray-700 text-gray-200 px-3.5 py-2 rounded-lg border border-gray-700 flex items-center gap-1.5 font-semibold"
              >
                <HardDrive className="w-4 h-4" /> Create DB Backup
              </button>
            </div>
          </div>
        )}

        {section === 'health' && health && (
          <div className="space-y-4 font-mono">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-sans font-bold text-white">Runtime Telemetry & System Health</h2>
              <button
                onClick={loadHealth}
                className="px-3 py-1 bg-gray-800 hover:bg-gray-700 rounded-lg border border-gray-700 flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-4 rounded-xl bg-[#141720] border border-gray-800">
                <div className="text-[10px] text-gray-500">RSS Memory</div>
                <div className="text-lg font-bold text-[#00E5FF]">{formatBytes(health.memory.rssBytes)}</div>
                <div className="text-[10px] text-gray-500">Heap: {formatBytes(health.memory.heapUsedBytes)}</div>
              </div>
              <div className="p-4 rounded-xl bg-[#141720] border border-gray-800">
                <div className="text-[10px] text-gray-500">Event Loop Lag</div>
                <div className="text-lg font-bold text-emerald-400">{health.eventLoopLagMs.p95}ms p95</div>
                <div className="text-[10px] text-gray-500">
                  Mean: {health.eventLoopLagMs.mean}ms · Max: {health.eventLoopLagMs.max}ms
                </div>
              </div>
              <div className="p-4 rounded-xl bg-[#141720] border border-gray-800">
                <div className="text-[10px] text-gray-500">Active Connections</div>
                <div className="text-lg font-bold text-amber-300">{health.connections.activeProxyRequests}</div>
                <div className="text-[10px] text-gray-500">
                  UI WS: {health.connections.wsUiClients} · MITM WS: {health.connections.activeMitmWsConnections}
                </div>
              </div>
              <div className="p-4 rounded-xl bg-[#141720] border border-gray-800">
                <div className="text-[10px] text-gray-500">SQLite Queue / Integrity</div>
                <div className="text-lg font-bold text-purple-300">{health.database.queueDepth} queued</div>
                <div className="text-[10px] text-gray-500">
                  {health.database.totalPackets} rows · {health.database.integrityOk ? 'Integrity OK' : 'Recovered'}
                </div>
              </div>
            </div>
            <div className="p-4 rounded-xl bg-[#141720] border border-gray-800 space-y-1.5">
              <div>
                Uptime: {health.uptimeSeconds}s · Proxy: {health.proxyStatus} ({health.proxyHost}:{health.proxyPort})
              </div>
              <div>
                Pending Intercepts: Req={health.connections.pendingRequestIntercepts}, Res=
                {health.connections.pendingResponseIntercepts}
              </div>
              <div>
                Captured: {health.trafficStats.totalCaptured} · Truncated Payloads: {health.trafficStats.totalTruncated} · Errors:{' '}
                {health.trafficStats.totalErrors}
              </div>
              <div>
                DB Path: <span className="text-gray-400">{health.database.path}</span> (Dropped writes:{' '}
                {health.database.droppedWrites})
              </div>
            </div>
          </div>
        )}

        {section === 'stats' && stats && (
          <div className="space-y-4 font-mono">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="p-4 rounded-xl bg-[#141720] border border-gray-800">
                <div className="text-[10px] text-gray-500">Total Requests</div>
                <div className="text-lg font-bold text-white">{stats.totals?.totalRequests || 0}</div>
              </div>
              <div className="p-4 rounded-xl bg-[#141720] border border-gray-800">
                <div className="text-[10px] text-gray-500">2xx / 4xx / 5xx</div>
                <div className="text-sm font-bold">
                  <span className="text-emerald-400">{stats.totals?.s2xx || 0}</span> /{' '}
                  <span className="text-amber-400">{stats.totals?.s4xx || 0}</span> /{' '}
                  <span className="text-red-400">{stats.totals?.s5xx || 0}</span>
                </div>
              </div>
              <div className="p-4 rounded-xl bg-[#141720] border border-gray-800">
                <div className="text-[10px] text-gray-500">Avg Duration</div>
                <div className="text-lg font-bold text-[#00E5FF]">{Math.round(stats.totals?.avgDurationMs || 0)}ms</div>
              </div>
              <div className="p-4 rounded-xl bg-[#141720] border border-gray-800">
                <div className="text-[10px] text-gray-500">Passive Findings</div>
                <div className="text-lg font-bold text-orange-400">{stats.totals?.passiveFindings || 0}</div>
              </div>
              <div className="p-4 rounded-xl bg-[#141720] border border-gray-800">
                <div className="text-[10px] text-gray-500">AI Analyzed</div>
                <div className="text-lg font-bold text-purple-400">{stats.totals?.aiFindings || 0}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-[#141720] border border-gray-800 space-y-2">
                <div className="font-bold text-gray-300 uppercase">Top Hosts</div>
                {(stats.topHosts || []).map((h: any) => (
                  <div key={h.host} className="flex items-center gap-2">
                    <span className="w-40 truncate text-gray-300">{h.host}</span>
                    <div className="flex-1 bg-gray-900 h-2 rounded overflow-hidden">
                      <div
                        className="bg-indigo-500 h-2"
                        style={{
                          width: `${Math.min(100, Math.round((h.count / Math.max(1, stats.totals?.totalRequests || 1)) * 100))}%`,
                        }}
                      />
                    </div>
                    <span className="text-gray-400 w-20 text-right">
                      {h.count} ({Math.round(h.avgMs)}ms)
                    </span>
                  </div>
                ))}
              </div>

              <div className="p-4 rounded-xl bg-[#141720] border border-gray-800 space-y-2">
                <div className="font-bold text-gray-300 uppercase">Duplicate Endpoints</div>
                {(stats.duplicates || []).length === 0 ? (
                  <div className="text-gray-500 italic">No duplicate requests detected.</div>
                ) : (
                  (stats.duplicates || []).map((d: any, i: number) => (
                    <div key={i} className="flex justify-between text-[11px] border-b border-gray-800/50 pb-1">
                      <span className="truncate max-w-[280px]">
                        <strong className="text-indigo-400 mr-1">{d.method}</strong>
                        {d.url}
                      </span>
                      <span className="text-amber-400">×{d.count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
