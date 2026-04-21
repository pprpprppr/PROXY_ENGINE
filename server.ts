import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

// MANDATORY EPHEMERAL PURGE: Before any initialization to ensure cleanroom state
const DB_FILE = 'proxy-traffic.json';
const purgeSession = () => {
  if (fs.existsSync(DB_FILE)) {
    try {
      fs.unlinkSync(DB_FILE);
      console.log('EPHEMERAL PURGE: Cleared session database safely.');
    } catch (e) {}
  }
};
purgeSession();

import express from "express";
import { createServer as createViteServer } from "vite";
import http from "http";
import path from "path";
import { constants } from "node:crypto";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import httpProxy from "http-proxy";
import * as url from "url";
import { JsonDB } from './database.js';
import { PassThrough } from "stream";
import { Proxy as MitmProxy } from 'http-mitm-proxy';
import { GoogleGenAI } from "@google/genai";

// This file configures the proxy backend as well as serving the web UI.

// Initialize Gemini for Server-Side Analysis
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

// Graceful Shutdown Portability & Cleanup
const shutdownClean = () => {
    console.log('\nSIGNAL RECEIVED: Executing Performance Architect Shutdown...');
    purgeSession();
    process.exit(0);
};

process.on('SIGINT', shutdownClean);
process.on('SIGTERM', shutdownClean);
process.on('exit', () => {
    // Final sync check
    if (fs.existsSync(DB_FILE)) {
        try { fs.unlinkSync(DB_FILE); } catch(e) {}
    }
});

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const PROXY_PORT = process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT) : 8082;

// Global DB instance
let db: JsonDB;

async function initDB() {
  db = new JsonDB('proxy-traffic.json');
  console.log("JSON Database initialized.");
}

// Background "worker" function to save packets without blocking
function savePacketAsync(packetData: any) {
  setImmediate(async () => {
    try {
      await db.run(
        `INSERT INTO intercepted_packets (id, timestamp, method, url, req_headers, req_body, res_headers, res_body, status_code, duration_ms, passive_analysis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET 
            res_headers=excluded.res_headers,
            res_body=excluded.res_body,
            status_code=excluded.status_code,
            duration_ms=excluded.duration_ms,
            passive_analysis=excluded.passive_analysis`,
        [
          packetData.id,
          packetData.timestamp,
          packetData.method,
          packetData.url,
          JSON.stringify(packetData.req_headers || {}),
          packetData.req_body || "",
          packetData.res_headers ? JSON.stringify(packetData.res_headers) : null,
          packetData.res_body || null,
          packetData.status_code || null,
          packetData.duration || null,
          packetData.passive_analysis || null
        ]
      );
    } catch (e) {
      console.error("DB Save Error:", e);
    }
  });
}

function runPassiveScan(headers: any, body: string): string | null {
   const findings: string[] = [];
   const cors = headers['access-control-allow-origin'];
   if (cors === '*') findings.push("[CORS] Wildcard Access-Control-Allow-Origin.");
   
   if (!headers['x-frame-options'] && !headers['content-security-policy']) {
       findings.push("[Security Headers] Missing X-Frame-Options and Content-Security-Policy.");
   }
   
   const piiPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
   if (body && body.match(piiPattern)) {
       findings.push("[PII Leakage] Potential Email addresses found in response.");
   }

   if (body && (body.includes('AKIA') || body.includes('AIza'))) {
       findings.push("[Token Leakage] Potential API Keys found in response.");
   }

   if (findings.length === 0) return null;
   return findings.join('\n');
}

// Match & Replace State
interface ReplaceRule {
  id: string;
  match: string;
  replace: string;
  type: 'header' | 'body' | 'url';
  active: boolean;
}
let replacementRules: ReplaceRule[] = [];

// Administrative Approval Gate State with Memory Reap (TTL)
let gateEnabled = false;
let responseGateEnabled = false;

interface PendingGate {
    resolve: (val: any) => void;
    timestamp: number;
}
const trafficGate = new Map<string, PendingGate>();
const responseReviewQueue = new Map<string, PendingGate>();

function normalizeUrl(targetUrl: string): string {
    if (!targetUrl) return targetUrl;
    try {
        if (!targetUrl.startsWith('http')) {
            if (targetUrl.includes('.') && !targetUrl.includes('://')) {
                return 'https://' + targetUrl;
            }
        }
        return new URL(targetUrl).toString();
    } catch {
        return targetUrl;
    }
}

