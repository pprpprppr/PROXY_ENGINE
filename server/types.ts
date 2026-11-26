export type PacketStatus =
  | 'pending'
  | 'completed'
  | 'error'
  | 'intercepted'
  | 'dropped'
  | 'response_intercepted';

export interface TimingBreakdown {
  startedAt: number;
  headersAt?: number;
  completedAt?: number;
  ttfbMs?: number;
  totalMs?: number;
}

export interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  bodySize: number;
  bodyTruncated: boolean;
  isBinary: boolean;
  timestamp: number;
  duration?: number;
  passiveAnalysis?: string | null;
}

export interface CapturedPacket {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  bodySize: number;
  bodyTruncated: boolean;
  isBinary: boolean;
  status: PacketStatus;
  response?: CapturedResponse;
  analysis?: string;
  structuredAnalysis?: AiSecurityAnalysis | null;
  tags: string[];
  bookmarked: boolean;
  collectionId?: string | null;
  timing?: TimingBreakdown;
}

export interface PacketSummary {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  host: string;
  path: string;
  status: PacketStatus;
  statusCode?: number;
  duration?: number;
  reqBodySize: number;
  reqBodyTruncated: boolean;
  resBodySize: number;
  resBodyTruncated: boolean;
  isBinary: boolean;
  contentType?: string;
  hasPassiveFindings: boolean;
  hasAiAnalysis: boolean;
  tags: string[];
  bookmarked: boolean;
  collectionId?: string | null;
  duplicateGroup?: string;
}

export interface ReplaceRule {
  id: string;
  name?: string;
  match: string;
  replace: string;
  type: 'header' | 'body' | 'url';
  phase?: 'request' | 'response' | 'both';
  isRegex?: boolean;
  active: boolean;
}

export interface BreakpointRule {
  id: string;
  name: string;
  enabled: boolean;
  phase: 'request' | 'response' | 'both';
  hostPattern?: string;
  pathPattern?: string;
  methods?: string[];
}

export interface TargetScopeConfig {
  enforceScope: boolean;
  allowLocalhost: boolean;
  allowPrivateNetworks: boolean;
  allowedHosts: string[];
  excludedHosts: string[];
  maxRepeaterRedirects: number;
}

export interface RetentionPolicy {
  enabled: boolean;
  maxRecords: number;
  maxAgeHours: number;
}

export interface RuntimeProxySettings {
  allowInsecureTls: boolean;
  maxReqBodyCaptureBytes: number;
  maxResBodyCaptureBytes: number;
  maxInterceptBodyBytes: number;
  maxActiveRequests: number;
  maxPendingIntercepts: number;
  interceptTimeoutMs: number;
  upstreamTimeoutMs: number;
  retention: RetentionPolicy;
  targetScope: TargetScopeConfig;
}

export interface WebSocketConnectionRecord {
  id: string;
  url: string;
  host: string;
  isSSL: boolean;
  startedAt: number;
  closedAt?: number;
  closeCode?: number;
  status: 'open' | 'closed' | 'error';
  frameCount: number;
  bytesIn: number;
  bytesOut: number;
}

export interface WebSocketFrameRecord {
  id: string;
  connectionId: string;
  timestamp: number;
  direction: 'client_to_server' | 'server_to_client';
  frameType: 'message' | 'ping' | 'pong';
  isBinary: boolean;
  size: number;
  truncated: boolean;
  payload: string;
  url: string;
}

export interface RequestCollection {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
}

export interface SavedRequestItem {
  id: string;
  collectionId: string;
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  createdAt: number;
}

export interface AiFinding {
  title: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low' | 'Info';
  confidence: 'High' | 'Medium' | 'Low';
  affectedRequest: string;
  evidence: string;
  technicalExplanation: string;
  potentialImpact: string;
  recommendedRemediation: string;
}

export interface AiSecurityAnalysis {
  model: string;
  analyzedAt: number;
  summary: string;
  findings: AiFinding[];
  markdown: string;
}

export interface IntruderJobConfig {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  payloads: string[];
  concurrency: number;
  delayMs: number;
  jitterMs: number;
  maxPayloads: number;
  maxDurationMs: number;
  requestTimeoutMs: number;
  rotateUserAgent: boolean;
}

export interface IntruderResultItem {
  reqId: string;
  index: number;
  payload: string;
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  bodyTruncated: boolean;
  length: number;
  duration: number;
  error: string | null;
  isAnomaly: boolean;
  anomalyReasons: string[];
}

export interface SystemHealthSnapshot {
  timestamp: number;
  uptimeSeconds: number;
  proxyStatus: 'UP' | 'DOWN';
  proxyHost: string;
  proxyPort: number;
  uiHost: string;
  uiPort: number;
  allowInsecureTls: boolean;
  memory: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  eventLoopLagMs: {
    mean: number;
    p95: number;
    max: number;
  };
  connections: {
    activeProxyRequests: number;
    pendingRequestIntercepts: number;
    pendingResponseIntercepts: number;
    wsUiClients: number;
    activeMitmWsConnections: number;
  };
  database: {
    path: string;
    totalPackets: number;
    queueDepth: number;
    droppedWrites: number;
    integrityOk: boolean;
    totalBytesCaptured: number;
  };
  trafficStats: {
    totalCaptured: number;
    totalTruncated: number;
    totalErrors: number;
    inMemoryBytesEstimate: number;
  };
}

export interface HistoryQuery {
  limit?: number;
  offset?: number;
  search?: string;
  bodySearch?: string;
  method?: string;
  host?: string;
  statusGroup?: string;
  contentType?: string;
  bookmarkedOnly?: boolean;
  tag?: string;
  collectionId?: string;
  sortBy?: 'timestamp' | 'duration' | 'statusCode' | 'size';
  sortDir?: 'asc' | 'desc';
}
