import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import { Shield, Activity, Wifi, Send, Database, AlertCircle, Settings, Play, Square, Pause, Sparkles, Loader2, Info, X, Repeat, Rocket, Target, ArrowUpDown, FileDown, Trash2, ArrowUpRight, Filter, Globe, Plus } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { twMerge } from 'tailwind-merge';
import ReactMarkdown from 'react-markdown';
import { useTrafficStore, CapturedRequest } from './hooks/useTraffic';

/** UI Helper: Tailwind class merger */
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Performance Architect: Standardized URL Reconstruction */
const safeUrl = (u: string) => {
    try {
        return new URL(u);
    } catch {
        return { pathname: u, host: 'invalid-host', search: '' } as any;
    }
};

/** High-Frequency Shared Utility: Headers serialization */
const serializeHeaders = (headers: Record<string, string>) => {
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
};

/** MEMOIZED ROW COMPONENT: Prevents 500+ items re-rendering on every clock cycle */
interface TrafficRowProps {
    req: CapturedRequest;
    isSelected: boolean;
    onSelect: (id: string) => void;
    onIgnoreDomain: (domain: string) => void;
}
const TrafficRow = memo(({ req, isSelected, onSelect, onIgnoreDomain }: TrafficRowProps) => {
    const urlObj = safeUrl(req.url);
    const isIntercepted = req.status === 'intercepted' || req.status === 'response_intercepted';

    return (
        <tr 
            onClick={() => onSelect(req.id)}
            className={cn(
                "border-b border-gray-800/40 hover:bg-[#1C1F26] cursor-pointer transition-colors group select-none relative",
                isSelected ? "bg-[#00E5FF]/5" : "",
                isIntercepted ? "bg-orange-950/20" : ""
            )}
        >
            <td className="px-4 py-2 opacity-40 text-[10px] w-8">
                {req.id.slice(0, 4)}
            </td>
            <td className="px-4 py-2">
                <span className={cn(
                    "text-[10px] uppercase font-bold px-1.5 py-0.5 rounded leading-none shrink-0",
                    req.method === 'POST' ? 'bg-indigo-900/40 text-indigo-400' : 'bg-green-900/40 text-green-400'
                )}>{req.method}</span>
            </td>
            <td className="px-4 py-2 text-gray-300 font-mono flex items-center gap-2 group/host">
                <span className="truncate max-w-[160px]">{urlObj.host}</span>
                <button 
                    onClick={(e) => {
                        e.stopPropagation();
                        onIgnoreDomain(urlObj.host);
                    }}
                    className="opacity-0 group-hover/host:opacity-100 p-0.5 hover:bg-gray-700 rounded text-gray-500 hover:text-red-400 transition-all title='Ignore this domain'"
                >
                    <Filter className="w-3 h-3" />
                </button>
            </td>
            <td className="px-4 py-2 font-mono text-gray-400 max-w-[400px] truncate">
                {urlObj.pathname}{urlObj.search}
            </td>
            <td className="px-4 py-2">
                {isIntercepted ? (
                    <span className="text-orange-400 font-bold flex items-center gap-1">
                        <Pause className="w-2.5 h-2.5" /> Intercepted
                    </span>
                ) : !req.response ? (
                    <span className="text-gray-600 flex items-center gap-1 italic">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" /> Pending...
                    </span>
                ) : (
                    <span className={cn(
                        "font-bold",
                        req.response.statusCode < 300 ? "text-green-400" :
                        req.response.statusCode < 400 ? "text-yellow-400" : "text-red-400"
                    )}>{req.response.statusCode}</span>
                )}
            </td>
            <td className="px-4 py-2 text-right opacity-60 font-mono text-xs">
                {req.response ? (req.response.body.length > 1024 ? (req.response.body.length/1024).toFixed(1) + 'k' : req.response.body.length) : '-'}
            </td>
        </tr>
    );
});
TrafficRow.displayName = 'TrafficRow';

const syntaxHighlight = (json: any) => {
    let str = typeof json !== 'string' ? JSON.stringify(json, null, 2) : json;
    str = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match: string) {
        let cls = 'text-green-300'; // string
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'text-indigo-400 font-bold'; // key
            }
        } else if (/true|false/.test(match)) {
            cls = 'text-orange-400'; // boolean
        } else if (/null/.test(match)) {
            cls = 'text-gray-500'; // null
        } else {
            cls = 'text-yellow-400'; // number
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
};

const PrettyViewer = ({ body, isResponse = false }: { body: string; isResponse?: boolean }) => {
    if (!body) return null;
    let contentHtml = '';
    let isJson = false;

    try {
        const parsed = JSON.parse(body);
        contentHtml = syntaxHighlight(parsed);
        isJson = true;
    } catch {
         isJson = false;
         if (body.length > 300 && !body.includes('{') && !body.includes('<')) {
             const bytes = Array.from(body).map(c => c.charCodeAt(0) & 0xff);
             let hexStr = '';
             for (let i = 0; i < bytes.length && i < 256; i+=16) {
                 const chunk = bytes.slice(i, i+16);
                 const hex = chunk.map(b => b.toString(16).padStart(2, '0')).join(' ');
                 const ascii = chunk.map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
                 hexStr += `${i.toString(16).padStart(4, '0')}  <span class="text-gray-400">${hex.padEnd(48, ' ')}</span>  |<span class="text-gray-300">${ascii}</span>|\n`;
             }
             if (bytes.length > 256) hexStr += `... snip (${bytes.length - 256} more bytes)`;
             contentHtml = hexStr;
         } else {
             contentHtml = body.replace(/</g, '&lt;').replace(/>/g, '&gt;');
         }
    }

    return (
        <div className={cn("whitespace-pre-wrap mt-4 border-t border-gray-800/50 pt-4 break-all font-mono leading-relaxed", !isJson ? "text-gray-300" : "")} dangerouslySetInnerHTML={{ __html: contentHtml }} />
    );
}

const parseRawHeaders = (raw: string) => {
  const obj: Record<string, string> = {};
  if (!raw) return obj;
  raw.split('\n').forEach(line => {
    const index = line.indexOf(':');
    if (index > -1) {
      const k = line.slice(0, index).trim();
      const v = line.slice(index + 1).trim();
      if (k) obj[k] = v;
    }
  });
  return obj;
};

