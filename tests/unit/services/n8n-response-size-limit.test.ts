import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { gzipSync } from 'zlib';
import {
  N8nApiClient,
  getMaxResponseBytes,
} from '../../../src/services/n8n-api-client';
import { fetchN8nVersion, clearVersionCache } from '../../../src/services/n8n-version';
import { ChatHandler } from '../../../src/triggers/handlers/chat-handler';
import { FormHandler } from '../../../src/triggers/handlers/form-handler';
import type { Workflow } from '../../../src/types/n8n-api';

const MiB = 1024 * 1024;

/** Gzip-compressed JSON body that decodes to roughly `size` bytes. */
function gzippedJson(size: number): Buffer {
  return gzipSync(Buffer.from(JSON.stringify({ data: [], padding: 'a'.repeat(size) })));
}

describe('n8n response size limit', () => {
  let server: http.Server;
  let baseUrl: string;
  let body: Buffer = Buffer.alloc(0);
  const savedEnv = {
    mode: process.env.WEBHOOK_SECURITY_MODE,
    limit: process.env.N8N_MCP_MAX_RESPONSE_SIZE,
  };

  beforeAll(async () => {
    process.env.WEBHOOK_SECURITY_MODE = 'moderate';
    process.env.N8N_MCP_MAX_RESPONSE_SIZE = String(MiB);
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of [
      ['WEBHOOK_SECURITY_MODE', savedEnv.mode],
      ['N8N_MCP_MAX_RESPONSE_SIZE', savedEnv.limit],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(() => {
    clearVersionCache();
  });

  const makeClient = () => new N8nApiClient({ baseUrl, apiKey: 'test-key', maxRetries: 0 });

  it('defaults to 50 MiB and reads N8N_MCP_MAX_RESPONSE_SIZE', () => {
    const configured = process.env.N8N_MCP_MAX_RESPONSE_SIZE;
    try {
      delete process.env.N8N_MCP_MAX_RESPONSE_SIZE;
      expect(getMaxResponseBytes()).toBe(50 * MiB);
      process.env.N8N_MCP_MAX_RESPONSE_SIZE = '2048';
      expect(getMaxResponseBytes()).toBe(2048);
    } finally {
      process.env.N8N_MCP_MAX_RESPONSE_SIZE = configured;
    }
  });

  it('falls back to the default for values that are not a positive whole number of bytes', () => {
    const configured = process.env.N8N_MCP_MAX_RESPONSE_SIZE;
    try {
      for (const value of ['50mb', 'not-a-number', '0', '-5', '1.5', '1e400', ' ']) {
        process.env.N8N_MCP_MAX_RESPONSE_SIZE = value;
        expect(getMaxResponseBytes()).toBe(50 * MiB);
      }
    } finally {
      process.env.N8N_MCP_MAX_RESPONSE_SIZE = configured;
    }
  });

  it('accepts a compressed API response under the limit', async () => {
    body = gzippedJson(MiB / 2);
    const result = await makeClient().listWorkflows();
    expect(result.data).toEqual([]);
  });

  it('caps API responses by decoded size with a clear error', async () => {
    body = gzippedJson(4 * MiB);
    await expect(makeClient().listWorkflows()).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      message: expect.stringContaining('exceeded the 1 MB size limit'),
    });
  });

  it('caps webhook responses', async () => {
    body = gzippedJson(4 * MiB);
    await expect(
      makeClient().triggerWebhook({ webhookUrl: `${baseUrl}/webhook/abc`, httpMethod: 'POST', data: {} })
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('caps the version probe response', async () => {
    body = gzipSync(Buffer.from(JSON.stringify({ data: { n8nVersion: '2.40.0', padding: 'a'.repeat(4 * MiB) } })));
    expect(await fetchN8nVersion(baseUrl, { forceRefresh: true })).toBeNull();

    body = gzipSync(Buffer.from(JSON.stringify({ data: { n8nVersion: '2.40.0' } })));
    expect((await fetchN8nVersion(baseUrl, { forceRefresh: true }))?.version).toBe('2.40.0');
  });

  const workflow = { id: 'wf-1', name: 'wf', active: true, nodes: [], connections: {} } as unknown as Workflow;
  const context = () => ({ n8nApiUrl: baseUrl, n8nApiKey: 'test-key' });

  it('caps chat trigger responses with a clear error', async () => {
    body = gzippedJson(4 * MiB);
    const handler = new ChatHandler(makeClient(), context());
    const result = await handler.execute({ workflowId: 'wf-1', triggerType: 'chat', message: 'hi' }, workflow);
    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeded the 1 MB size limit');
  });

  it('caps form trigger responses with a clear error', async () => {
    body = gzippedJson(4 * MiB);
    const handler = new FormHandler(makeClient(), context());
    const result = await handler.execute({ workflowId: 'wf-1', triggerType: 'form', formData: {} }, workflow);
    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeded the 1 MB size limit');
  });
});
