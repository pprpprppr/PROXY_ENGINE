import { GoogleGenAI, Type } from '@google/genai';
import type { AppConfig } from '../config.js';
import type { AiFinding, AiSecurityAnalysis } from '../types.js';
import { redactHeaders, redactSensitiveText, redactUrlSecrets } from '../security.js';
import { logEvent } from '../logger.js';

export interface AnalyzeTransactionInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  response?: {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: string;
  };
}

function truncateText(text: string | undefined, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n... [truncated ${text.length - maxLen} chars]`;
}

function formatStructuredMarkdown(summary: string, findings: AiFinding[], model: string): string {
  const lines: string[] = [
    `### Defensive Security Analysis (${model})`,
    '',
    summary,
    '',
  ];
  if (findings.length === 0) {
    lines.push('No high-confidence vulnerabilities identified in this isolated transaction.');
    return lines.join('\n');
  }
  for (const f of findings) {
    lines.push(`#### [${f.severity}] ${f.title} (Confidence: ${f.confidence})`);
    lines.push(`- **Affected Request:** \`${f.affectedRequest}\``);
    lines.push(`- **Evidence:** ${f.evidence}`);
    lines.push(`- **Technical Explanation:** ${f.technicalExplanation}`);
    lines.push(`- **Potential Impact:** ${f.potentialImpact}`);
    lines.push(`- **Recommended Remediation:** ${f.recommendedRemediation}`);
    lines.push('');
  }
  return lines.join('\n');
}

function isRetryableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('429') || msg.includes('503') || msg.includes('rate limit') || msg.includes('temporarily');
}

export class GeminiSecurityService {
  private client: GoogleGenAI | null;
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.client = config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey }) : null;
    if (config.geminiModelWarning) {
      logEvent('warn', 'gemini', config.geminiModelWarning);
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  getModel(): string {
    return this.config.geminiModel;
  }

  async analyzeTransaction(input: AnalyzeTransactionInput): Promise<AiSecurityAnalysis> {
    if (!this.client) {
      throw new Error('GEMINI_API_KEY is not configured on the backend server.');
    }

    const safeUrl = redactUrlSecrets(input.url);
    const safeReqHeaders = redactHeaders(input.headers);
    const safeResHeaders = redactHeaders(input.response?.headers);
    const safeReqBody = redactSensitiveText(truncateText(input.body, 4000));
    const safeResBody = redactSensitiveText(truncateText(input.response?.body, 6000));

    let prompt = [
      'You are an Application Security Engineer performing a defensive review of an HTTP transaction.',
      'Sensitive credentials (Authorization, Cookies, API keys, JWTs) have been redacted.',
      'Identify security risks, misconfigurations, injection indicators, IDOR/authorization risks, or data exposure.',
      'Provide defensive, actionable remediation guidance. Do NOT generate exploit payloads or weaponized attacks.',
      '',
      `Method: ${input.method}`,
      `URL: ${safeUrl}`,
      `Request Headers: ${JSON.stringify(safeReqHeaders)}`,
      `Request Body:\n${safeReqBody || '(empty)'}`,
      '',
      `Response Status: ${input.response?.statusCode ?? 'N/A'}`,
      `Response Headers: ${JSON.stringify(safeResHeaders)}`,
      `Response Body:\n${safeResBody || '(empty)'}`,
    ].join('\n');

    if (prompt.length > this.config.geminiMaxPromptChars) {
      prompt = prompt.slice(0, this.config.geminiMaxPromptChars) + '\n... [prompt capped]';
    }

    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resultPromise = this.client.models.generateContent({
          model: this.config.geminiModel,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                summary: { type: Type.STRING },
                findings: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      severity: { type: Type.STRING },
                      confidence: { type: Type.STRING },
                      affectedRequest: { type: Type.STRING },
                      evidence: { type: Type.STRING },
                      technicalExplanation: { type: Type.STRING },
                      potentialImpact: { type: Type.STRING },
                      recommendedRemediation: { type: Type.STRING },
                    },
                    required: [
                      'title',
                      'severity',
                      'confidence',
                      'affectedRequest',
                      'evidence',
                      'technicalExplanation',
                      'potentialImpact',
                      'recommendedRemediation',
                    ],
                  },
                },
              },
              required: ['summary', 'findings'],
            },
          },
        });

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Gemini request timed out after ${this.config.geminiTimeoutMs}ms`)), this.config.geminiTimeoutMs)
        );

        const response = await Promise.race([resultPromise, timeoutPromise]);
        const rawText = response.text || '{}';
        let parsed: { summary?: string; findings?: AiFinding[] };
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = { summary: rawText, findings: [] };
        }

        const summary = parsed.summary || 'Analysis complete.';
        const findings: AiFinding[] = Array.isArray(parsed.findings) ? parsed.findings : [];
        const markdown = formatStructuredMarkdown(summary, findings, this.config.geminiModel);

        return {
          model: this.config.geminiModel,
          analyzedAt: Date.now(),
          summary,
          findings,
          markdown,
        };
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts && isRetryableError(err)) {
          const backoffMs = 400 * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        break;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