export default function App() {
  const { requests, addRequest, updateResponse, updateAnalysis, setRequests } = useTrafficStore();
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isCapturing, setIsCapturing] = useState(true);
  const [showArchInfo, setShowArchInfo] = useState(false);
  const [viewMode, setViewMode] = useState<'inspector' | 'repeater' | 'interceptor' | 'intruder' | 'websockets' | 'scripts' | 'settings'>('inspector');

  // Template Library
  const [templates, setTemplates] = useState([
    { name: 'XSS Probe', value: "<script>alert('XSS')</script>" },
    { name: 'SQLi Boolean', value: "' OR 1=1--" },
    { name: 'Auth Bypass', value: '{"admin": true}' },
    { name: 'Large Payload', value: 'A'.repeat(5000) }
  ]);

  // Script State
  const [userScript, setUserScript] = useState('// Write a Javascript middleware here\nfunction process(req) {\n  return req;\n}');
  
  // Websocket State
  const [wsFormat, setWsFormat] = useState<'text'|'binary'>('text');

  // Repeater State
  const [repeaterMethod, setRepeaterMethod] = useState('GET');
  const [repeaterUrl, setRepeaterUrl] = useState('');
  const [repeaterHeaders, setRepeaterHeaders] = useState('');
  const [repeaterBody, setRepeaterBody] = useState('');
  const [repeaterResponse, setRepeaterResponse] = useState<any>(null);
  const [isRepeating, setIsRepeating] = useState(false);

  // Intruder State
  const [fuzzPayloads, setFuzzPayloads] = useState("admin\ntest\n12345\n' OR 1=1--");
  const [selectedFuzzResult, setSelectedFuzzResult] = useState<any>(null);
  const [fuzzResults, setFuzzResults] = useState<any[]>([]);
  const [isFuzzing, setIsFuzzing] = useState(false);
  const [fuzzProgress, setFuzzProgress] = useState({ current: 0, total: 0 });
  const [sortBy, setSortBy] = useState<'status' | 'length' | 'time'>('length');
  const [sortDesc, setSortDesc] = useState(true);
  const [fuzzJitter, setFuzzJitter] = useState(0);
  const [fuzzRotateUA, setFuzzRotateUA] = useState(false);

  // Simulation State
  const [simUrl, setSimUrl] = useState('https://jsonplaceholder.typicode.com/todos/1');
  const [simMethod, setSimMethod] = useState('GET');
  const [simBody, setSimBody] = useState('');
  const [isSimulating, setIsSimulating] = useState(false);
  const [interceptMode, setInterceptMode] = useState(false);
  const [responseInterceptMode, setResponseInterceptMode] = useState(false);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [ignoredDomains, setIgnoredDomains] = useState<string[]>([]);
  const [newIgnoreDomain, setNewIgnoreDomain] = useState('');
  const wsRef = useRef<WebSocket | null>(null);

  const loadHistory = useCallback(() => {
    fetch('/api/history?limit=100')
      .then(r => r.json())
      .then(data => {
          if (Array.isArray(data)) setRequests(data);
      })
      .catch(e => console.error("History Error", e));
  }, [setRequests]);

  useEffect(() => {
    // Setup WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;
    
    let ws: WebSocket;
    const connect = () => {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => setIsConnected(true);
      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        setTimeout(connect, 3000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'requestCaptured' && isCapturing) {
          addRequest(msg.payload);
        } else if (msg.type === 'responseCaptured') {
          updateResponse(msg.payload);
        } else if (msg.type === 'PENDING_REVIEW') {
          addRequest(msg.payload);
        } else if (msg.type === 'RESPONSE_PENDING') {
          // If the request is already in state, update it. Otherwise, add it.
          updateResponse({ ...msg.payload, isResponseIntercept: true, status: 'response_intercepted' });
        } else if (msg.type === 'interceptStatus') {
          setInterceptMode(msg.payload.enabled);
          if (msg.payload.responseEnabled !== undefined) {
             setResponseInterceptMode(msg.payload.responseEnabled);
          }
        } else if (msg.type === 'fuzzProgress') {
           setFuzzResults(prev => [...prev, ...msg.payload.results]);
           setFuzzProgress({ current: msg.payload.current, total: msg.payload.total });
        } else if (msg.type === 'fuzzComplete') {
           setIsFuzzing(false);
        } else if (msg.type === 'REFRESH_DATA' || msg.type === 'SESSION_RELOADED') {
           loadHistory();
        }
      };
    };
    
    connect();
    return () => { ws?.close(); };
  }, [isCapturing, addRequest, updateResponse, loadHistory]);

  // Smart Navigation Filters
  const [searchFilter, setSearchFilter] = useState('');
  const [methodFilter, setMethodFilter] = useState('ALL');

  const safeUrl = (urlStr: string) => {
    try {
      return new URL(urlStr);
    } catch (e) {
      return { host: 'unknown', pathname: urlStr, search: '' } as any;
    }
  };
  const [savedFilters, setSavedFilters] = useState<{name: string, method: string, search: string}[]>([
      { name: "POST Admins", method: "POST", search: "admin" },
      { name: "Potential Errors", method: "ALL", search: "error" }
  ]);

  const filteredRequests = requests.filter(r => {
      if (methodFilter !== 'ALL' && r.method !== methodFilter) return false;
      if (searchFilter) {
          const term = searchFilter.toLowerCase();
          return r.url.toLowerCase().includes(term) || (r.body && String(r.body).toLowerCase().includes(term));
      }
      return true;
  });

  const activeIntercepts = requests.filter(r => r.status === 'intercepted' || r.status === 'response_intercepted');
  const activeIntercept = activeIntercepts[0];

  const [interceptUrl, setInterceptUrl] = useState('');
  const [interceptMethod, setInterceptMethod] = useState('');
  const [interceptHeaders, setInterceptHeaders] = useState('');
  const [interceptBody, setInterceptBody] = useState('');
  const [interceptResponseFlag, setInterceptResponseFlag] = useState(false);

  // Match & Replace State
  const [replacementRules, setReplacementRules] = useState<any[]>([]);
  const [serverConfig, setServerConfig] = useState<{port: number, proxyPort: number, proxyStatus?: 'UP' | 'DOWN'}>({ port: 3000, proxyPort: 8082 });

  const fetchConfig = useCallback(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
          if (data.port) setServerConfig(data);
      })
      .catch(e => console.error("Config Fetch Error", e));
  }, []);

  // Load History on Mount
  useEffect(() => {
     loadHistory();
     fetchConfig();
  }, [loadHistory, fetchConfig]);

  const fetchRules = useCallback(() => {
    fetch('/api/rules').then(r => r.json()).then(setReplacementRules).catch(console.error);
  }, []);
  const saveRules = useCallback((rules: any[]) => {
      fetch('/api/rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rules)
      }).then(() => fetchRules()).catch(console.error);
  }, [fetchRules]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  useEffect(() => {
     if (activeIntercept) {
         if (activeIntercept.status === 'response_intercepted' && activeIntercept.response) {
            setInterceptUrl('RESPONSE: ' + activeIntercept.url);
            setInterceptMethod(activeIntercept.response.statusCode.toString());
            setInterceptHeaders(serializeHeaders(activeIntercept.response.headers));
            setInterceptBody(activeIntercept.response.body || '');
         } else {
            setInterceptUrl(activeIntercept.url);
            setInterceptMethod(activeIntercept.method);
            setInterceptHeaders(serializeHeaders(activeIntercept.headers));
            setInterceptBody(activeIntercept.body || '');
         }
         // Auto switch view mode to interceptor if not already
         if (viewMode !== 'interceptor') setViewMode('interceptor');
     }
  }, [activeIntercept?.id, activeIntercept?.status]);

  // MEMOIZED HANDLERS: Prevent component re-construction cascade
  const toggleCapture = useCallback((state: boolean) => setIsCapturing(state), []);
  const toggleIntercept = useCallback((enabled: boolean) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ 
              type: 'TOGGLE_INTERCEPT', 
              payload: { enabled } 
          }));
      }
  }, []);

  const toggleResponseIntercept = useCallback((enabled: boolean) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ 
              type: 'TOGGLE_RESPONSE_INTERCEPT', 
              payload: { enabled } 
          }));
      }
  }, []);

  const executeInterceptAction = useCallback((id: string, action: 'forward' | 'drop') => {
      let payload: any = { id, action };
      
      if (action === 'forward' && activeIntercept && activeIntercept.id === id && viewMode === 'interceptor') {
          payload.modifiedUrl = interceptUrl;
          payload.modifiedHeaders = parseRawHeaders(interceptHeaders);
          payload.modifiedBody = interceptBody;
          payload.interceptResponse = interceptResponseFlag;
      }
      
      if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ 
              type: action === 'forward' ? 'ACTION_FORWARD' : 'ACTION_DROP', 
              payload 
          }));
          
          // Optimistically clear the intercepted status
          setRequests(requests.map(r => r.id === id ? { ...r, status: action === 'drop' ? 'dropped' as const : (r.status === 'response_intercepted' ? 'completed' : 'pending') } : r));
          if (activeIntercept?.id === id) setInterceptResponseFlag(false);
      }
  }, [activeIntercept, viewMode, interceptUrl, interceptHeaders, interceptBody, interceptResponseFlag, requests, setRequests]);

  useEffect(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ 
              type: 'UPDATE_IGNORED_DOMAINS', 
              payload: ignoredDomains 
          }));
      }
      // Save to localStorage for persistence across reloads
      localStorage.setItem('proxy_ignored_domains', JSON.stringify(ignoredDomains));
  }, [ignoredDomains]);

  useEffect(() => {
      const saved = localStorage.getItem('proxy_ignored_domains');
      if (saved) {
          try {
              setIgnoredDomains(JSON.parse(saved));
          } catch (e) {
              console.error("Failed to load ignored domains", e);
          }
      }
  }, []);

  const simulateRequest = useCallback(async (count: number = 1) => {
    setIsSimulating(true);
    let parsedBody;
    try { 
        if (simBody) parsedBody = JSON.parse(simBody); 
    } catch { 
        parsedBody = simBody; 
    }
    
    const sendSingle = () => fetch('/api/simulate-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: simUrl, method: simMethod, body: parsedBody })
    });

    try {
      if (count === 1) {
          await sendSingle();
      } else {
          for (let i = 0; i < count; i++) {
             sendSingle().catch(e => console.error("Burst error", e));
             if (i % 50 === 0) await new Promise(r => setTimeout(r, 50));
          }
      }
    } catch (e) {
      console.error("Simulation error", e);
    }
    setIsSimulating(false);
  }, [simUrl, simMethod, simBody]);

  const onSelectRequest = useCallback((id: string) => {
    setSelectedReqId(id);
    setViewMode('inspector');
  }, []);
  
  const analyzeIntercept = async () => {
    if (!activeIntercept) return;
    setIsAnalyzing(true);
    try {
        const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                method: interceptMethod,
                url: interceptUrl,
                headers: parseRawHeaders(interceptHeaders),
                body: interceptBody
            })
        });

        const data = await response.json();
        
        if (data.text) {
            setInterceptBody(prev => prev + "\n\n/* AI THREAT ANALYSIS: \n" + data.text + "\n*/");
        } else if (data.error) {
            alert("AI Analysis error: " + data.error);
        }
    } catch (e: any) {
        alert("AI Analysis failed: " + e.message);
    }
    setIsAnalyzing(false);
  };

  const handleSendToRepeater = useCallback((req: CapturedRequest) => {
     setRepeaterMethod(req.method);
     setRepeaterUrl(req.url);
     setRepeaterHeaders(serializeHeaders(req.headers));
     setRepeaterBody(req.body || '');
     setViewMode('repeater');
  }, []);

  const handleSendToIntruder = useCallback((req: CapturedRequest) => {
     setRepeaterMethod(req.method);
     setRepeaterUrl(req.url);
     setRepeaterHeaders(serializeHeaders(req.headers));
     setRepeaterBody(req.body || '');
     setViewMode('intruder');
  }, []);

  const executeRepeater = async () => {
      if (!repeaterUrl || !repeaterMethod) {
          alert('URL and Method are required');
          return;
      }
      setIsRepeating(true);
      setRepeaterResponse(null);
      try {
          const parsedHeaders = parseRawHeaders(repeaterHeaders);

          const res = await fetch('/api/repeater', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({
                 method: repeaterMethod,
                 url: repeaterUrl,
                 headers: parsedHeaders,
                 body: repeaterBody
             })
          });
          const result = await res.json();
          if (result.error) {
              alert(result.error);
          } else {
              setRepeaterResponse(result);
          }
      } catch (e) {
          console.error(e);
      }
      setIsRepeating(false);
  };

  const executeFuzzer = async () => {
      setIsFuzzing(true);
      setFuzzResults([]);
      setFuzzProgress({ current: 0, total: 0 });
      try {
          const parsedHeaders = parseRawHeaders(repeaterHeaders);

          const payloads = fuzzPayloads.split('\n').filter(p => p.trim());
          if (payloads.length === 0) {
             alert("Enter payloads");
             setIsFuzzing(false);
             return;
          }

          await fetch('/api/intruder/run', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({
                 method: repeaterMethod,
                 url: repeaterUrl,
                 headers: parsedHeaders,
                 body: repeaterBody,
                 payloads,
                 jitterMs: fuzzJitter,
                 rotateUserAgent: fuzzRotateUA
             })
          });
      } catch (e) {
          console.error(e);
          setIsFuzzing(false);
      }
  };

  const analyzeRequest = async (req: CapturedRequest) => {
     setIsAnalyzing(true);
     try {
         const response = await fetch('/api/analyze', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({
                 method: req.method,
                 url: req.url,
                 headers: req.headers,
                 body: req.body,
                 response: req.response
             })
         });

         const data = await response.json();
         
         if (data.text) {
             updateAnalysis(req.id, data.text);
         } else if (data.error) {
             alert("AI Analysis error: " + data.error);
         } else {
             alert("AI Analysis returned empty result.");
         }
     } catch (e: any) {
         console.error("AI Analysis Error:", e);
         alert("AI Analysis failed: " + (e.message || "Unknown error"));
     }
     setIsAnalyzing(false);
  };

  const handleLoadSession = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = async (ev) => {
          try {
              const text = ev.target?.result as string;
              const json = JSON.parse(text);
              
              const res = await fetch('/api/session/import', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(json)
              });
              
              const data = await res.json();
              if (data.success) {
                  // The WS broadcast will trigger loadHistory() on all clients
              } else {
                  alert("Import Failed: " + (data.error || "Unknown error"));
              }
          } catch (err: any) {
              alert("Invalid JSON File: " + err.message);
          }
      };
      reader.readAsText(file);
      // Clear value so the same file can be uploaded again if needed
      e.target.value = '';
  };

  const exportReport = (req: CapturedRequest) => {
      let docContent = "Penetration Testing Report\n\n";
      docContent += `Target: ${req.url}\n`;
      docContent += `Method: ${req.method}\n`;
      docContent += `Timestamp: ${new Date(req.timestamp).toLocaleString()}\n\n`;
      docContent += "Vulnerability Analysis:\n\n";
      docContent += req.analysis || "No analysis available.";
      
      const blob = new Blob([docContent], { type: 'text/markdown' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `Vuln_Report_${req.id}.md`;
      a.click();
  };

  const selectedRequest = requests.find(r => r.id === selectedReqId);


  return (
    <div className="min-h-screen bg-[#0E1015] text-gray-300 font-sans flex flex-col overflow-hidden h-screen">
      
      {/* Top Header */}
      <header className="h-14 border-b border-gray-800 bg-[#14161C] flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3">
          <Shield className="w-5 h-5 text-indigo-500" />
          <h1 className="text-sm font-semibold tracking-wide text-gray-100 flex items-center gap-2">
            PROXY_ENGINE <span className="bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded text-[10px] font-mono border border-indigo-500/30">v1.0 (Web)</span>
          </h1>
        </div>
        
        <div className="flex items-center gap-4 text-xs font-mono">
           <button 
             onClick={() => setShowArchInfo(true)}
             className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1 bg-indigo-500/10 px-2 py-1 rounded"
           >
             <Info className="w-4 h-4" /> Architecture
           </button>
           <div className="flex items-center gap-2 px-3 py-1.5 bg-[#1C1F26] rounded-md border border-gray-800">
             <div className={cn("w-2 h-2 rounded-full", isConnected ? "bg-green-500" : "bg-red-500 animate-pulse")} />
             <span>ws_bus</span>
           </div>
           
           <div className="flex gap-1 bg-[#1C1F26] p-1 rounded-md border border-gray-800">
             <button 
                onClick={() => setIsCapturing(true)}
                className={cn("p-1.5 rounded transition-colors", isCapturing ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300")}
                title="Start Capture"
             >
                <Play className="w-4 h-4" />
             </button>
             <button 
                onClick={() => setIsCapturing(false)}
                className={cn("p-1.5 rounded transition-colors", !isCapturing ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300")}
                title="Pause Capture"
             >
                <Pause className="w-4 h-4" />
             </button>
           </div>
        </div>
      </header>

      {/* Main Layout */}
      <main className="flex-1 flex min-h-0">
        
        {/* Left Sidebar (Tools) */}
        <div className="w-16 border-r border-gray-800 bg-[#0E1015] flex flex-col items-center py-4 gap-6 shrink-0">
          <button 
             onClick={() => setViewMode('inspector')}
             className={cn("p-2 transition-colors rounded-xl", viewMode === 'inspector' ? "text-indigo-400 bg-indigo-500/10" : "text-gray-600 hover:text-gray-400")} 
             title="Inspector"
          >
            <Activity className="w-6 h-6" />
          </button>
          <button 
             onClick={() => setViewMode('interceptor')}
             className={cn("p-2 transition-colors rounded-xl relative", viewMode === 'interceptor' ? "text-orange-400 bg-orange-500/10" : "text-gray-600 hover:text-gray-400")} 
             title="Live Intercept"
          >
            <Pause className={cn("w-6 h-6", interceptMode ? "animate-pulse text-orange-500" : "")} />
            {interceptMode && <span className="absolute top-1 right-1 w-2 h-2 bg-orange-500 rounded-full border border-[#0E1015]" />}
          </button>
          <button 
             onClick={() => setViewMode('repeater')}
             className={cn("p-2 transition-colors rounded-xl", viewMode === 'repeater' ? "text-green-400 bg-green-400/10" : "text-gray-600 hover:text-gray-400")} 
             title="Repeater"
          >
            <Repeat className="w-6 h-6" />
          </button>
          <button 
             onClick={() => setViewMode('intruder')}
             className={cn("p-2 transition-colors rounded-xl", viewMode === 'intruder' ? "text-purple-400 bg-purple-500/10" : "text-gray-600 hover:text-gray-400")} 
             title="Intruder"
          >
            <Target className="w-6 h-6" />
          </button>
          <button 
             onClick={() => setViewMode('scripts')}
             className={cn("p-2 transition-colors rounded-xl", viewMode === 'scripts' ? "text-[#00E5FF] bg-[#00E5FF]/10" : "text-gray-600 hover:text-gray-400")} 
             title="Match & Replace"
          >
            <ArrowUpDown className="w-6 h-6" />
          </button>
          <button 
             onClick={() => setViewMode('settings')}
             className={cn("p-2 transition-colors rounded-xl mt-auto", viewMode === 'settings' ? "text-gray-100 bg-gray-800" : "text-gray-600 hover:text-gray-400")} 
             title="Settings"
          >
            <Settings className="w-6 h-6" />
          </button>
        </div>

        <PanelGroup orientation="horizontal" className="flex-1">
            {/* Traffic Table */}
            <Panel defaultSize={55} minSize={30} className="flex-1 flex flex-col border-r border-gray-800 min-w-0 relative">
              
              {/* Simulator Bar (Since real Proxy 8080 isn't exposed easily) */}
              <div className="p-3 border-b border-gray-800 bg-[#16181D] shrink-0">
            <div className="text-xs text-gray-500 mb-2 font-mono flex items-center gap-2 justify-between">
                <div className="flex items-center gap-2">
                    <Wifi className="w-3 h-3" />
                    <span>Live Traffic Control Center</span>
                </div>
                <div className="flex items-center gap-2">
                    <button 
                        onClick={() => setViewMode('interceptor')}
                        className="text-[9px] uppercase font-bold text-orange-400 hover:text-orange-300 border border-orange-500/30 px-2 py-0.5 rounded bg-orange-500/5 transition-colors flex items-center gap-1"
                    >
                        <Shield className="w-2.5 h-2.5" />
                        Go to Live Intercept
                    </button>
                    <a 
                      href="/api/ca-cert"
                      className="text-[9px] uppercase font-bold text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded bg-indigo-500/5 transition-colors"
                      title="Install CA certificate to trust diagnostic tunnel"
                    >
                      Trust System
                    </a>
                    <span className="uppercase font-bold tracking-widest text-[9px] text-gray-500">Proxy Mode</span>
                    <button 
                        onClick={() => {
                            const newState = !interceptMode;
                            setInterceptMode(newState);
                            toggleIntercept(newState);
                            // Fallback API if WS is slow
                            fetch('/api/intercept/toggle', {
                               method: 'POST',
                               headers: {'Content-Type': 'application/json'},
                               body: JSON.stringify({ enabled: newState })
                            });
                        }}
                        className={cn("w-10 h-5 rounded-full relative transition-colors border", interceptMode ? "bg-[#00E5FF]/20 border-[#00E5FF] shadow-[0_0_10px_rgba(0,229,255,0.4)]" : "bg-[#0E1015] border-gray-700")}
                    >
                        <div className={cn("absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all", interceptMode ? "left-5 bg-[#00E5FF]" : "left-1 bg-gray-500")} />
                    </button>
                </div>
            </div>
            <div className="flex gap-2">
              <select 
                value={simMethod}
                onChange={(e) => setSimMethod(e.target.value)}
                className="bg-[#0E1015] border border-gray-700 rounded px-2 py-1.5 text-xs font-mono text-gray-300 focus:outline-none focus:border-indigo-500"
              >
                <option>GET</option>
                <option>POST</option>
              </select>
              <input 
                type="text" 
                value={simUrl}
                onChange={(e) => setSimUrl(e.target.value)}
                className="flex-1 bg-[#0E1015] border border-gray-700 rounded px-3 py-1.5 text-xs font-mono text-gray-300 focus:outline-none focus:border-indigo-500 placeholder:text-gray-600"
                placeholder="Target URL..."
              />
              <button 
                onClick={() => simulateRequest(1)}
                disabled={isSimulating || !isConnected}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-4 py-1.5 rounded transition-colors text-xs font-medium flex items-center gap-2"
              >
                <Send className="w-3 h-3" />
                {isSimulating ? 'Sending...' : 'Send'}
              </button>
            </div>
            {simMethod === 'POST' && (
              <div className="mt-2 text-xs">
                 <input 
                    type="text" 
                    value={simBody} 
                    onChange={e => setSimBody(e.target.value)} 
                    placeholder="JSON body (optional)" 
                    className="w-full bg-[#0E1015] border border-gray-700 rounded px-3 py-1.5 font-mono text-gray-300 focus:outline-none focus:border-indigo-500" 
                 />
              </div>
            )}
          </div>

          {/* Intercept Overlay (only shows when there's an active intercept) */}
          {activeIntercept && (
              <div className="absolute top-[100px] left-4 right-4 bg-[#1C1F26] border border-[#00E5FF] shadow-[0_0_20px_rgba(0,229,255,0.1)] rounded-lg p-4 z-50 animate-in fade-in slide-in-from-top-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-[#00E5FF]/20 flex items-center justify-center animate-pulse">
                         <Shield className="w-4 h-4 text-[#00E5FF]" />
                      </div>
                      <div>
                          <div className="text-[10px] uppercase text-[#00E5FF] font-bold tracking-widest hidden sm:block">Approval Required</div>
                          <div className="font-mono text-sm text-gray-100 flex items-center gap-2">
                             <span className="text-yellow-400">{activeIntercept.method}</span>
                             <span className="truncate max-w-[200px]">{new URL(activeIntercept.url).host}</span>
                          </div>
                      </div>
                  </div>
                  <div className="flex items-center gap-2">
                      <button 
                          onClick={() => executeInterceptAction(activeIntercept.id, 'drop')}
                          className="px-4 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded text-xs font-bold border border-red-500/30 transition-colors"
                      >
                          Discard
                      </button>
                      <button 
                          onClick={() => executeInterceptAction(activeIntercept.id, 'forward')}
                          className="px-4 py-1.5 bg-[#00E5FF]/20 hover:bg-[#00E5FF]/30 text-[#00E5FF] rounded text-xs font-bold border border-[#00E5FF]/30 transition-colors"
                      >
                          Release
                      </button>
                      <button 
                          onClick={() => setViewMode('interceptor')}
                          className="px-4 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-xs font-medium border border-gray-700 transition-colors"
                      >
                          Edit & Release
                      </button>
                  </div>
              </div>
          )}

          <div className="flex-1 overflow-auto bg-[#0A0C10] flex flex-col">
            {/* Smart Filters Header */}
            <div className="bg-[#1C1F26] border-b border-gray-800 p-2 flex flex-col gap-2 shrink-0">
               <div className="flex gap-2 items-center text-xs">
                  <span className="text-gray-500 font-bold uppercase tracking-wider">Smart Filters</span>
                  <select 
                     value={methodFilter}
                     onChange={e => setMethodFilter(e.target.value)}
                     className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-0.5 text-gray-300 focus:outline-none focus:border-indigo-500"
                  >
                      <option value="ALL">All Methods</option>
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                  </select>
                  <input 
                     value={searchFilter}
                     onChange={e => setSearchFilter(e.target.value)}
                     placeholder="Search path or body..."
                     className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-0.5 text-gray-300 focus:outline-none focus:border-indigo-500 flex-1"
                  />
                  <button className="bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 px-3 py-0.5 rounded border border-indigo-500/30 transition-colors">
                      Save View
                  </button>
               </div>
               <div className="flex gap-2">
                  {savedFilters.map((sf, i) => (
                      <button 
                         key={i}
                         onClick={() => { setMethodFilter(sf.method); setSearchFilter(sf.search); }}
                         className="text-[10px] bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-0.5 rounded-full border border-gray-700 flex items-center transition-colors"
                      >
                         {sf.name}
                      </button>
                  ))}
               </div>
            </div>
            
            <table className="w-full text-left text-xs text-gray-400 font-mono whitespace-nowrap">
              <thead className="bg-[#14161C] sticky top-0 border-b border-gray-800 shadow-sm z-10 text-gray-500 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-2.5 font-medium">#</th>
                  <th className="px-4 py-2.5 font-medium">Method</th>
                  <th className="px-4 py-2.5 font-medium">Host</th>
                  <th className="px-4 py-2.5 font-medium">URL</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium text-right">Length</th>
                </tr>
              </thead>
              <tbody>
                {filteredRequests.length === 0 && (
                   <tr>
                     <td colSpan={6} className="px-4 py-8 text-center text-gray-600 italic">No traffic matches the current filters.</td>
                   </tr>
                )}
                {filteredRequests.map((req) => (
                  <TrafficRow 
                    key={req.id} 
                    req={req} 
                    isSelected={selectedReqId === req.id} 
                    onSelect={onSelectRequest} 
                    onIgnoreDomain={(domain) => {
                        if (!ignoredDomains.includes(domain)) {
                            setIgnoredDomains(prev => [...prev, domain]);
                        }
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <PanelResizeHandle className="w-1 bg-gray-800 hover:bg-[#00E5FF] cursor-col-resize transition-colors" />

        {/* Right Detail Pane */}
        <Panel defaultSize={45} minSize={30} className="w-[45%] flex flex-col bg-[#14161C] shrink-0 border-l border-gray-800">
           <div className="h-10 border-b border-gray-800 bg-[#1C1F26] flex items-center shrink-0">
               <button 
                  onClick={() => setViewMode('inspector')}
                  className={cn("h-full px-4 text-xs font-semibold uppercase tracking-widest border-b-2 transition-colors", viewMode === 'inspector' ? "border-[#00E5FF] text-[#00E5FF]" : "border-transparent text-gray-500 hover:text-gray-300")}
               >
                   Inspector
               </button>
               <button 
                  onClick={() => setViewMode('repeater')}
                  className={cn("h-full px-4 text-xs font-semibold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-1", viewMode === 'repeater' ? "border-[#00E5FF] text-[#00E5FF]" : "border-transparent text-gray-500 hover:text-gray-300")}
               >
                   <Repeat className="w-3.5 h-3.5" />
                   Repeater
               </button>
               <button 
                  onClick={() => setViewMode('intruder')}
                  className={cn("h-full px-4 text-xs font-semibold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-1", viewMode === 'intruder' ? "border-[#00E5FF] text-[#00E5FF]" : "border-transparent text-gray-500 hover:text-gray-300")}
               >
                   <Target className="w-3.5 h-3.5" />
                   Intruder
               </button>
               <button 
                  onClick={() => setViewMode('interceptor')}
                  className={cn("h-full px-4 text-xs font-semibold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-2", viewMode === 'interceptor' ? "border-[#00E5FF] text-[#00E5FF]" : "border-transparent text-gray-500 hover:text-gray-300")}
               >
                   <Shield className={cn("w-3.5 h-3.5", activeIntercepts.length > 0 ? "text-orange-500 animate-pulse" : "")} />
                   Live Intercept {activeIntercepts.length > 0 && `(${activeIntercepts.length})`}
               </button>
               <button 
                  onClick={() => setViewMode('settings')}
                  className={cn("h-full px-4 text-xs font-semibold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-1", viewMode === 'settings' ? "border-[#00E5FF] text-[#00E5FF]" : "border-transparent text-gray-500 hover:text-gray-300")}
               >
                   <Settings className="w-3.5 h-3.5" />
                   Proxy Settings
               </button>
               <button 
                  onClick={() => setViewMode('websockets')}
                  className={cn("h-full px-4 text-xs font-semibold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-1", viewMode === 'websockets' ? "border-[#00E5FF] text-[#00E5FF]" : "border-transparent text-gray-500 hover:text-gray-300")}
               >
                   WebSockets
               </button>
               <button 
                  onClick={() => setViewMode('scripts')}
                  className={cn("h-full px-4 text-xs font-semibold uppercase tracking-widest border-b-2 transition-colors flex items-center gap-1", viewMode === 'scripts' ? "border-[#00E5FF] text-[#00E5FF]" : "border-transparent text-gray-500 hover:text-gray-300")}
               >
                   Scripts
               </button>
           </div>
           
            {viewMode === 'interceptor' ? (
               <div className="flex-1 overflow-y-auto p-0 flex flex-col font-mono text-sm hide-scrollbar bg-[#0E1015]">
                  {/* Master Toolbar */}
                  <div className="h-12 border-b border-gray-800 bg-[#14161C] flex items-center px-4 shrink-0 gap-4">
                      <button 
                         onClick={() => toggleIntercept(!interceptMode)}
                         className={cn(
                             "px-4 py-1.5 rounded text-xs font-bold uppercase tracking-wider border transition-all flex items-center gap-2",
                             interceptMode 
                                ? "bg-orange-500/20 text-orange-400 border-orange-500/40 hover:bg-orange-500/30" 
                                : "bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-400"
                         )}
                      >
                          <Pause className={cn("w-3.5 h-3.5", interceptMode ? "animate-pulse" : "")} />
                          Intercept Requests: {interceptMode ? 'ON' : 'OFF'}
                      </button>

                      <button 
                         onClick={() => {
                             const newState = !responseInterceptMode;
                             toggleResponseIntercept(newState);
                             setResponseInterceptMode(newState);
                             fetch('/api/intercept/response/toggle', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({ enabled: newState })
                             });
                         }}
                         className={cn(
                             "px-4 py-1.5 rounded text-xs font-bold uppercase tracking-wider border transition-all flex items-center gap-2",
                             responseInterceptMode 
                                ? "bg-orange-500/20 text-orange-400 border-orange-500/40 hover:bg-orange-500/30" 
                                : "bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-400"
                         )}
                      >
                          <Pause className={cn("w-3.5 h-3.5", responseInterceptMode ? "animate-pulse" : "")} />
                          Intercept Responses: {responseInterceptMode ? 'ON' : 'OFF'}
                      </button>

                       {activeIntercept && (
                        <div className="flex items-center gap-2 border-l border-gray-800 pl-4">
                            <button 
                                onClick={() => executeInterceptAction(activeIntercept.id, 'forward')}
                                className="px-4 py-1.5 bg-[#00E5FF]/20 hover:bg-[#00E5FF]/30 text-[#00E5FF] rounded text-xs font-bold border border-[#00E5FF]/30 transition-colors uppercase"
                            >
                                {activeIntercept.status === 'response_intercepted' ? 'Finish Review' : 'Release'}
                            </button>
                            <button 
                                onClick={() => executeInterceptAction(activeIntercept.id, 'drop')}
                                className="px-4 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded text-xs font-bold border border-red-500/30 transition-colors uppercase"
                            >
                                Discard
                            </button>
                            <div className="h-6 w-px bg-gray-800 mx-2" />
                            <button 
                                onClick={() => {
                                   setRepeaterUrl(interceptUrl);
                                   setRepeaterMethod(interceptMethod);
                                   setRepeaterHeaders(interceptHeaders);
                                   setRepeaterBody(interceptBody);
                                   setViewMode('repeater');
                                }}
                                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-[10px] font-bold border border-gray-700 transition-colors uppercase flex items-center gap-1.5"
                            >
                                <Repeat className="w-3 h-3" />
                                To Repeater
                            </button>
                            <button 
                                onClick={() => {
                                   setRepeaterUrl(interceptUrl);
                                   setRepeaterMethod(interceptMethod);
                                   setRepeaterHeaders(interceptHeaders);
                                   setRepeaterBody(interceptBody);
                                   setViewMode('intruder');
                                }}
                                className="px-3 py-1.5 bg-indigo-900/40 hover:bg-indigo-900/60 text-indigo-300 rounded text-[10px] font-bold border border-indigo-500/30 transition-colors uppercase flex items-center gap-1.5"
                            >
                                <Target className="w-3 h-3" />
                                To Intruder
                            </button>
                            <button 
                                onClick={analyzeIntercept}
                                disabled={isAnalyzing}
                                className="px-3 py-1.5 bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 rounded text-[10px] font-bold border border-purple-500/30 transition-colors uppercase flex items-center gap-1.5 disabled:opacity-50"
                            >
                                {isAnalyzing ? <Loader2 className="w-3 h-3 animate-spin"/> : <Sparkles className="w-3 h-3" />}
                                AI Analysis
                            </button>
                        </div>
                      )}
                      
                      <div className="ml-auto flex items-center gap-3">
                          <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest leading-none">
                             {activeIntercepts.length > 0 ? `1 of ${activeIntercepts.length} in Review Queue` : 'No active reviews'}
                          </span>
                      </div>
                  </div>

                  {/* Ignored Domains Filter */}
                  <div className="bg-[#14161C] border-b border-gray-800 p-3 flex items-center gap-4">
                      <div className="flex items-center gap-2 text-gray-400 shrink-0">
                          <Filter className="w-4 h-4" />
                          <span className="text-[10px] font-bold uppercase tracking-widest">Interception Scope</span>
                      </div>
                      <div className="flex-1 flex items-center gap-2 overflow-x-auto py-1 scrollbar-hide">
                          {ignoredDomains.map(domain => (
                              <div key={domain} className="bg-gray-800/50 border border-gray-700/50 rounded-full px-2.5 py-0.5 flex items-center gap-1.5 shrink-0 group">
                                  <Globe className="w-3 h-3 text-gray-600" />
                                  <span className="text-[10px] text-gray-400 font-mono italic">*{domain}</span>
                                  <button 
                                      onClick={() => setIgnoredDomains(prev => prev.filter(d => d !== domain))}
                                      className="text-gray-600 hover:text-red-400 transition-colors"
                                  >
                                      <X className="w-3 h-3" />
                                  </button>
                              </div>
                          ))}
                          <div className="flex items-center gap-1.5 ml-2 border-l border-gray-800 pl-3">
                              <input 
                                  type="text"
                                  placeholder="Ignore domain (e.g. google.com)"
                                  value={newIgnoreDomain}
                                  onChange={e => setNewIgnoreDomain(e.target.value)}
                                  onKeyDown={e => {
                                      if (e.key === 'Enter' && newIgnoreDomain.trim()) {
                                          const domain = newIgnoreDomain.trim().toLowerCase();
                                          if (!ignoredDomains.includes(domain)) {
                                              setIgnoredDomains(prev => [...prev, domain]);
                                          }
                                          setNewIgnoreDomain('');
                                      }
                                  }}
                                  className="bg-transparent border-none outline-none text-[10px] text-indigo-400 w-48 placeholder:text-gray-700 font-mono"
                              />
                              <Plus className="w-3 h-3 text-gray-700 font-bold" />
                          </div>
                      </div>
                      <div className="text-[9px] text-gray-700 italic border-l border-gray-800 pl-3 shrink-0 uppercase font-black tracking-tighter">
                          Bypasses Pause Gate
                      </div>
                  </div>

                  {!activeIntercept ? (
                     <div className="flex-1 flex flex-col items-center justify-center text-gray-600 space-y-4 opacity-50">
                        <Shield className="w-16 h-16" />
                        <div className="text-center font-sans">
                            <h3 className="text-lg font-bold text-gray-400">Review Queue Empty</h3>
                            <p className="text-sm">Requests will pause here for inspection.</p>
                        </div>
                     </div>
                  ) : (
                    <div className="flex-1 flex min-h-0 bg-[#0A0C10]">
                        {/* Metadata Transformation Workspace */}
                        <div className="flex-1 p-4 flex flex-col space-y-4 border-r border-gray-800 overflow-y-auto hide-scrollbar">
                         {activeIntercept.status === 'intercepted' && (
                             <label className="flex items-center gap-2 cursor-pointer bg-orange-500/10 border border-orange-500/30 p-2 rounded w-max text-orange-400 text-xs font-bold uppercase tracking-wider">
                                 <input 
                                     type="checkbox" 
                                     checked={interceptResponseFlag}
                                     onChange={(e) => setInterceptResponseFlag(e.target.checked)} 
                                     className="accent-orange-500 w-3.5 h-3.5"
                                 />
                                 Intercept response to this request
                             </label>
                         )}
                         <div className="flex gap-2">
                           <input 
                              value={interceptMethod}
                              onChange={e => setInterceptMethod(e.target.value)}
                              className="w-24 bg-[#16181D] border border-gray-700 rounded px-2 py-1.5 text-gray-300 focus:outline-none focus:border-indigo-500 font-bold"
                           />
                           <input 
                              className="flex-1 bg-[#16181D] border border-gray-700 rounded px-3 py-1.5 text-gray-300 focus:outline-none focus:border-indigo-500"
                              value={interceptUrl}
                              onChange={e => setInterceptUrl(e.target.value)}
                           />
                        </div>
                        
                            <div className="flex flex-col gap-1">
                                <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest pl-1">Protocol Headers</span>
                                <textarea 
                                    className="h-48 bg-[#16181D] border border-gray-700 rounded p-3 text-xs text-green-400 focus:outline-none focus:border-[#00E5FF] resize-none font-mono leading-relaxed"
                                    value={interceptHeaders}
                                    onChange={e => setInterceptHeaders(e.target.value)}
                                />
                            </div>
                        
                        <div className="flex-1 flex flex-col gap-1 min-h-0">
                           <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest pl-1">Body Buffer</span>
                           <textarea 
                               className="flex-1 min-h-[300px] bg-[#16181D] border border-gray-700 rounded p-3 text-xs text-gray-300 focus:outline-none focus:border-[#00E5FF] resize-none font-mono leading-relaxed"
                               value={interceptBody}
                               onChange={e => setInterceptBody(e.target.value)}
                           />
                        </div>
                        </div>

                        {/* Template Library Sidebar */}
                        <div className="w-48 shrink-0 bg-[#121419] flex flex-col p-3 gap-4 border-l border-gray-900 overflow-y-auto">
                            <div className="text-[10px] text-gray-500 font-bold uppercase tracking-widest flex items-center gap-2">
                                <Sparkles className="w-3 h-3 text-[#00E5FF]" />
                                Template Library
                            </div>
                            <div className="space-y-2">
                                {templates.map((t, idx) => (
                                    <button 
                                        key={idx}
                                        onClick={() => setInterceptBody(t.value)}
                                        className="w-full text-left p-2 rounded bg-gray-800/50 hover:bg-gray-700/50 border border-gray-700/50 transition-all group"
                                    >
                                        <div className="text-[11px] font-bold text-gray-300 group-hover:text-[#00E5FF]">{t.name}</div>
                                        <div className="text-[9px] text-gray-500 truncate mt-0.5">{t.value}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                  )}
              </div>
           ) : viewMode === 'intruder' ? (
              <div className="flex-1 overflow-y-auto p-4 flex flex-col space-y-4 font-mono text-sm hide-scrollbar">
                 <div className="flex items-center justify-between">
                     <div className="text-xs font-bold text-gray-400 uppercase">Intruder Fuzzer</div>
                     <div className="text-xs text-gray-500">Insert <span className="text-[#00E5FF]">{'{FUZZ}'}</span> anywhere to inject payloads.</div>
                 </div>
                 <div className="flex gap-2">
                    <select 
                       value={repeaterMethod}
                       onChange={e => setRepeaterMethod(e.target.value)}
                       className="bg-[#0E1015] border border-gray-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-indigo-500"
                    >
                        <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option><option>PATCH</option>
                    </select>
                    <input 
                       className="flex-1 bg-[#0E1015] border border-gray-700 rounded px-3 py-1 text-gray-300 focus:outline-none focus:border-indigo-500 placeholder-gray-600"
                       value={repeaterUrl}
                       onChange={e => setRepeaterUrl(e.target.value)}
                       placeholder="https://example.com/api/user/{FUZZ}"
                    />
                    <button 
                       onClick={() => setRepeaterUrl(repeaterUrl + '{FUZZ}')}
                       className="bg-[#00E5FF]/10 text-[#00E5FF] hover:bg-[#00E5FF]/20 px-3 py-1 rounded text-xs font-bold border border-[#00E5FF]/30 transition-colors whitespace-nowrap"
                    >
                        Add {'{FUZZ}'}
                    </button>
                    <button 
                       onClick={executeFuzzer}
                       disabled={isFuzzing}
                       className="bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 px-4 py-1 rounded flex items-center gap-2 border border-indigo-500/30 transition-colors"
                    >
                        {isFuzzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Target className="w-4 h-4" />}
                        <span>{isFuzzing ? 'Fuzzing...' : 'Start Fuzz'}</span>
                    </button>
                 </div>
                 
                 <div className="flex flex-wrap items-center gap-4 bg-[#16181D] border border-gray-800 p-2 rounded px-3">
                     <span className="text-xs text-gray-500 font-bold uppercase tracking-wider flex items-center gap-1">
                        <Activity className="w-3.5 h-3.5 text-orange-500" />
                        Stealth Settings
                     </span>
                     <label className="flex items-center gap-2 cursor-pointer">
                        <input 
                           type="checkbox" 
                           checked={fuzzRotateUA}
                           onChange={e => setFuzzRotateUA(e.target.checked)}
                           className="bg-gray-800 border-gray-600 rounded text-indigo-500"
                        />
                        <span className="text-[10px] text-gray-400">Rotate User-Agent</span>
                     </label>
                     <div className="flex items-center gap-2">
                         <span className="text-[10px] text-gray-400">Jitter (ms):</span>
                         <input 
                             type="number" 
                             min="0" step="50"
                             value={fuzzJitter}
                             onChange={e => setFuzzJitter(parseInt(e.target.value) || 0)}
                             className="w-16 bg-[#0E1015] border border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-300 focus:outline-none focus:border-indigo-500"
                         />
                     </div>
                 </div>

                 <div className="grid grid-cols-2 gap-4 flex-none">
                     <div className="flex flex-col gap-1">
                        <span className="text-xs text-gray-500 font-bold uppercase tracking-wider">Headers (Raw Format Key: Value)</span>
                        <textarea 
                            className="h-24 bg-[#0E1015] border border-gray-700 rounded p-2 text-[10px] text-green-400 focus:outline-none focus:border-indigo-500 resize-none whitespace-pre font-mono"
                            value={repeaterHeaders}
                            onChange={e => setRepeaterHeaders(e.target.value)}
                            placeholder="User-Agent: Fuzzer/1.0"
                        />
                     </div>
                     <div className="flex flex-col gap-1">
                        <span className="text-xs text-gray-500 font-bold uppercase tracking-wider">Payloads (1 per line)</span>
                        <textarea 
                            className="h-24 bg-[#0E1015] border border-gray-700 rounded p-2 text-[10px] text-yellow-400 focus:outline-none focus:border-indigo-500 resize-none whitespace-pre"
                            value={fuzzPayloads}
                            onChange={e => setFuzzPayloads(e.target.value)}
                        />
                     </div>
                 </div>

                 {isFuzzing && (
                     <div className="w-full bg-[#16181D] rounded-full h-2 mt-4 overflow-hidden">
                        <div className="bg-[#00E5FF] h-2 transition-all duration-300" style={{ width: `${(fuzzProgress.current / fuzzProgress.total) * 100}%` }}></div>
                     </div>
                 )}

                 <div className="flex-1 flex min-h-[300px] gap-4">
                     <div className="flex-1 overflow-auto bg-[#0A0C10] rounded border border-gray-800 flex flex-col">
                         <table className="w-full text-left text-[10px] text-gray-400 font-mono whitespace-nowrap">
                             <thead className="bg-[#14161C] sticky top-0 border-b border-gray-800">
                                 <tr>
                                     <th className="px-3 py-2 font-medium">Payload</th>
                                     <th className="px-3 py-2 font-medium cursor-pointer hover:text-white" onClick={() => { setSortBy('status'); setSortDesc(!sortDesc) }}>
                                         <div className="flex items-center gap-1">Status <ArrowUpDown className="w-2.5 h-2.5"/></div>
                                     </th>
                                     <th className="px-3 py-2 font-medium text-right cursor-pointer hover:text-white" onClick={() => { setSortBy('length'); setSortDesc(!sortDesc) }}>
                                         <div className="flex items-center gap-1 justify-end">Length <ArrowUpDown className="w-2.5 h-2.5"/></div>
                                     </th>
                                     <th className="px-3 py-2 font-medium text-right cursor-pointer hover:text-white" onClick={() => { setSortBy('time'); setSortDesc(!sortDesc) }}>
                                         <div className="flex items-center gap-1 justify-end">Time ms <ArrowUpDown className="w-2.5 h-2.5"/></div>
                                     </th>
                                 </tr>
                             </thead>
                             <tbody>
                                 {fuzzResults.sort((a, b) => {
                                     let diff = 0;
                                     if (sortBy === 'status') diff = a.statusCode - b.statusCode;
                                     if (sortBy === 'length') diff = a.length - b.length;
                                     if (sortBy === 'time') diff = a.duration - b.duration;
                                     return sortDesc ? -diff : diff;
                                 }).map((r, i) => (
                                     <tr key={i} onClick={() => setSelectedFuzzResult(r)} className={cn("border-b border-gray-800/50 hover:bg-[#16181D] cursor-pointer", r.isAnomaly ? "bg-orange-900/10" : "", selectedFuzzResult === r ? "bg-indigo-500/10" : "")}>
                                         <td className={cn("px-3 py-1.5", r.isAnomaly ? "text-orange-400 font-bold" : "text-gray-300")}>{r.payload}</td>
                                         <td className="px-3 py-1.5">
                                             {r.error ? <span className="text-red-500">ERR</span> : 
                                             <span className={r.statusCode < 400 ? "text-green-400" : "text-yellow-400"}>{r.statusCode}</span>}
                                         </td>
                                         <td className="px-3 py-1.5 text-right">{r.length}</td>
                                         <td className="px-3 py-1.5 text-right">{r.duration}</td>
                                     </tr>
                                 ))}
                             </tbody>
                         </table>
                     </div>

                     {selectedFuzzResult && (
                        <div className="w-1/3 flex flex-col bg-[#0A0C10] rounded border border-gray-800 overflow-hidden font-mono text-[11px]">
                           <div className="h-8 bg-[#14161C] border-b border-gray-800 flex items-center justify-between px-3">
                              <span className="text-[10px] text-gray-500 uppercase font-bold">Fuzz Response Inspect</span>
                              <button onClick={() => setSelectedFuzzResult(null)} className="text-gray-500 hover:text-gray-300">
                                 <X className="w-3.5 h-3.5" />
                              </button>
                           </div>
                           <div className="flex-1 overflow-auto p-3 space-y-3 leading-tight">
                              <div>
                                 <div className="text-[10px] text-gray-600 uppercase mb-1">Status</div>
                                 <div className={cn("font-bold", selectedFuzzResult.statusCode < 400 ? "text-green-400" : "text-red-400")}>
                                    {selectedFuzzResult.statusCode}
                                 </div>
                              </div>
                              {selectedFuzzResult.headers && (
                                 <div>
                                    <div className="text-[10px] text-gray-600 uppercase mb-1">Headers</div>
                                    {Object.entries(selectedFuzzResult.headers).map(([k, v]) => (
                                       <div key={k} className="text-gray-500 truncate whitespace-nowrap" title={`${k}: ${v}`}>
                                          <span className="text-gray-400">{k}:</span> {v as string}
                                       </div>
                                    ))}
                                 </div>
                              )}
                              <div>
                                 <div className="text-[10px] text-gray-600 uppercase mb-1">Body</div>
                                 <div className="bg-black/30 p-2 rounded border border-gray-800/50">
                                    <PrettyViewer body={selectedFuzzResult.body} isResponse />
                                 </div>
                              </div>
                           </div>
                        </div>
                     )}
                 </div>
              </div>
           ) : viewMode === 'repeater' ? (
              <div className="flex-1 flex flex-col min-h-0 bg-[#0E1015]">
                 <div className="h-12 border-b border-gray-800 flex items-center px-4 gap-2 shrink-0 bg-[#14161C]">
                   <select 
                      value={repeaterMethod}
                      onChange={e => setRepeaterMethod(e.target.value)}
                      className="bg-[#0E1015] border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none"
                   >
                       <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option><option>PATCH</option>
                   </select>
                   <input 
                      className="flex-1 bg-[#0E1015] border border-gray-700 rounded px-3 py-1 text-xs text-gray-300 focus:outline-none"
                      value={repeaterUrl}
                      onChange={e => setRepeaterUrl(e.target.value)}
                   />
                   <button 
                      onClick={executeRepeater}
                      disabled={isRepeating}
                      className="bg-[#00E5FF]/10 text-[#00E5FF] px-4 py-1.5 rounded flex items-center gap-2 border border-[#00E5FF]/20"
                   >
                       {isRepeating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                       <span>Send</span>
                   </button>
                   {repeaterResponse && (
                      <div className="ml-4 flex items-center gap-3 text-[10px] uppercase font-bold px-3 border-l border-gray-800 h-full">
                         <span className={repeaterResponse.status_code < 400 ? "text-green-500" : "text-red-500"}>
                            Status: {repeaterResponse.status_code}
                         </span>
                         <span className="text-gray-500">
                            Time: {repeaterResponse.duration_ms}ms
                         </span>
                      </div>
                   )}
                 </div>

                 <div className="flex-1 flex min-h-0 divide-x divide-gray-800 overflow-hidden">
                     <div className="flex-1 flex flex-col p-4 space-y-4 overflow-y-auto hide-scrollbar text-[11px]">
                        <div className="flex flex-col gap-1">
                           <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Headers</span>
                           <textarea 
                               className="h-32 bg-[#0A0C10] border border-gray-700 rounded p-2 text-green-400 focus:outline-none font-mono resize-none"
                               value={repeaterHeaders}
                               onChange={e => setRepeaterHeaders(e.target.value)}
                           />
                        </div>
                        <div className="flex-1 flex flex-col gap-1">
                           <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Body</span>
                           <textarea 
                               className="flex-1 min-h-[200px] bg-[#0A0C10] border border-gray-700 rounded p-3 text-gray-300 focus:outline-none font-mono resize-none"
                               value={repeaterBody}
                               onChange={e => setRepeaterBody(e.target.value)}
                           />
                        </div>
                     </div>

                     <div className="flex-1 flex flex-col bg-[#0A0C10] overflow-y-auto hide-scrollbar p-4 relative text-[11px] font-mono leading-relaxed">
                        <div className="text-[10px] text-gray-600 uppercase border border-gray-700/50 px-1.5 py-0.5 rounded absolute top-2 right-4">Response</div>
                        {repeaterResponse ? (
                            <div className="space-y-4 mt-4 text-[11px]">
                               <div className="space-y-1">
                                  {Object.entries(repeaterResponse.headers).map(([k, v]) => (
                                     <div key={k} className="text-gray-400">{k}: <span className="text-gray-500">{(v as any)}</span></div>
                                  ))}
                               </div>
                               <PrettyViewer body={repeaterResponse.body} isResponse />
                            </div>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center text-gray-600 italic space-y-2 opacity-30">
                               <Activity className="w-10 h-10" />
                               <p className="text-[10px] uppercase font-bold tracking-widest">Awaiting execution</p>
                            </div>
                        )}
                     </div>
                 </div>
              </div>
           ) : viewMode === 'scripts' ? (
              <div className="flex-1 overflow-y-auto p-4 flex flex-col space-y-4 font-mono text-sm hide-scrollbar">
                  <div className="text-xs font-bold text-gray-400 uppercase flex justify-between items-center">
                      <span>Match & Replace Engine</span>
                      <button className="bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 px-3 py-1 rounded border border-indigo-500/30 transition-colors">Save & Activate</button>
                  </div>
                  <div className="text-xs text-gray-500">
                      Write raw JavaScript functions to evaluate against matched incoming intercepts. 
                      Modify headers or body before it reaches the Inspector queue.
                  </div>
                   <div className="p-4 space-y-4">
                       {replacementRules.map((rule, idx) => (
                           <div key={rule.id} className="bg-[#14161C] border border-gray-800 p-4 rounded-lg flex flex-col gap-3 group relative shadow-md">
                               <div className="flex items-center gap-3">
                                   <div className="flex flex-col gap-1 w-32">
                                       <span className="text-[9px] uppercase font-bold text-gray-600 ml-1">Type</span>
                                       <select 
                                         value={rule.type} 
                                         onChange={e => {
                                             const updated = [...replacementRules];
                                             updated[idx].type = e.target.value;
                                             saveRules(updated);
                                         }}
                                         className="bg-[#0E1015] border border-gray-700 text-[10px] uppercase font-bold px-2 py-1.5 rounded text-gray-400 outline-none focus:border-indigo-500 transition-colors"
                                       >
                                           <option value="url">URL Match</option>
                                           <option value="body">Body Regex</option>
                                           <option value="header">Header Match</option>
                                       </select>
                                   </div>
                                   
                                   <div className="flex flex-col gap-1 flex-1">
                                       <span className="text-[9px] uppercase font-bold text-gray-600 ml-1">Match (Regex)</span>
                                       <input 
                                         type="text" 
                                         placeholder="Pattern" 
                                         value={rule.match}
                                         onChange={e => {
                                             const updated = [...replacementRules];
                                             updated[idx].match = e.target.value;
                                             saveRules(updated);
                                         }}
                                         className="bg-[#0E1015] border border-gray-700 rounded px-3 py-1.5 text-xs focus:border-indigo-500 outline-none transition-colors font-mono"
                                       />
                                   </div>
                                   
                                   <div className="text-gray-700 font-bold self-end mb-2">→</div>
                                   
                                   <div className="flex flex-col gap-1 flex-1">
                                       <span className="text-[9px] uppercase font-bold text-gray-600 ml-1">Replace With</span>
                                       <input 
                                         type="text" 
                                         placeholder="Replacement string" 
                                         value={rule.replace}
                                         onChange={e => {
                                             const updated = [...replacementRules];
                                             updated[idx].replace = e.target.value;
                                             saveRules(updated);
                                         }}
                                         className="bg-[#0E1015] border border-gray-700 rounded px-3 py-1.5 text-xs focus:border-[#00E5FF] outline-none transition-colors font-mono"
                                       />
                                   </div>
                                   
                                   <div className="flex flex-col gap-1 self-end mb-1">
                                       <button 
                                          onClick={() => {
                                              const updated = [...replacementRules];
                                              updated[idx].active = !updated[idx].active;
                                              saveRules(updated);
                                          }}
                                          className={cn("px-4 py-1.5 rounded text-[10px] font-bold uppercase transition-all shadow-sm", rule.active ? "bg-green-500/20 text-green-400 border border-green-500/30" : "bg-gray-800 text-gray-600 border border-gray-700")}
                                       >
                                           {rule.active ? 'Active' : 'Disabled'}
                                       </button>
                                   </div>
                                   
                                   <button 
                                     onClick={() => saveRules(replacementRules.filter(r => r.id !== rule.id))}
                                     className="absolute top-2 right-2 p-1.5 opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-500 hover:bg-red-500/10 rounded transition-all"
                                   >
                                       <X className="w-3.5 h-3.5" />
                                   </button>
                               </div>
                           </div>
                       ))}
                       {replacementRules.length === 0 && (
                           <div className="flex flex-col items-center justify-center py-32 border-2 border-dashed border-gray-800/50 rounded-xl text-gray-600 bg-[#0E1015]/50">
                               <ArrowUpDown className="w-12 h-12 mb-4 opacity-10" />
                               <p className="text-xs font-bold uppercase tracking-widest opacity-30">No active replacement rules</p>
                               <button 
                                 onClick={() => {
                                     const newRule = { id: (Math.random() * 100000).toString(16), match: '.*', replace: '', type: 'url', active: true };
                                     saveRules([...replacementRules, newRule]);
                                 }}
                                 className="mt-6 text-indigo-400 hover:text-indigo-300 text-[10px] font-bold uppercase border-b border-indigo-500/30 pb-0.5"
                               >
                                 Create First Rule
                               </button>
                           </div>
                       )}
                   </div>
              </div>
           ) : viewMode === 'settings' ? (
              <div className="flex-1 overflow-y-auto p-6 flex flex-col font-sans space-y-8 bg-[#0A0C10] text-gray-300">
                  <div>
                      <h2 className="text-xl font-bold text-gray-100 flex items-center gap-2 mb-4">
                          <Settings className="w-6 h-6 text-indigo-400" /> Proxy Connectivity Hub
                      </h2>
                      <p className="text-gray-400 text-sm leading-relaxed mb-6">
                          To intercept traffic from your browser or external tools, configure them to route traffic through the Proxy Engine's diagnostic tunnel.
                          {window.location.hostname.endsWith('.run.app') && (
                              <div className="mt-3 p-3 bg-orange-500/10 border border-orange-500/20 text-orange-400 rounded-lg text-xs leading-relaxed">
                                  <span className="font-bold block mb-1">CLOUD PREVIEW RESTRICTION</span>
                                  Direct browser proxying to port {serverConfig.proxyPort} is restricted in the Cloud Environment due to network isolation. 
                                  To use this feature, please <strong>run this application locally</strong> on your machine.
                              </div>
                          )}
                      </p>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="bg-[#14161C] border border-gray-800 p-5 rounded-lg space-y-4 shadow-lg shadow-black/20">
                          <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider flex items-center gap-2">
                              <Wifi className="w-4 h-4 text-[#00E5FF]" /> Tunnel Configuration
                          </h3>
                          <div className="space-y-3 font-mono text-sm">
                              <div className="flex justify-between items-center py-2 border-b border-gray-800/50">
                                  <span className="text-gray-500">Gateway Status</span>
                                  <div className={clsx(
                                      "text-[10px] font-bold uppercase px-2 py-0.5 rounded flex items-center gap-1.5 border",
                                      serverConfig.proxyStatus === 'UP' ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-red-500/10 text-red-400 border-red-500/20 animate-pulse"
                                  )}>
                                      <span className={clsx("w-1.5 h-1.5 rounded-full", serverConfig.proxyStatus === 'UP' ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" : "bg-red-400")} />
                                      {serverConfig.proxyStatus || 'OFFLINE'}
                                  </div>
                              </div>
                              <div className="flex justify-between items-center py-2 border-b border-gray-800/50">
                                  <span className="text-gray-500">Local Address</span>
                                  <span className="text-green-400 bg-green-400/10 px-2 py-0.5 rounded border border-green-400/20">{window.location.hostname}</span>
                              </div>
                              <div className="flex justify-between items-center py-2 border-b border-gray-800/50">
                                  <span className="text-gray-500">Intercept Port</span>
                                  <span className="text-[#00E5FF] bg-[#00E5FF]/10 px-2 py-0.5 rounded border border-[#00E5FF]/20">{serverConfig.proxyPort}</span>
                              </div>
                              <div className="flex justify-between items-center py-2 border-b border-gray-800/50">
                                  <span className="text-gray-500">Protocols</span>
                                  <span className="text-indigo-400">HTTP / HTTPS / WS</span>
                              </div>
                          </div>
                      </div>

                      <div className="bg-[#14161C] border border-gray-800 p-5 rounded-lg space-y-4 shadow-lg shadow-black/20 flex flex-col items-start justify-between">
                          <div>
                              <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider flex items-center gap-2 mb-2">
                                  <Shield className="w-4 h-4 text-orange-400" /> Trust System (CA)
                              </h3>
                              <p className="text-xs text-gray-500 leading-relaxed">
                                  To decrypt and inspect HTTPS traffic, you must install and trust the generated Root Certificate Authority in your browser or system keychain.
                              </p>
                          </div>
                          <a 
                             href="/api/ca-cert"
                             className="mt-4 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded font-medium flex items-center gap-2 transition-colors border border-indigo-400 w-max shadow-sm"
                          >
                              <FileDown className="w-4 h-4" /> Download Certificate
                          </a>
                      </div>

                      <div className="bg-[#14161C] border border-gray-800 p-5 rounded-lg space-y-4 shadow-lg shadow-black/20 flex flex-col items-start justify-between">
                           <div>
                               <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider flex items-center gap-2 mb-2">
                                   <Database className="w-4 h-4 text-purple-400" /> Session Archive
                               </h3>
                               <p className="text-xs text-gray-400 leading-relaxed mb-1">
                                   Save current audit trail or restore a previous session. Data is ephemeral and auto-purges on app lifecycle events.
                               </p>
                               <p className="text-[10px] text-orange-400/80 italic flex items-center gap-1">
                                   <Info className="w-3 h-3" /> Note: For a fully clean session including browser cookies/history, please use an Incognito/Private window.
                               </p>
                           </div>
                           <div className="flex flex-wrap gap-3 mt-4">
                               <button 
                                  onClick={() => window.location.href = '/api/session/export'}
                                  className="bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-400 px-4 py-2 rounded font-medium flex items-center gap-2 transition-colors border border-emerald-500/30 text-xs"
                               >
                                   <FileDown className="w-3.5 h-3.5" /> Export Session
                               </button>
                               <label className="bg-purple-600/10 hover:bg-purple-600/20 text-purple-300 px-4 py-2 rounded font-medium flex items-center gap-2 border border-purple-500/30 cursor-pointer transition-colors shadow-sm text-xs">
                                   <Play className="w-3 h-3 rotate-90" /> Load Session
                                   <input type="file" className="hidden" accept=".json" onChange={handleLoadSession} />
                               </label>
                           </div>
                      </div>
                  </div>

                  <div className="space-y-4">
                      <h3 className="text-lg font-semibold text-gray-200 border-b border-gray-800 pb-2">Browser Configuration Guide</h3>
                      
                      <div className="bg-[#16181D] rounded-lg p-5 border border-gray-800">
                          <h4 className="font-semibold text-gray-300 mb-3 flex items-center gap-2">Firefox</h4>
                          <ol className="list-decimal list-inside text-sm text-gray-400 space-y-2 opacity-90">
                              <li>Go to Settings &gt; General &gt; Network Settings &gt; Settings.</li>
                              <li>Select <strong>Manual proxy configuration</strong>.</li>
                              <li>Enter <code className="bg-gray-800 text-green-400 px-1.5 py-0.5 rounded">{window.location.hostname}</code> for HTTP Proxy and <code className="bg-gray-800 text-[#00E5FF] px-1.5 py-0.5 rounded">{serverConfig.proxyPort}</code> for Port.</li>
                              <li>Check <strong>"Also use this proxy for HTTPS"</strong>.</li>
                              <li>Go to Privacy & Security &gt; Certificates &gt; View Certificates.</li>
                              <li>Click <strong>Import</strong> and select the downloaded Certificate Authority file.</li>
                              <li>Check <strong>"Trust this CA to identify websites."</strong></li>
                          </ol>
                      </div>
                      
                      <div className="bg-[#16181D] rounded-lg p-5 border border-gray-800">
                          <h4 className="font-semibold text-gray-300 mb-3 flex items-center gap-2">Chrome / Edge</h4>
                          <ul className="list-disc list-inside text-sm text-gray-400 space-y-2 opacity-90">
                              <li>Use an extension like <strong>FoxyProxy Standard</strong> or <strong>SwitchyOmega</strong> for ease of use.</li>
                              <li>Create a new proxy profile pointing to <code className="bg-gray-800 text-green-400 px-1.5 py-0.5 rounded">{window.location.hostname}</code> port <code className="bg-gray-800 text-[#00E5FF] px-1.5 py-0.5 rounded">{serverConfig.proxyPort}</code>.</li>
                              <li>To install the certificate, go to chrome://settings/security &gt; Manage Certificates.</li>
                              <li>Under the "Authorities" tab, click <strong>Import</strong> and select the downloaded file.</li>
                              <li>Check <strong>"Trust this certificate for identifying websites."</strong></li>
                          </ul>
                      </div>
                  </div>
              </div>
           ) : viewMode === 'websockets' ? (
              <div className="flex-1 overflow-y-auto p-4 flex flex-col space-y-4 font-mono text-sm hide-scrollbar">
                  <div className="flex items-center justify-between">
                     <span className="text-xs font-bold text-gray-400 uppercase">WebSocket Intercept</span>
                     <div className="flex bg-[#0E1015] border border-gray-700 rounded overflow-hidden">
                         <button 
                            onClick={() => setWsFormat('text')}
                            className={cn("px-3 py-1 text-xs transition-colors", wsFormat === 'text' ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'text-gray-500 hover:text-gray-300')}
                         >Text</button>
                         <button 
                            onClick={() => setWsFormat('binary')}
                            className={cn("px-3 py-1 text-xs transition-colors border-l border-gray-700", wsFormat === 'binary' ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'text-gray-500 hover:text-gray-300')}
                         >Binary (Hex)</button>
                     </div>
                  </div>
                  <div className="flex flex-col gap-2 mt-4">
                     <div className="text-center text-gray-600 italic py-10 border border-gray-800 border-dashed rounded">
                        Currently listening for upgraded Socket connections.<br/>
                        Connect via ws://localhost:3000 to drop frames here.
                     </div>
                  </div>
              </div>
           ) : selectedRequest ? (
            <>
              <div className="h-10 border-b border-gray-800 bg-[#14161C] flex items-center px-4 shrink-0 justify-end gap-2">
                 <button 
                    onClick={() => handleSendToIntruder(selectedRequest)}
                    className="px-2 py-1 bg-indigo-900/40 hover:bg-indigo-900/60 text-indigo-300 rounded text-[10px] font-medium flex items-center gap-1 transition-colors border border-indigo-500/30"
                 >
                     <Target className="w-3 h-3" />
                     Intruder
                 </button>
                 <button 
                    onClick={() => handleSendToRepeater(selectedRequest)}
                    className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded text-[10px] font-medium flex items-center gap-1 transition-colors border border-gray-700"
                 >
                     <Repeat className="w-3 h-3" />
                     Send to Repeater
                 </button>
                 {/* Mock AI Analysis Button */}
                 <button 
                   onClick={() => analyzeRequest(selectedRequest)}
                   disabled={isAnalyzing}
                   className="text-[10px] bg-purple-500/20 text-purple-300 border border-purple-500/30 px-2 py-1 rounded flex items-center gap-1 hover:bg-purple-500/30 transition-colors disabled:opacity-50"
                 >
                   {isAnalyzing ? <Loader2 className="w-3 h-3 animate-spin"/> : <Sparkles className="w-3 h-3" />}
                   AI Analyze
                 </button>
                 {selectedRequest.analysis && (
                     <button 
                       onClick={() => exportReport(selectedRequest)}
                       className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-1 rounded flex items-center gap-1 hover:bg-emerald-500/30 transition-colors"
                     >
                       <FileDown className="w-3 h-3" />
                       Export Report
                     </button>
                 )}
              </div>
              
              <div className="flex-1 flex flex-col min-h-0 divide-y divide-gray-800">
                {(selectedRequest.response as any)?.passiveAnalysis && (
                   <div className="p-4 bg-orange-900/20 border-b border-orange-500/20 shrink-0">
                      <div className="text-[10px] text-orange-400 font-bold uppercase mb-1 flex items-center gap-1">
                         <Shield className="w-3 h-3" /> Passive Vulnerability Scan
                      </div>
                      <div className="text-xs text-orange-200 leading-relaxed font-mono whitespace-pre-wrap">
                         {(selectedRequest.response as any).passiveAnalysis}
                      </div>
                   </div>
                )}
                {selectedRequest.analysis && (
                   <div className="p-4 bg-purple-900/20 border-b border-purple-500/20 shrink-0">
                      <div className="text-[10px] text-purple-400 font-bold uppercase mb-1 flex items-center gap-1">
                         <Sparkles className="w-3 h-3" /> Vulnerability Assessment
                      </div>
                      <div className="text-xs text-purple-200 leading-relaxed font-sans prose prose-invert prose-p:my-1 prose-headings:my-2 prose-sm max-w-none">
                         <ReactMarkdown>{selectedRequest.analysis}</ReactMarkdown>
                      </div>
                   </div>
                )}
                
                <div className="flex-1 flex flex-row min-h-0 min-w-0">
                  <PanelGroup orientation="horizontal" className="flex-1">
                  <Panel defaultSize={50} minSize={20} className="flex flex-col relative border-r border-gray-800">
                  {/* Request View */}
                  <div className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed relative hide-scrollbar">
                  <div className="absolute top-2 right-4 text-[10px] text-gray-600 uppercase border border-gray-700/50 px-1.5 py-0.5 rounded">Request</div>
                  <div className="text-blue-400 font-bold mb-2">
                    {selectedRequest.method} {safeUrl(selectedRequest.url).pathname + safeUrl(selectedRequest.url).search} HTTP/1.1
                  </div>
                  <div className="mb-4">
                    <div className="text-gray-300">Host: <span className="text-gray-500">{safeUrl(selectedRequest.url).host}</span></div>
                     {Object.entries(selectedRequest.headers).map(([k, v]) => (
                        <div key={k} className="text-gray-300">{k}: <span className="text-gray-500">{v}</span></div>
                     ))}
                  </div>
                  {selectedRequest.body && (
                      <PrettyViewer body={selectedRequest.body} />
                  )}
                </div>
                </Panel>
                
                <PanelResizeHandle className="w-1 bg-gray-800 hover:bg-[#00E5FF] cursor-col-resize transition-colors" />

                {/* Response View */}
                <Panel defaultSize={50} minSize={20} className="flex flex-col relative bg-[#0E1015]">
                <div className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed relative hide-scrollbar">
                  <div className="absolute top-2 right-4 text-[10px] text-gray-600 uppercase border border-gray-700/50 px-1.5 py-0.5 rounded">Response</div>
                  {selectedRequest.response ? (
                    <>
                       <div className={cn(
                          "font-bold mb-2",
                          selectedRequest.response.statusCode < 400 ? "text-green-400" : "text-red-400"
                        )}>
                         HTTP/1.1 {selectedRequest.response.statusCode}
                       </div>
                       <div className="mb-4">
                         {Object.entries(selectedRequest.response.headers).map(([k, v]) => (
                            <div key={k} className="text-gray-300">{k}: <span className="text-gray-500">{v}</span></div>
                         ))}
                       </div>
                       <PrettyViewer body={selectedRequest.response.body} isResponse />
                    </>
                  ) : (
                    <div className="h-full flex items-center justify-center text-gray-600 italic">Waiting for response...</div>
                  )}
                </div>
                </Panel>
                </PanelGroup>
                </div>
              </div>
            </>
           ) : (
             <div className="flex-1 flex flex-col items-center justify-center text-gray-600 pattern-isometric pattern-gray-800 pattern-size-4 pattern-opacity-20 relative">
                 <Shield className="w-16 h-16 mb-4 opacity-20" />
                 <p className="text-sm font-medium">Select a request to inspect</p>
                 <p className="text-xs opacity-60 mt-1 max-w-xs text-center">Traffic flows automatically through the memory queue when capture is active.</p>
             </div>
           )}
        </Panel>
        </PanelGroup>
      </main>

      {/* Architecture Info Modal */}
      {showArchInfo && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
           <div className="bg-[#14161C] border border-gray-800 rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden">
              <div className="h-12 border-b border-gray-800 flex items-center justify-between px-4 shrink-0 bg-[#1C1F26]">
                 <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                    <Database className="w-4 h-4 text-indigo-400" /> System Architecture & Constraints
                 </h2>
                 <button onClick={() => setShowArchInfo(false)} className="text-gray-500 hover:text-gray-300">
                    <X className="w-5 h-5" />
                 </button>
              </div>
              <div className="p-6 overflow-y-auto space-y-6 text-sm text-gray-300 leading-relaxed font-sans">
                  <p className="bg-blue-500/10 text-blue-300 p-3 rounded text-xs border border-blue-500/20">
                     <strong>System Note:</strong> This application is a high-performance diagnostic proxy suite built on Node.js. It features a custom mitm-proxy engine capable of intercepting and modifying encrypted traffic in real-time.
                  </p>
                  
                  <div>
                    <h3 className="text-indigo-400 font-semibold mb-2">1. The Performance Engine</h3>
                    <p>Designed for speed, the engine utilizes a threaded memory queue and asynchronous I/O to handle thousands of requests per second. The UI rendering is isolated via a dedicated WebSocket bus to prevent interface lag during high-volume traffic analysis.</p>
                  </div>

                  <div>
                    <h3 className="text-indigo-400 font-semibold mb-2">2. Smart Interception Logic</h3>
                    <p>Unlike basic proxies, this suite integrates advanced automated analysis. Captured transactions are evaluated for common vulnerabilities and logic flaws. The modular design allows for custom JS middleware to modify traffic programmatically before it reaches the review queue.</p>
                  </div>

                  <div>
                    <h3 className="text-indigo-400 font-semibold mb-2">3. Protocol Support</h3>
                    <p>Full support for HTTP/1.1 and WebSockets is included, with internal bridges for handling bi-directional binary frames. The system generates its own Root Certificate Authority to enable transparent inspection of HTTPS traffic.</p>
                  </div>
              </div>
           </div>
        </div>
      )}
    </div>
  );
}
