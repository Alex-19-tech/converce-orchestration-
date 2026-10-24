import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/database/database-adapter');
vi.mock('../../../src/database/node-repository');
vi.mock('../../../src/templates/template-service');
vi.mock('../../../src/utils/logger');

import { N8NDocumentationMCPServer } from '../../../src/mcp/server';

const REAL_NODES: Array<[string, string]> = [
  ['nodes-base.slack', 'Slack'],
  ['nodes-base.webhook', 'Webhook'],
  ['nodes-base.httpRequest', 'HTTP Request'],
  ['nodes-base.googleSheets', 'Google Sheets'],
  ['nodes-base.googleDrive', 'Google Drive'],
  ['nodes-base.postgres', 'Postgres'],
  ['nodes-base.scheduleTrigger', 'Schedule Trigger'],
  ['nodes-langchain.agent', 'AI Agent'],
];

function makeRows() {
  const rows = REAL_NODES.map(([nodeType, displayName]) => ({ nodeType, displayName }));
  for (let i = 0; i < 3000; i++) {
    rows.push({ nodeType: `nodes-base.generatedNode${i}`, displayName: `Generated Node ${i}` });
  }
  return rows.map(({ nodeType, displayName }) => ({
    node_type: nodeType,
    display_name: displayName,
    package_name: 'n8n-nodes-base',
    description: `${displayName} node`,
    category: 'transform',
    operations: null,
    deprecated_versions: null,
  }));
}

describe('search_nodes FUZZY mode', () => {
  let server: N8NDocumentationMCPServer;

  beforeEach(async () => {
    process.env.NODE_DB_PATH = ':memory:';
    server = new N8NDocumentationMCPServer();
    await (server as any).initialized?.catch?.(() => {});
    const rows = makeRows();
    (server as any).db = { prepare: () => ({ all: () => rows }) };
  });

  afterEach(() => {
    delete process.env.NODE_DB_PATH;
  });

  const fuzzy = (query: string) => (server as any).searchNodesFuzzy(query, 10);

  it('finds nodes despite typos', async () => {
    expect((await fuzzy('slak')).results[0].nodeType).toBe('nodes-base.slack');
    expect((await fuzzy('webhok')).results[0].nodeType).toBe('nodes-base.webhook');
    expect((await fuzzy('postgress')).results[0].nodeType).toBe('nodes-base.postgres');
    expect((await fuzzy('googel sheets')).results[0].nodeType).toBe('nodes-base.googleSheets');
  });

  it('handles a long query', async () => {
    const start = Date.now();
    const result = await fuzzy('slack ' + 'q'.repeat(4_000));
    expect(Date.now() - start).toBeLessThan(2000);
    expect(result.results).toEqual([]);
  });

  it('scores a query just inside the length limit the same way as before', async () => {
    // 'Schedule Trigger' is 16 characters, so a 24-character query can still match it.
    const result = await fuzzy('schedule triggerxxxxxxxx');
    expect(result.results.map((r: any) => r.nodeType)).toContain('nodes-base.scheduleTrigger');
  });
});
