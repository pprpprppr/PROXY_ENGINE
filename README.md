# ProxySuite (`PROXY_ENGINE` v2.0)

A high-performance, security-hardened HTTP/HTTPS diagnostic proxy and authorized security testing platform built with Node.js, TypeScript, SQLite (WAL), React, and Electron.

## Key Capabilities

- **Streaming MITM HTTP/HTTPS Proxy (`127.0.0.1:8082`)**:
  - Bounded request/response body capture (`MAX_REQ_BODY_CAPTURE_BYTES`, `MAX_RES_BODY_CAPTURE_BYTES`) with truncation markers—large downloads and binary streams pass through without unbounded memory growth.
  - Strict upstream TLS verification enabled by default (`TLSv1.2+`, SNI support, optional explicit diagnostic override for self-signed targets).
  - Transparent decompression (`gzip`, `deflate`, `br`) for inspection while preserving original wire compression.
  - Live Request & Response Intercept with editable method, URL, headers, body, and conditional Breakpoint rules.
  - ReDoS-validated Match & Replace rules.
- **Persistent Worker-Isolated SQLite Database (`proxysuite.db`)**:
  - Runs `node:sqlite` in a dedicated `worker_threads` worker in WAL mode with prepared statements and batched transactions.
  - Preserves all traffic across restarts and automatically migrates legacy `proxy-traffic.json` records.
  - Automatic pre-migration backups, integrity verification/recovery, JSON & HAR 1.2 export/import (with secret redaction), and user-controlled retention or clearing.
- **Traffic Inspector, Repeater, Controlled Intruder & WebSocket Inspector**:
  - Server-side paginated filtering, body search, timing breakdown (`TTFB` + total duration), tagging, bookmarking, collections, duplicate detection, and response diffing.
  - Multi-tab Repeater with query param sync, auth helper, collections, history, response comparison, and cURL export.
  - Scope-enforced Controlled Intruder with bounded concurrency, pause/resume/stop controls, baseline comparison, and anomaly detection.
  - Real-time proxied WebSocket connection & frame inspector (text & hex binary).
- **Backend-Only Gemini AI Defensive Analysis**:
  - Configurable `GEMINI_MODEL` (default `gemini-2.5-flash`), secret/header/JWT redaction, timeouts, retries, and structured vulnerability findings.
- **System Health & Observability**:
  - RSS/Heap memory telemetry, event-loop lag (`p95`/`mean`/`max`), active connections, SQLite queue depth, and structured redacted logs.

## Quick Start

### Prerequisites

- **Node.js v22.12+ / v24+ / v26+** (requires built-in `node:sqlite`)
- **npm 10+**

### 1. Install Dependencies

```bash
npm ci
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Optionally add `GEMINI_API_KEY` and `GEMINI_MODEL` in `.env` for AI analysis.

### 3. Run in Development

```bash
npm run dev
```

- **Web UI & Local API**: `http://127.0.0.1:3000`
- **HTTP/HTTPS MITM Proxy**: `127.0.0.1:8082`

### 4. Production Build & Start

```bash
npm run build
npm run start:prod
```

### 5. Electron Desktop App

```bash
# Development mode
npm run electron:dev

# Package desktop app
npm run electron:build
```

> Note: When using npm 11+ with strict script policies, ensure Electron's install script is permitted if running Electron locally.

### 6. Automated Tests

```bash
npm test
```

## Security & Authorized Use

- Local API, WebSocket bus, and MITM proxy bind to `127.0.0.1` by default, protected by Host/Origin checks and a per-session runtime token.
- Active testing tools (Repeater, Intruder, Simulator) enforce Target Scope and SSRF/private-network protection by default. Configure authorized hosts (or enable Localhost for local test targets) in **Settings & Health → Authorized Target Scope**.
- Only intercept or test systems you own or have explicit authorization to test. Keep your generated MITM Root CA private key protected.