/** STALE REQUEST REAPER: Prevent memory exhaustion from abandoned reviews */
setInterval(() => {
    const now = Date.now();
    const TTL = 5 * 60 * 1000; // 5 Minute TTL

    [trafficGate, responseReviewQueue].forEach(queue => {
        for (const [id, entry] of queue.entries()) {
            if (now - entry.timestamp > TTL) {
                console.warn(`REAPER: Dropping stale request context [${id}] after 5min timeout.`);
                entry.resolve({ action: 'drop' });
                queue.delete(id);
            }
        }
    });
}, 30000); // Pulse every 30s

const mitmProxy = new MitmProxy();

async function startServer() {
  await initDB();

  const app = express();
  const server = http.createServer(app);
  
  // WebSocket server for the UI to receive intercepted traffic
  const wss = new WebSocketServer({ server, path: '/api/ws' });

  // Store active UI client connections
  const uiClients: any[] = [];

  wss.on('connection', (ws) => {
    uiClients.push(ws);
    console.log("UI Performance Link Established [WS]");
    
    const pingInterval = setInterval(() => {
        if (ws.readyState === 1) ws.ping();
    }, 25000);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'ACTION_FORWARD') {
          const { id, modifiedUrl, modifiedHeaders, modifiedBody, interceptResponse } = message.payload;
          
          if (responseReviewQueue.has(id)) {
              const entry = responseReviewQueue.get(id);
              if (entry) {
                  entry.resolve({ action: 'forward', modifiedBody });
                  responseReviewQueue.delete(id);
              }
          } else if (trafficGate.has(id)) {
              const entry = trafficGate.get(id);
              if (entry) {
                entry.resolve({ action: 'forward', modifiedUrl, modifiedHeaders, modifiedBody, interceptResponse });
                trafficGate.delete(id);
              }
          }
        } else if (message.type === 'ACTION_DROP') {
          const { id } = message.payload;
          if (responseReviewQueue.has(id)) {
              const entry = responseReviewQueue.get(id);
              if (entry) {
                  entry.resolve({ action: 'drop' });
                  responseReviewQueue.delete(id);
              }
          } else if (trafficGate.has(id)) {
              const entry = trafficGate.get(id);
              if (entry) {
                entry.resolve({ action: 'drop' });
                trafficGate.delete(id);
              }
          }
        } else if (message.type === 'TOGGLE_INTERCEPT') {
          gateEnabled = message.payload.enabled;
          broadcastToUI('interceptStatus', { enabled: gateEnabled, responseEnabled: responseGateEnabled });
        } else if (message.type === 'TOGGLE_RESPONSE_INTERCEPT') {
          responseGateEnabled = message.payload.enabled;
          broadcastToUI('interceptStatus', { enabled: gateEnabled, responseEnabled: responseGateEnabled });
        }
      } catch (e) {
        console.error("WS Message Error", e);
      }
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      const idx = uiClients.indexOf(ws);
      if (idx > -1) uiClients.splice(idx, 1);
      console.log("UI Performance Link Severed [WS]");
    });
  });

  const broadcastToUI = (messageType: string, payload: any) => {
    let uiPayload = payload;
    if (messageType === 'requestCaptured' || messageType === 'PENDING_REVIEW') {
        uiPayload = {
            ...payload,
            headers: payload.req_headers || payload.headers,
            body: payload.req_body || payload.body
        };
    }
    const message = JSON.stringify({ type: messageType, payload: uiPayload });
    uiClients.forEach(client => {
      if (client.readyState === 1) { // OPEN
        client.send(message);
      }
    });
  };

  // Setup HTTPS Diagnostic Middleware (MITM Proxy)
  const certPath = path.join(process.cwd(), '.http-mitm-proxy');
  if (!fs.existsSync(certPath)) fs.mkdirSync(certPath, { recursive: true });

  mitmProxy.use(MitmProxy.gunzip);

  mitmProxy.onRequest(async (ctx, callback) => {
    const requestId = uuidv4();
    (ctx as any).requestId = requestId;
    const isHttps = ctx.isSSL;
    const method = ctx.clientToProxyRequest.method;
    let url = ctx.clientToProxyRequest.url;
    
    // Ensure SNI (Server Name Indication) for HTTPS requests to prevent EPROTO errors
    if (isHttps) {
        const hostHeader = ctx.clientToProxyRequest.headers.host;
        if (hostHeader) {
            const hostname = hostHeader.split(':')[0];
            // Only set servername if it's not an IP address (IPs don't support SNI name indication)
            const isIP = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname);
            if (!isIP) {
                (ctx.proxyToServerRequestOptions as any).servername = hostname;
            }
        }
        
        // Advanced SSL/TLS Hardening
        (ctx.proxyToServerRequestOptions as any).rejectUnauthorized = false;
        (ctx.proxyToServerRequestOptions as any).agent = false; // Disable global agent to fix EPROTO on hostname switch
        (ctx.proxyToServerRequestOptions as any).secureOptions = constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_TLSv1;
    }
    
    if (!url.startsWith('http')) {
        url = (isHttps ? 'https://' : 'http://') + ctx.clientToProxyRequest.headers.host + url;
    }
    
    let bodyChunks: Buffer[] = [];
    ctx.onRequestData((ctx, chunk, callback) => {
       bodyChunks.push(chunk);
       return callback(null, null); // Hold data
    });

    ctx.onRequestEnd(async (ctx, callback) => {
        let fullBody = Buffer.concat(bodyChunks);
        let reqStr = fullBody.toString('utf8');

        // Apply Match & Replace Rules
        replacementRules.filter(r => r.active).forEach(rule => {
            if (rule.type === 'url' && url.includes(rule.match)) {
                url = url.replace(new RegExp(rule.match, 'g'), rule.replace);
                ctx.clientToProxyRequest.url = url; 
            }
            if (rule.type === 'body') {
                reqStr = reqStr.replace(new RegExp(rule.match, 'g'), rule.replace);
                fullBody = Buffer.from(reqStr, 'utf8');
            }
            if (rule.type === 'header') {
                Object.keys(ctx.clientToProxyRequest.headers).forEach(h => {
                    const val = ctx.clientToProxyRequest.headers[h];
                    if (typeof val === 'string' && val.includes(rule.match)) {
                        ctx.clientToProxyRequest.headers[h] = val.replace(new RegExp(rule.match, 'g'), rule.replace);
                    }
                });
            }
        });
        
        const packet: any = {
            id: requestId,
            method,
            url,
            req_headers: { ...ctx.clientToProxyRequest.headers },
            req_body: reqStr,
            timestamp: Date.now(),
            status: 'pending'
        };

        let finalBody = fullBody;

        if (gateEnabled) {
            packet.status = 'intercepted';
            broadcastToUI('PENDING_REVIEW', packet);

            const decision: any = await new Promise((resolve) => {
                trafficGate.set(requestId, { resolve, timestamp: Date.now() });
            });

            if (decision.action === 'drop') {
                ctx.proxyToClientResponse.writeHead(504, { 'Content-Type': 'text/plain' });
                ctx.proxyToClientResponse.end('Gateway Timeout: Aborted by Stateful Request Review System');
                packet.status = 'dropped';
                savePacketAsync(packet);
                return; 
            }

            if (decision.modifiedUrl) {
                ctx.clientToProxyRequest.url = decision.modifiedUrl;
            }
            if (decision.modifiedHeaders) {
                ctx.proxyToServerRequestOptions.headers = decision.modifiedHeaders;
                packet.req_headers = decision.modifiedHeaders;
            }
            if (decision.modifiedBody !== undefined) {
                finalBody = Buffer.from(decision.modifiedBody, 'utf8');
                packet.req_body = decision.modifiedBody;
                
                // Protocol Integrity: Recalculate Content-Length
                if (ctx.proxyToServerRequestOptions.headers['content-length'] || finalBody.length > 0) {
                    ctx.proxyToServerRequestOptions.headers['content-length'] = finalBody.length.toString();
                    packet.req_headers['content-length'] = finalBody.length.toString();
                }
            }
            if (decision.interceptResponse) {
                (ctx as any).interceptResponse = true;
            }
        }

        savePacketAsync(packet);
        broadcastToUI('requestCaptured', packet);

        ctx.proxyToServerRequest.write(finalBody);
        return callback();
    });

    return callback();
  });

  mitmProxy.onResponse(async (ctx, callback) => {
    const requestId = (ctx as any).requestId;
    let resBodyChunks: Buffer[] = [];
    
    ctx.onResponseData((ctx, chunk, callback) => {
        resBodyChunks.push(chunk);
        return callback(null, null); // Internal buffering
    });

    ctx.onResponseEnd(async (ctx, callback) => {
        let fullResBody = Buffer.concat(resBodyChunks);
        let resStr = fullResBody.toString('utf8');
        
        const shouldInterceptResponse = (ctx as any).interceptResponse || responseGateEnabled;
        
        if (shouldInterceptResponse) {
             const decision: any = await new Promise((resolve) => {
                 responseReviewQueue.set(requestId, { resolve, timestamp: Date.now() });
                 broadcastToUI('RESPONSE_PENDING', {
                     id: requestId,
                     statusCode: ctx.serverToProxyResponse.statusCode,
                     headers: ctx.serverToProxyResponse.headers,
                     body: resStr,
                     url: (ctx.isSSL ? 'https://' : 'http://') + ctx.clientToProxyRequest.headers.host + ctx.clientToProxyRequest.url,
                     status: 'response_intercepted'
                 });
             });

             if (decision.action === 'drop') {
                 ctx.proxyToClientResponse.destroy();
                 return callback();
             }
             if (decision.modifiedBody !== undefined) {
                 fullResBody = Buffer.from(decision.modifiedBody, 'utf8');
                 resStr = fullResBody.toString('utf8');
             }
        }
        
        const responsePacket = {
            id: requestId,
            statusCode: ctx.serverToProxyResponse.statusCode,
            headers: ctx.serverToProxyResponse.headers,
            body: resStr,
            timestamp: Date.now(),
            duration: 0, 
        };
        
        savePacketAsync({
            id: requestId,
            res_headers: ctx.serverToProxyResponse.headers,
            res_body: resStr,
            status_code: ctx.serverToProxyResponse.statusCode
        });
        
        broadcastToUI('responseCaptured', responsePacket);
        ctx.proxyToClientResponse.write(fullResBody);
        return callback();
    });
    return callback();
  });

  mitmProxy.onError((ctx, err) => {
    const errorMsg = err.message || 'Unknown error';
    const isSSL = ctx?.isSSL;
    const host = ctx?.clientToProxyRequest?.headers?.host || 'unknown';
    
    console.error(`MITM Proxy Error [${host}]:`, errorMsg);
    
    let advice = '';
    if (errorMsg.includes('EPROTO')) {
        advice = "SSL Protocol Error. This usually means the target server rejected the SSL handshake. Common fixes: Ensure you've trusted the CA certificate, or the server might require a specific TLS version.";
    } else if (errorMsg.includes('ECONNREFUSED')) {
        advice = "Connection Refused. The target server is not reachable.";
    } else if (errorMsg.includes('CERT_')) {
        advice = "Certificate Error. The upstream server has an invalid certificate.";
    }

    broadcastToUI('proxyError', { 
        message: errorMsg,
        host,
        isSSL,
        advice
    });
  });

  let proxyRunning = false;
  mitmProxy.listen({ 
    port: PROXY_PORT, 
    host: '0.0.0.0', 
    sslCaDir: certPath,
    keepAlive: true,
    timeout: 30000 
  }, (err) => {
    if (err) {
        proxyRunning = false;
        if ((err as any).code === 'EADDRINUSE') {
            console.error(`CRITICAL: Proxy Port ${PROXY_PORT} is already in use by another process.`);
        } else {
            console.error("MITM Listen Error", err);
        }
    } else {
        proxyRunning = true;
        console.log(`HTTPS Diagnostic MITM Gateway running on port ${PROXY_PORT}`);
    }
  });

  app.get("/api/config", (req, res) => {
      res.json({
          port: PORT,
          proxyPort: PROXY_PORT,
          proxyStatus: proxyRunning ? 'UP' : 'DOWN'
      });
  });

  app.get("/api/ca-cert", (req, res) => {
    const caCertPath = path.join(certPath, 'certs', 'ca.pem');
    if (fs.existsSync(caCertPath)) {
        res.setHeader('Content-Type', 'application/x-x509-ca-cert');
        res.setHeader('Content-Disposition', 'attachment; filename=DiagnosticRootCA.pem');
        fs.createReadStream(caCertPath).pipe(res);
    } else {
        res.status(404).send("CA certificate not yet generated. Please wait and try again.");
    }
  });

  app.get("/api/rules", (req, res) => res.json(replacementRules));
  app.post("/api/rules", express.json(), (req, res) => {
      replacementRules = req.body;
      res.json({ success: true });
  });

  app.post("/api/intercept/action", express.json(), (req, res) => {
    const { id, action, modifiedUrl, modifiedHeaders, modifiedBody, interceptResponse } = req.body;
    if (responseReviewQueue.has(id)) {
        const entry = responseReviewQueue.get(id);
        if (entry) entry.resolve({ action, modifiedBody });
        responseReviewQueue.delete(id);
        res.json({ success: true });
    } else if (trafficGate.has(id)) {
        const entry = trafficGate.get(id);
        if (entry) {
            entry.resolve({ action, modifiedUrl, modifiedHeaders, modifiedBody, interceptResponse });
            trafficGate.delete(id);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: "Proxy Intercept entry not found or already released" });
        }
    } else {
        res.status(404).json({ error: "Proxy Intercept entry not found or already released" });
    }
  });

  // Intruder Fuzzing Engine
  app.post("/api/intruder/run", express.json(), async (req, res) => {
     let { method, url: rawUrl, headers, body, payloads, jitterMs, rotateUserAgent } = req.body;
     const url = normalizeUrl(rawUrl);
     const jobId = uuidv4();
     res.json({ jobId, message: "Fuzz job started" });
     
     const userAgents = [
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
         "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
         "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/121.0",
         "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/110.0"
     ];

     setImmediate(async () => {
         let baselineStatus = -1;
         let baselineLength = -1;

         for (let i = 0; i < payloads.length; i += 10) {
             const batchPayloads = payloads.slice(i, i + 10);
             const batch = batchPayloads.map(async (payload: string) => {
                 const reqId = uuidv4();
                 const payloadUrl = url.replace(/\{FUZZ\}/g, payload);
                 let payloadBody = body;
                 if (body) {
                     payloadBody = typeof body === 'string' ? body.replace(/\{FUZZ\}/g, payload) : JSON.stringify(body).replace(/\{FUZZ\}/g, payload);
                 }
                 
                 let payloadHeaders: any = {};
                 if (headers) {
                     for (const [k, v] of Object.entries(headers)) {
                         const lowerKey = k.toLowerCase();
                         if (lowerKey === 'host' || lowerKey === 'content-length' || lowerKey === 'connection' || lowerKey === 'accept-encoding') {
                             continue;
                         }
                         payloadHeaders[k] = String(v).replace(/\{FUZZ\}/g, payload);
                     }
                 }
                 
                 if (rotateUserAgent) {
                     payloadHeaders['user-agent'] = userAgents[Math.floor(Math.random() * userAgents.length)];
                 }

                 if (jitterMs && jitterMs > 0) {
                     const jitterVal = Math.max(0, jitterMs + (Math.random() * 100 - 50)); // +/- 50ms random scatter
                     await new Promise(r => setTimeout(r, jitterVal));
                 }

                 const fetchOpts: RequestInit = { method, headers: payloadHeaders };
                 if (payloadBody && method !== 'GET' && method !== 'HEAD') {
                     fetchOpts.body = payloadBody;
                 }
                 
                 const startTime = Date.now();
                 try {
                     const response = await fetch(payloadUrl, fetchOpts);
                     const resBody = await response.text();
                     const duration = Date.now() - startTime;
                     
                     return {
                         reqId, payload,
                         statusCode: response.status,
                         headers: Object.fromEntries(response.headers.entries()),
                         body: resBody,
                         length: resBody.length,
                         duration,
                         error: null
                     };
                 } catch (e: any) {
                     return {
                         reqId, payload,
                         statusCode: 0,
                         length: 0,
                         duration: Date.now() - startTime,
                         error: e.message
                     };
                 }
             });
             
             const batchResults = await Promise.allSettled(batch);
             const processedResults = batchResults.map((r: any) => r.status === 'fulfilled' ? r.value : { error: r.reason });
             
             // Baseline from first payload
             if (i === 0 && processedResults.length > 0 && !processedResults[0].error) {
                 baselineStatus = processedResults[0].statusCode;
                 baselineLength = processedResults[0].length;
             }
             
             broadcastToUI('fuzzProgress', { 
                 jobId, 
                 current: Math.min(i + 10, payloads.length), 
                 total: payloads.length,
                 results: processedResults.map(r => ({ 
                     ...r, 
                     isAnomaly: (!r.error && (r.statusCode !== baselineStatus || Math.abs(r.length - baselineLength) > 10)) 
                 }))
             });
         }
         
         broadcastToUI('fuzzComplete', { jobId });
     });
  });

  app.get("/api/session/export", (req, res) => {
      // Export current database to a downloadable file
      if (fs.existsSync(DB_FILE)) {
          const dateStr = new Date().toISOString().split('T')[0];
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Disposition', `attachment; filename=audit_session_${dateStr}.json`);
          fs.createReadStream(DB_FILE).pipe(res);
      } else {
          // If DB file doesn't exist yet (no traffic), send empty array
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Disposition', `attachment; filename=audit_session_empty.json`);
          res.send(JSON.stringify([], null, 2));
      }
  });

  app.post("/api/session/import", express.json({ limit: '50mb' }), async (req, res) => {
      try {
          const sessionData = req.body;
          if (!Array.isArray(sessionData)) {
              return res.status(400).json({ error: "Invalid session format. Expected an array of captured packets." });
          }

          // HARDENED VALIDATION: Basic schema check for data integrity
          const isValid = sessionData.every(p => p && typeof p.id === 'string' && typeof p.url === 'string');
          if (!isValid && sessionData.length > 0) {
              return res.status(400).json({ error: "Secure Audit Validation Failed: Incompatible session schema." });
          }

          // Overwrite the persistent store
          fs.writeFileSync(DB_FILE, JSON.stringify(sessionData, null, 2));
          
          // Re-instantiate database to point to the imported data
          await initDB();
          
          // Notify all UI clients to refresh their display
          broadcastToUI('SESSION_RELOADED', { message: 'Cloud Session Restored' });
          
          res.json({ success: true, count: sessionData.length });
      } catch (e: any) {
          console.error("Session Import Error:", e);
          res.status(500).json({ error: e.message || "Unknown error during import" });
      }
  });

  app.get("/api/history", async (req, res) => {
     try {
       const limit = parseInt((req.query.limit as string) || "100");
       const offset = parseInt((req.query.offset as string) || "0");
       const packets = await db.all(`SELECT * FROM intercepted_packets ORDER BY timestamp DESC LIMIT ? OFFSET ?`, [limit, offset]);
       
       // Format to match UI expectations
       const formatted = packets.map((p: any) => ({
         id: p.id,
         method: p.method,
         url: p.url,
         headers: typeof p.req_headers === 'string' ? JSON.parse(p.req_headers) : (p.req_headers || {}),
         body: p.req_body,
         timestamp: p.timestamp,
         status: p.status_code ? 'completed' : 'pending',
         response: p.status_code ? {
            statusCode: p.status_code,
            headers: typeof p.res_headers === 'string' ? JSON.parse(p.res_headers) : (p.res_headers || {}),
            body: p.res_body,
            timestamp: p.timestamp + (p.duration_ms || 0),
            duration: p.duration_ms,
            passiveAnalysis: p.passive_analysis
         } : undefined
       }));
       res.json(formatted);
     } catch (e: any) {
       res.status(500).json({ error: e.message });
     }
  });

  // Repeater Endpoint (Replaces Tauri command)
  app.post("/api/repeater", express.json(), async (req, res) => {
     try {
        let { method, url: rawUrl, headers, body } = req.body;
        const url = normalizeUrl(rawUrl);
        
        const startTime = Date.now();
        const fetchOpts: RequestInit = { method };
        if (body && (method !== 'GET' && method !== 'HEAD')) {
           fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        
        // Strip out forbidden fetch headers that browser/node will complain about
        const cleanHeaders: Record<string, string> = {};
        if (headers) {
            for (const [key, val] of Object.entries(headers)) {
                const lowerKey = key.toLowerCase();
                if (lowerKey === 'host' || lowerKey === 'content-length' || lowerKey === 'connection' || lowerKey === 'accept-encoding') {
                    continue;
                }
                cleanHeaders[key] = val as string;
            }
        }
        fetchOpts.headers = cleanHeaders;

        const response = await fetch(url, fetchOpts);
        const resBody = await response.text();
        const duration_ms = Date.now() - startTime;

        const result = {
           status_code: response.status,
           headers: Object.fromEntries(response.headers.entries()),
           body: resBody,
           duration_ms
        };

        // Also log this new repeated request to DB & emit
        const reqId = uuidv4();
        const packet = {
           id: reqId,
           method,
           url,
           req_headers: cleanHeaders,
           req_body: fetchOpts.body,
           timestamp: Date.now(),
           status_code: response.status,
           res_headers: result.headers,
           res_body: resBody,
           duration: duration_ms
        };
        savePacketAsync(packet);
        broadcastToUI('requestCaptured', { ...packet, headers: cleanHeaders, body: fetchOpts.body });
        broadcastToUI('responseCaptured', { id: reqId, statusCode: response.status, headers: result.headers, body: resBody, duration: duration_ms });

        res.json(result);
     } catch (e: any) {
        res.status(500).json({ error: e.message });
     }
  });

  // Provide a simulator endpoint since users can't easily configure 
  // their external browser to use port 8080 of a containerized app.
  app.post("/api/simulate-request", express.json(), async (req, res) => {
    try {
      const { targetUrl, method = 'GET', body } = req.body;
      let reqId = uuidv4();
      
      const fetchOpts: RequestInit = { method };
      if (body && (method === 'POST' || method === 'PUT')) {
        fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
        fetchOpts.headers = { 'Content-Type': 'application/json' };
      }

      // To make simulate request interceptable, we manually pipe it through our proxy listener on PROXY_PORT
      // by setting the absolute proxy url. But node native fetch doesn't support proxying cleanly out of the box...
      // Instead of native fetch with an Agent, we can just hit our intercept pipeline directly for demonstration,
      // but the easiest is simply routing the fetch directly since our intercept logic is bound to the proxy server stream.
      // We will just do a standard proxy tunnel using standard http!
      
      const parsedUrl = new URL(targetUrl);
      const reqOpts = {
          hostname: '127.0.0.1',
          port: 8082,
          path: targetUrl, // Absolute URL for proxying
          method: method,
          headers: {
              ...(fetchOpts.headers as Record<string, string>),
              'Host': parsedUrl.host
          }
      };

      const proxyReq = http.request(reqOpts, (proxyRes) => {
          let data = '';
          proxyRes.on('data', chunk => data += chunk);
          proxyRes.on('end', () => {
             res.json({ success: true, simulated: true, status: proxyRes.statusCode });
          });
      });

      proxyReq.on('error', (e) => {
         res.status(500).json({ error: e.message });
      });

      if (fetchOpts.body) {
          proxyReq.write(fetchOpts.body);
      }
      proxyReq.end();
      
    } catch (e: any) {
       res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/analyze", express.json(), async (req, res) => {
      if (!genAI) {
          return res.status(500).json({ error: "GEMINI_API_KEY not configured on server." });
      }
      try {
          const { method, url, headers, body, response } = req.body;
          
          const prompt = `You are a Senior Penetration Tester. Analyze this HTTP transaction for complex logic flaws, such as IDOR, privilege escalation, or insecure business logic. Provide a concise summary of risks and a proof-of-concept.
          
          Method: ${method}
          URL: ${url}
          Headers: ${JSON.stringify(headers)}
          Body: ${body}
          
          Response Status: ${response?.statusCode}
          Response Headers: ${JSON.stringify(response?.headers)}
          Response Body: ${response?.body}
          `;

          const result = await genAI.models.generateContent({
              model: "gemini-1.5-pro",
              contents: [{ role: 'user', parts: [{ text: prompt }] }]
          });
          
          res.json({ text: result.text });
      } catch (e: any) {
          res.status(500).json({ error: e.message });
      }
  });


  // Vite middleware for development UI
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Database Vacuum Worker (Every 10 min, clear older than 24 hours)
  setInterval(async () => {
    try {
       const expirationTime = Date.now() - (24 * 60 * 60 * 1000);
       await db.run(`DELETE FROM intercepted_packets WHERE timestamp < ?`, [expirationTime]);
       console.log("Vacuumed stale DB records");
    } catch (e) {
       console.error("Vacuum error", e);
    }
  }, 10 * 60 * 1000);

  // Start Express UI server
  server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
          console.error(`\nCRITICAL: Port ${PORT} is already in use.`);
          console.error(`Check if another instance is running or change the port in .env: PORT=${PORT + 1}\n`);
          process.exit(1);
      }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Web Intercepting UI running on http://localhost:${PORT}`);
    console.log(`Diagnostic Proxy listening on port ${PROXY_PORT}`);
  });
}

startServer();
