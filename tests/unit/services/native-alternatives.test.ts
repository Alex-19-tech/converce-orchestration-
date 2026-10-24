import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findNativeAlternative, MAX_CODE_LINES, MAX_CODE_CHARS } from '@/services/code-native-alternatives';
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
      ['the current item spread with an extra field', `return { json: { ...$json, processedAt: new Date().toISOString() } };`],
      ['a fixed value from another node shared by mapped items', `const base = $('Config').first().json.url;\nreturn $input.all().map(item => ({ json: { url: base + item.json.path } }));`],
      ['a timestamp taken per mapped item', `return $input.all().map(item => ({ json: { id: item.json.id, at: new Date().toISOString() } }));`],
    ])('Edit Fields for %s', (_label, code) => {
      expect(kindOf(code)).toBe('editFields');
    });

    it('Edit Fields for a field set on the item in per-item mode', () => {
      const code = `$input.item.json.fullName = $json.first + ' ' + $json.last;\nreturn $input.item;`;
      expect(findNativeAlternative(code, 'runOnceForEachItem')).toMatchObject({ kind: 'editFields', executeOnce: false });
      // Run once for all items, $json and $input.item are the first item only
      expect(findNativeAlternative(code, 'runOnceForAllItems')).toBeUndefined();
    });

    it('nothing when the mode is an expression', () => {
      expect(findNativeAlternative(`return { json: { id: $json.id } };`, "={{ 'runOnceForEachItem' }}")).toBeUndefined();
      expect(findNativeAlternative(`return { json: { id: $json.id } };`, undefined)).toMatchObject({ kind: 'editFields', executeOnce: true });
    });

    it('Execute Once only when the code reads no input item past the first', () => {
      expect(findNativeAlternative(`return { json: { a: $input.first().json.a, b: items[0].json.b } };`)).toMatchObject({ kind: 'editFields', executeOnce: true });
      expect(findNativeAlternative(`const all = $input.all();\nreturn { json: { a: all[0].json.a } };`)).toMatchObject({ kind: 'editFields', executeOnce: true });
    });

    it('Edit Fields with Execute Once when one item is built from all items', () => {
      const code = `return { json: { id: $('Create').first().json.id, task: 'Ask for a budget' } };`;
      expect(findNativeAlternative(code)).toMatchObject({ kind: 'editFields', executeOnce: true });
      expect(findNativeAlternative(code, 'runOnceForEachItem')).toMatchObject({ kind: 'editFields', executeOnce: false });
    });

    it('Aggregate for a field collected from every item', () => {
      expect(kindOf(`const values = $input.all().map(item => item.json.id);\nreturn [{ json: { values } }];`)).toBe('aggregate');
    });

    it('Split Out for a list field turned into items, run once in all-items mode', () => {
      const code = `const rows = $json.pages;\nreturn rows.map(row => ({ json: row }));`;
      expect(findNativeAlternative(code)).toMatchObject({ kind: 'splitOut', executeOnce: true });
      expect(findNativeAlternative(code, 'runOnceForEachItem')).toMatchObject({ kind: 'splitOut', executeOnce: false });
    });

    it('the same suggestions for block-bodied callbacks', () => {
      expect(kindOf(`return $input.all().filter(item => { return item.json.active; });`)).toBe('filter');
      expect(kindOf(`const values = $input.all().map(item => { return item.json.id; });\nreturn [{ json: { values } }];`)).toBe('aggregate');
    });

    it('Edit Fields when the item data holds fields named json and pairedItem', () => {
      expect(kindOf(`return items.map(item => ({ json: { id: item.json.id, pairedItem: item.json.ref } }));`)).toBe('editFields');
      expect(findNativeAlternative(`return { json: { json: 'payload', pairedItem: 7 } };`, 'runOnceForEachItem')?.kind).toBe('editFields');
    });

    it('Split Out for a list under a data field named json', () => {
      expect(kindOf(`return $json.json.rows.map(row => ({ json: row }));`)).toBe('splitOut');
    });

    it('Filter for items kept by a condition on the item', () => {
      expect(kindOf(`return $input.all().filter(item => item.json.status === 'active');`)).toBe('filter');
    });

    it('Remove Duplicates for a findIndex dedupe on equal fields', () => {
      expect(kindOf(`return items.filter((item, index, all) => all.findIndex(other => other.json.id === item.json.id) === index);`))
        .toBe('removeDuplicates');
    });

    it('Sort, Summarize and Remove Duplicates name the data they need', () => {
      expect(findNativeAlternative(`return $input.all().sort((a, b) => b.json.score - a.json.score);`))
        .toMatchObject({ kind: 'sort', when: 'the field holds numbers' });
      expect(findNativeAlternative(`const total = $input.all().reduce((sum, item) => sum + item.json.amount, 0);\nreturn [{ json: { total } }];`))
        .toMatchObject({ kind: 'summarize', when: 'the field holds numbers' });
      expect(findNativeAlternative(`return items.filter((item, index, all) => all.findIndex(other => other.json.id === item.json.id) === index);`))
        .toMatchObject({ kind: 'removeDuplicates', when: 'the compared fields hold text or numbers' });
      expect(findNativeAlternative(`return { json: { a: $json.a } };`)?.when).toBeUndefined();
    });

    it('Summarize for a numeric total', () => {
      expect(kindOf(`const total = $input.all().reduce((sum, item) => sum + item.json.amount, 0);\nreturn [{ json: { total } }];`))
        .toBe('summarize');
    });

    it('HTTP Request for a single request, run once in all-items mode', () => {
      const code = `const response = await this.helpers.httpRequest({ method: 'GET', url: 'https://api.example.com/items' });\nreturn [{ json: response }];`;
      expect(findNativeAlternative(code)).toMatchObject({ kind: 'httpRequest', nodeType: 'n8n-nodes-base.httpRequest', executeOnce: true });
      expect(findNativeAlternative(code, 'runOnceForEachItem')).toMatchObject({ kind: 'httpRequest', executeOnce: false });
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
      ['a field set on one item', `$input.first().json.flag = true;\nreturn $input.all();`],
      ['a field set on another item', `items[0].json.total = items.length;\nreturn items;`],
      ['a global assignment', `globalThis.counter = 1;\nreturn { json: { a: 1 } };`],
      ['an extra item appended', `return $input.all().concat([{ json: { total: $input.all().length } }]);`],
      ['items made with Array', `return Array(3).fill({ json: { a: 1 } });`],
      ['a fallback return value', `return $json.skip || [{ json: { a: $json.a } }];`],
      ['an item dropped with null', `return $json.ok ? { json: { a: $json.a } } : null;`],
      ['a filter that only looks like a dedupe', `return items.filter((item, i, all) => item.json.email.indexOf('@') !== -1);`],
      ['an anti-join written inline', `return items.filter(item => !$('Sheet').all().some(row => row.json.id === item.json.id));`],
      ['a filter against a local list', `return items.filter(item => ['a', 'b'].includes(item.json.kind));`],
      ['a filter on $json', `return items.filter(item => item.json.id === $json.id);`],
      ['a computed total', `const total = items.reduce((s, item) => s + item.json.price * item.json.qty, 0);\nreturn [{ json: { total } }];`],
      ['a conditional total', `const total = items.reduce((s, item) => s + (item.json.paid ? item.json.amount : 0), 0);\nreturn [{ json: { total } }];`],
      ['a total from a running balance', `const total = items.reduce((s, item) => s + item.json.amount, $('Prev').first().json.balance);\nreturn [{ json: { total } }];`],
      ['a custom sort order', `return items.sort((a, b) => ['high', 'mid', 'low'].indexOf(a.json.p) - ['high', 'mid', 'low'].indexOf(b.json.p));`],
      ['a maximum via apply', `const prices = items.map(item => item.json.price);\nreturn [{ json: { max: Math.max.apply(null, prices) } }];`],
      ['the first mapped value', `return [{ json: { first: items.map(item => item.json.id)[0] } }];`],
      ['a pass-through with pairedItem', `return [{ json: $input.first().json, pairedItem: { item: 0 } }];`],
      ['items re-paired', `return items.map(item => ({ json: item.json, pairedItem: { item: 0 } }));`],
      ['this.getNodeParameter', `return { json: { value: this.getNodeParameter('field', 0) } };`],
      ['a getter', `return { json: { get now() { return Date.now(); } } };`],
      ['a comma expression', `return { json: { a: ($json.x, $json.y) } };`],
      ['a tagged template', `return { json: { text: String.raw\`a\\nb\` } };`],
      ['sorted items cut with slice (Sort keeps every item)', `const sorted = $input.all().sort((a, b) => b.json.score - a.json.score);\nreturn sorted.slice(0, 4);`],
      ['a list field mapped to computed values', `return $json.rows.map(row => ({ json: { value: row.value * 2 } }));`],
      ['a findIndex that is not field equality', `return $input.all().filter((item, i, all) => all.findIndex(other => other.json.score >= item.json.score) === i);`],
      ['computed values collected into a list', `const values = $input.all().map(item => item.json.price * item.json.qty);\nreturn [{ json: { values } }];`],
      ['a request whose response is discarded', `await this.helpers.httpRequest({ url: 'https://example.com' });\nreturn [{ json: { status: 'done' } }];`],
      ['a side effect through an unknown call', `$execution.customData.set('processed', 'yes');\nreturn { json: { ok: true } };`],
      ['a call through an expression', `return { json: { a: ($json.f || String)($json.x) } };`],
      ['indexOf on item objects (each item is a distinct object)', `return items.filter((item, i, all) => all.indexOf(item) === i);`],
      ['a dotted key compared with a nested path', `return items.filter((item, i, all) => all.findIndex(other => other.json['a.b'] === item.json.a.b) === i);`],
      ['an allowlisted name hidden by a variable', `const String = $execution.customData.set;\nString('processed', 'yes');\nreturn { json: { ok: true } };`],
      ['a call made for its side effect', `$input.first().json.tags.reverse();\nreturn $input.all().filter(item => item.json.active);`],
      ['rows mapped to renamed fields (Split Out keeps the row)', `return $json.rows.map(row => ({ json: { renamed: row.id } }));`],
      ['objects of renamed fields collected (Aggregate collects fields as they are)', `return [{ json: { values: $input.all().map(item => ({ renamed: item.json.id })) } }];`],
      ['a list of another item', `return items[2].json.rows.map(row => ({ json: row }));`],
      ['outputs linked to a chosen input', `return items.map(item => ({ json: { id: item.json.id }, pairedItem: { item: 1 } }));`],
      ['a dedupe whose inner item shadows the outer one', `return items.filter((item, i, all) => all.findIndex(item => item.json.id === item.json.id) === i);`],
      ['a list sorted in place next to a filter', `const ignored = $input.first().json.tags.sort();\nreturn $input.all().filter(item => item.json.active);`],
      ['a pairwise precedence comparator', `return items.sort((a, b) => Number(b.json.before.includes(a.json.id)) - Number(a.json.before.includes(b.json.id)));`],
      ['a sort on item metadata', `return items.sort((a, b) => a.pairedItem.item - b.pairedItem.item);`],
      ['a total of item metadata', `const total = items.reduce((s, item) => s + item.pairedItem.item, 0);\nreturn [{ json: { total } }];`],
      ['text joined with reduce', `const text = items.reduce((s, item) => s + item.json.name, '');\nreturn [{ json: { text } }];`],
      ['a dedupe comparing whole json objects', `return items.filter((item, i, all) => all.findIndex(other => other.json === item.json) === i);`],
      ['a local items holding another node', `const items = $('Fetch').all();\nreturn items[0].json.rows.map(row => ({ json: row }));`],
      ['a localeCompare sort (Sort compares raw lowercased values)', `return $input.all().sort((a, b) => a.json.name.localeCompare(b.json.name, 'en'));`],
      ['a date sort (Sort compares the raw strings)', `return $input.all().sort((a, b) => new Date(b.json.at) - new Date(a.json.at));`],
      ['a dedupe with loose equality', `return items.filter((item, i, all) => all.findIndex(other => other.json.id == item.json.id) === i);`],
      ['an item that builds binary data', `return { json: {}, binary: { file: { data: $json.base64, mimeType: 'text/plain' } } };`],
      ['a total spread over mapped items', `const total = items.reduce((s, x) => s + x.json.amount, 0);\nreturn items.map(x => ({ json: { total, id: x.json.id } }));`],
      ['a total next to a lookup', `const total = items.reduce((s, x) => s + x.json.amount, 0);\nreturn [{ json: { total, top: items.find(x => x.json.top) } }];`],
      ['a second, unreachable return', `return { json: { id: $json.id } };\nreturn $input.all().filter(item => item.json.active);`],
      ['a reused optional-chained value', `const token = Math?.random();\nreturn { json: { a: token, b: token } };`],
      ['texts of all items joined into one item (Execute Once sees the first item only)', `const lines = $input.all().map(item => item.json.title).join('\\n');\nreturn [{ json: { text: lines } }];`],
      ['a count of all items in one item', `return { json: { count: $input.all().length } };`],
      ['the last item read into one item', `return { json: { last: $input.last().json.id } };`],
      ['a request body built from all items', `const response = await this.helpers.httpRequest({ method: 'POST', url: 'https://example.com', body: { ids: items.map(i => i.json.id) } });\nreturn [{ json: response }];`],
      ['a count of $items()', `return { json: { count: $items().length } };`],
      ['a random value shared by mapped items', `const token = Math.random();\nreturn $input.all().map(item => ({ json: { id: item.json.id, token } }));`],
      ['a token built from a random value', `const seed = Math.random();\nconst token = 'batch-' + seed;\nreturn $input.all().map(item => ({ json: { id: item.json.id, token } }));`],
      ['$now held in a variable', `const stamp = $now;\nreturn $input.all().map(item => ({ json: { id: item.json.id, stamp } }));`],
      ['a timestamp shared through an alias', `const now = new Date().toISOString();\nconst stamp = now;\nreturn $input.all().map(item => ({ json: { id: item.json.id, stamp } }));`],
      ['$input held in an object', `const context = { input: $input };\nreturn { json: { count: context.input.all().length } };`],
      ['a count of $items(undefined)', `return { json: { count: $items(undefined).length } };`],
      ['a count through two aliases', `const all = $input.all();\nconst rows = all;\nreturn { json: { count: rows.length } };`],
      ['an alias of $input', `const inp = $input;\nreturn { json: { count: inp.all().length } };`],
      ['a name declared again in a block', `const source = $('Other').all();\n{ const source = $input.all(); }\nreturn source.filter(item => item.json.active);`],
      ['a comparator on different fields', `return items.sort((a, b) => a.json.x - b.json.y);`],
      ['several items per item, flattened', `return $input.all().map(item => [{ json: { id: item.json.id } }, { json: { id: item.json.id } }]).flat();`],
      ['a variable filled in later', `let x;\nreturn { json: { x } };`],
      ['a multi-statement callback', `return $input.all().map(item => { const t = item.json.title; return { json: { t } }; });`],
    ])('%s', (_label, code) => {
      expect(findNativeAlternative(code)).toBeUndefined();
    });

    it(`code longer than ${MAX_CODE_LINES} lines`, () => {
      const fields = Array.from({ length: MAX_CODE_LINES + 2 }, (_, i) => `  f${i}: $json.f${i},`).join('\n');
      expect(findNativeAlternative(`return { json: {\n${fields}\n} };`)).toBeUndefined();
    });

    it('code hiding lines between comment markers in strings', () => {
      const fields = Array.from({ length: 30 }, (_, i) => `  f${i}: $json.f${i},`).join('\n');
      expect(findNativeAlternative(`const open = "/*";\nreturn { json: {\n${fields}\n  close: "*/" } };`)).toBeUndefined();
    });

    it(`more than ${MAX_CODE_CHARS} characters, in linear time`, () => {
      expect(findNativeAlternative(`return { json: { text: '${'x'.repeat(MAX_CODE_CHARS)}' } };`)).toBeUndefined();
      const started = Date.now();
      findNativeAlternative('return { json: {} };\n' + '/* '.repeat(100_000));
      expect(Date.now() - started).toBeLessThan(200);
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
      ['httpHeaderAuth', ['Some Node']],
      ['httpMultipleHeadersAuth', ['MCP Client']],
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
      expect(warning?.message).toContain('"Execute Once"');
      expect(warning?.message).toContain('"Why Code:"');
    }
  });

  it('states the condition for a conditioned suggestion', async () => {
    const result = await validator.validateWorkflow(workflowWith({
      type: 'n8n-nodes-base.code',
      parameters: { jsCode: `const total = $input.all().reduce((sum, item) => sum + item.json.amount, 0);\nreturn [{ json: { total } }];` },
    }) as any, { profile: 'runtime' });
    expect(result.suggestions).toContain(
      'Code node "Step" only totals a field over the items. If the field holds numbers, the Summarize node ' +
      '(n8n-nodes-base.summarize) does this without code. If this needs a Code node, start its notes with "Why Code:" and the reason.'
    );
  });

  it('keeps Execute Once when the Code node already has it', async () => {
    const filterCode = (extra: Record<string, any>) => workflowWith({
      type: 'n8n-nodes-base.code',
      parameters: { jsCode: `return $input.all().filter(item => item.json.active);` },
      ...extra,
    });
    const plain = await validator.validateWorkflow(filterCode({}) as any, { profile: 'runtime' });
    expect(plain.suggestions.find(s => s.includes('Filter'))).not.toContain('"Execute Once"');
    const once = await validator.validateWorkflow(filterCode({ executeOnce: true }) as any, { profile: 'runtime' });
    expect(once.suggestions.find(s => s.includes('Filter'))).toContain('"Execute Once"');
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
      parameters: { language: 'python', pythonCode: 'return [{"json": {"a": 1}}]', jsCode: `return { json: { a: $json.a } };` },
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
    for (const credential of ['httpHeaderAuth', 'httpMultipleHeadersAuth', 'awsApiLike', 'someUnknownApi']) {
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
      expect([...map.values()].flat().some(name => /Trigger$|Tool$|: Insert$/.test(name))).toBe(false);
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
