import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findNativeAlternative, MAX_CODE_LINES } from '@/services/code-native-alternatives';
import { createDatabaseAdapter } from '@/database/database-adapter';
import { NodeRepository } from '@/database/node-repository';
import { WorkflowValidator } from '@/services/workflow-validator';
import { EnhancedConfigValidator } from '@/services/enhanced-config-validator';

vi.mock('@/utils/logger');

const kindOf = (code: string) => findNativeAlternative(code)?.kind;

describe('findNativeAlternative', () => {
  describe('suggests a native node', () => {
    it.each([
      ['a returned object of fields', `return { json: { name: $json.first + ' ' + $json.last, email: $json.email || null } };`],
      ['fields from other nodes', `return { id: $('Create').first().json.id, task: 'Ask for a budget' };`],
      ['items mapped to new fields', `return $input.all().map(item => ({ json: { title: item.json.metadata?.title, url: item.json.url } }));`],
      ['a field set on the current item', `$input.item.json.fullName = $json.first + ' ' + $json.last;\nreturn $input.item;`],
      ['the current item spread with an extra field', `return { json: { ...$json, processedAt: new Date().toISOString() } };`],
      ['item texts joined into one message', `const lines = $input.all().map(item => item.json.title).join('\\n');\nreturn [{ json: { text: lines } }];`],
    ])('Edit Fields for %s', (_label, code) => {
      expect(kindOf(code)).toBe('editFields');
    });

    it('Aggregate for a field collected from every item', () => {
      expect(kindOf(`const values = $input.all().map(item => item.json.id);\nreturn [{ json: { values } }];`)).toBe('aggregate');
    });

    it('Split Out for a list field turned into items', () => {
      expect(kindOf(`const rows = $json.pages;\nreturn rows.map(row => ({ json: { markdown: row.markdown } }));`)).toBe('splitOut');
    });

    it('Sort for sorted items, also with a slice', () => {
      expect(kindOf(`const sorted = $input.all().sort((a, b) => b.json.score - a.json.score);\nreturn sorted.slice(0, 4);`)).toBe('sort');
    });

    it('Filter for items kept by a condition on the item', () => {
      expect(kindOf(`return $input.all().filter(item => item.json.status === 'active');`)).toBe('filter');
    });

    it('Remove Duplicates for a findIndex dedupe', () => {
      expect(kindOf(`return items.filter((item, index, all) => all.findIndex(other => other.json.id === item.json.id) === index);`))
        .toBe('removeDuplicates');
    });

    it('Summarize for a numeric total', () => {
      expect(kindOf(`const total = $input.all().reduce((sum, item) => sum + item.json.amount, 0);\nreturn [{ json: { total } }];`))
        .toBe('summarize');
    });

    it('HTTP Request for a single request', () => {
      const code = `const response = await this.helpers.httpRequest({ method: 'GET', url: 'https://api.example.com/items' });\nreturn [{ json: response }];`;
      expect(findNativeAlternative(code)).toMatchObject({ kind: 'httpRequest', nodeType: 'n8n-nodes-base.httpRequest' });
    });
  });

  describe('leaves code alone', () => {
    it.each([
      ['empty code', ''],
      ['no return', `const x = $json.a;`],
      ['a syntax error', `return { json: { a: `],
      ['a loop', `const out = [];\nfor (const item of items) out.push({ json: item.json });\nreturn out;`],
      ['branching', `if ($json.a) { return { json: { a: 1 } }; }\nreturn { json: { a: 2 } };`],
      ['a regex', `return { json: { digits: $json.text.replace(/\\D/g, '') } };`],
      ['JSON.parse', `return { json: JSON.parse($json.body) };`],
      ['split', `return { json: { parts: $json.csv.split(',') } };`],
      ['a library', `const _ = require('lodash');\nreturn { json: _.pick($json, ['a']) };`],
      ['workflow static data', `const data = $getWorkflowStaticData('global');\nreturn { json: { last: data.last } };`],
      ['several items from one input', `return [{ json: { a: 1 } }, { json: { a: 2 } }];`],
      ['another node spread whole', `return { json: { ...$('Fetch').first().json, ok: true } };`],
      ['binary data', `return { json: $json, binary: { data: $input.item.binary.file } };`],
      ['delete', `const out = { ...$json };\ndelete out.secret;\nreturn { json: out };`],
      ['nested ternaries', `return { json: { size: $json.n > 10 ? 'big' : $json.n > 5 ? 'mid' : 'small' } };`],
      ['a lookup by computed key', `const labels = { a: 'Alpha', b: 'Beta' };\nreturn { json: { label: labels[$json.code] } };`],
      ['a reused computed value', `const days = (Date.now() - new Date($json.created)) / 86400000;\nreturn { json: { days, old: days > 30 } };`],
      ['a map with an index', `return $input.all().map((item, i) => ({ json: { ...item.json, position: i + 1 } }));`],
      ['find', `const match = $input.all().find(item => item.json.id === 5);\nreturn { json: { name: match.json.name } };`],
      ['a filter that compares with another list', `const seen = $('Sheet').all().map(r => r.json.link);\nreturn $input.all().filter(item => !seen.includes(item.json.link));`],
      ['a filter whose result is not returned', `const ready = $input.all().filter(v => v.json.ready).length;\nreturn [{ json: { ready } }];`],
      ['a reduce that builds an object', `const byName = $input.all().reduce((acc, item) => ({ ...acc, [item.json.name]: item.json.id }), {});\nreturn [{ json: byName }];`],
      ['a pass-through of the first item', `return [{ json: $input.first().json }];`],
      ['two requests', `const a = await this.helpers.httpRequest({ url: 'https://a.example' });\nconst b = await this.helpers.httpRequest({ url: 'https://b.example' });\nreturn [{ json: { a, b } }];`],
      ['a list from another node', `return $('Fetch').first().json.rows.map(row => ({ json: { id: row.id } }));`],
      ['another node\'s items', `return $('Fetch').all().map(item => ({ json: { id: item.json.id } }));`],
      ['a ternary choosing between item lists', `return $json.ok ? [{ json: { ok: true } }] : [];`],
      ['a computed field name', `return { json: { [$json.key]: $json.value } };`],
      ['a multi-statement callback', `return $input.all().map(item => { const t = item.json.title; return { json: { t } }; });`],
    ])('%s', (_label, code) => {
      expect(findNativeAlternative(code)).toBeUndefined();
    });

    it(`code longer than ${MAX_CODE_LINES} lines`, () => {
      const fields = Array.from({ length: MAX_CODE_LINES + 2 }, (_, i) => `  f${i}: $json.f${i},`).join('\n');
      expect(findNativeAlternative(`return { json: {\n${fields}\n} };`)).toBeUndefined();
    });

    it('non-string input', () => {
      expect(findNativeAlternative(undefined)).toBeUndefined();
      expect(findNativeAlternative(42)).toBeUndefined();
    });
  });
});

describe('WorkflowValidator native-alternative checks', () => {
  const nodeTypes: Record<string, any> = {
    'nodes-base.manualTrigger': { nodeType: 'nodes-base.manualTrigger', displayName: 'Manual Trigger', package: 'n8n-nodes-base', isTrigger: true, version: '1', properties: [] },
    'nodes-base.code': { nodeType: 'nodes-base.code', displayName: 'Code', package: 'n8n-nodes-base', version: '2', isVersioned: true, properties: [] },
    'nodes-base.httpRequest': { nodeType: 'nodes-base.httpRequest', displayName: 'HTTP Request', package: 'n8n-nodes-base', version: '4.2', isVersioned: true, properties: [] },
  };
  let validator: WorkflowValidator;
  let byCredential: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    byCredential = vi.fn(() => new Map([
      ['notionApi', ['Notion']],
      ['awsApiLike', ['AWS Lambda', 'AWS SNS', 'AWS S3', 'AWS SQS']],
    ]));
    const repository = {
      getNode: vi.fn((type: string) => nodeTypes[type] ?? null),
      getAllNodes: vi.fn(() => Object.values(nodeTypes)),
      getActionNodesByCredentialType: byCredential,
    } as any;
    validator = new WorkflowValidator(repository, EnhancedConfigValidator);
  });

  const workflowWith = (node: Record<string, any>) => ({
    nodes: [
      { id: '1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: '2', name: 'Step', typeVersion: 2, position: [200, 0], ...node },
    ],
    connections: { Start: { main: [[{ node: 'Step', type: 'main', index: 0 }]] } },
  });
  const mappingCode = (extra: Record<string, any> = {}) => workflowWith({
    type: 'n8n-nodes-base.code',
    parameters: { jsCode: `return { json: { name: $json.first + ' ' + $json.last } };` },
    ...extra,
  });

  it('warns with a code under the advisory profiles', async () => {
    for (const profile of ['ai-friendly', 'strict'] as const) {
      const result = await validator.validateWorkflow(mappingCode() as any, { profile });
      const warning = result.warnings.find(w => w.code === 'NATIVE_ALTERNATIVE');
      expect(warning?.nodeName, profile).toBe('Step');
      expect(warning?.message).toContain('Edit Fields (Set)');
      expect(warning?.message).toContain('"Why Code:"');
    }
  });

  it('suggests under runtime and says nothing under minimal', async () => {
    const runtime = await validator.validateWorkflow(mappingCode() as any, { profile: 'runtime' });
    expect(runtime.warnings.some(w => w.code === 'NATIVE_ALTERNATIVE')).toBe(false);
    expect(runtime.suggestions.some(s => s.includes('Code node "Step" only builds or renames fields'))).toBe(true);

    const minimal = await validator.validateWorkflow(mappingCode() as any, { profile: 'minimal' });
    expect([...minimal.suggestions, ...minimal.warnings.map(w => w.message)].some(m => m.includes('Code node "Step"'))).toBe(false);
  });

  it('skips a node whose notes start with "Why Code:" and Python Code nodes', async () => {
    const optedOut = await validator.validateWorkflow(mappingCode({ notes: 'Why Code: the API returns fields we rename later' }) as any, { profile: 'strict' });
    expect(optedOut.warnings.some(w => w.code === 'NATIVE_ALTERNATIVE')).toBe(false);

    const python = await validator.validateWorkflow(workflowWith({
      type: 'n8n-nodes-base.code',
      parameters: { language: 'python', pythonCode: 'return [{"json": {"a": 1}}]' },
    }) as any, { profile: 'strict' });
    expect(python.warnings.some(w => w.code === 'NATIVE_ALTERNATIVE')).toBe(false);
  });

  const httpWith = (nodeCredentialType: string) => workflowWith({
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    parameters: { url: 'https://api.notion.com/v1/pages', authentication: 'predefinedCredentialType', nodeCredentialType },
  });

  it('points an HTTP Request signed with a node credential at that node', async () => {
    const result = await validator.validateWorkflow(httpWith('notionApi') as any, { profile: 'ai-friendly' });
    expect(result.suggestions).toContain(
      'HTTP Request node "Step" uses the notionApi credential of the Notion node. Use the Notion node unless it lacks this operation.'
    );
  });

  it('says nothing for generic, widely shared or unknown credentials, or outside the advisory profiles', async () => {
    for (const credential of ['httpHeaderAuth', 'awsApiLike', 'someUnknownApi']) {
      const result = await validator.validateWorkflow(httpWith(credential) as any, { profile: 'strict' });
      expect(result.suggestions.some(s => s.startsWith('HTTP Request node')), credential).toBe(false);
    }
    for (const profile of ['minimal', 'runtime'] as const) {
      const result = await validator.validateWorkflow(httpWith('notionApi') as any, { profile });
      expect(result.suggestions.some(s => s.startsWith('HTTP Request node')), profile).toBe(false);
    }
  });

  it('reads the credential map once per repository', async () => {
    await validator.validateWorkflow(httpWith('notionApi') as any, { profile: 'strict' });
    await validator.validateWorkflow(httpWith('notionApi') as any, { profile: 'strict' });
    expect(byCredential).toHaveBeenCalledTimes(1);
  });
});

const sourceDbPath = path.join(__dirname, '../../../data/nodes.db');

describe.skipIf(!fs.existsSync(sourceDbPath))('NodeRepository.getActionNodesByCredentialType (real database)', () => {
  it('maps service credentials to their action nodes and leaves out AI model providers', async () => {
    // Work on a copy: opening the tracked database rewrites bytes in it
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-mcp-credential-map-'));
    const copy = path.join(dir, 'nodes.db');
    fs.copyFileSync(sourceDbPath, copy);
    const db = await createDatabaseAdapter(copy);
    try {
      const map = new NodeRepository(db).getActionNodesByCredentialType();
      expect(map.get('notionApi')).toEqual(['Notion']);
      expect(map.get('slackApi')).toContain('Slack');
      // Triggers and tool variants are not action nodes
      expect([...map.values()].flat().some(name => /Trigger$|Tool$/.test(name))).toBe(false);
      // Model providers: their nodes wrap a small part of the API that HTTP Request calls
      for (const credential of ['openAiApi', 'googlePalmApi', 'mistralCloudApi', 'anthropicApi']) {
        expect(map.has(credential), credential).toBe(false);
      }
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
