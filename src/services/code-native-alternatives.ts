/**
 * Detect short JavaScript Code nodes whose whole job is something a native n8n
 * node does: build or map fields, filter, sort, dedupe or total items, collect
 * values into a list, split a list into items, or make one HTTP request.
 *
 * Precision matters more than recall: the result becomes a validation warning,
 * so anything that might need code returns undefined. Loops, branching,
 * parsing (regex, split, JSON.parse), state, libraries, error handling and
 * callbacks with more than one statement all count as needing code.
 */

import { parse } from 'acorn';

export type NativeAlternativeKind =
  | 'editFields'
  | 'filter'
  | 'sort'
  | 'removeDuplicates'
  | 'summarize'
  | 'aggregate'
  | 'splitOut'
  | 'httpRequest';

export interface NativeAlternative {
  kind: NativeAlternativeKind;
  /** Node display name, e.g. "Edit Fields (Set)" */
  node: string;
  /** Workflow node type, e.g. "n8n-nodes-base.set" */
  nodeType: string;
  /** What the Code node does, completing "This Code node only ..." */
  does: string;
}

const ALTERNATIVES: Record<NativeAlternativeKind, Omit<NativeAlternative, 'kind'>> = {
  editFields: { node: 'Edit Fields (Set)', nodeType: 'n8n-nodes-base.set', does: 'builds or renames fields' },
  filter: { node: 'Filter', nodeType: 'n8n-nodes-base.filter', does: 'filters items' },
  sort: { node: 'Sort', nodeType: 'n8n-nodes-base.sort', does: 'sorts items' },
  removeDuplicates: { node: 'Remove Duplicates', nodeType: 'n8n-nodes-base.removeDuplicates', does: 'removes duplicate items' },
  summarize: { node: 'Summarize', nodeType: 'n8n-nodes-base.summarize', does: 'totals or counts items' },
  aggregate: { node: 'Aggregate', nodeType: 'n8n-nodes-base.aggregate', does: 'collects item values into one list' },
  splitOut: { node: 'Split Out', nodeType: 'n8n-nodes-base.splitOut', does: 'turns a list field into separate items' },
  httpRequest: { node: 'HTTP Request', nodeType: 'n8n-nodes-base.httpRequest', does: 'makes an HTTP request' },
};

/** Longer bodies are left alone, whatever they contain. */
export const MAX_CODE_LINES = 20;

/** Array methods whose callback may be a one-expression arrow function. */
const CALLBACK_METHODS = new Set(['map', 'filter', 'sort', 'reduce', 'find', 'some', 'every', 'flatMap', 'findIndex']);

/** Calls that mean parsing, side effects, state or anything a node field can't express. */
const DISQUALIFYING_METHODS = new Set([
  'parse', 'match', 'matchAll', 'replace', 'replaceAll', 'split', 'test', 'exec',
  'forEach', 'push', 'pop', 'shift', 'unshift', 'splice',
  'log', 'info', 'warn', 'error', 'debug',
  'getWorkflowStaticData', 'evaluateExpression', 'then', 'catch'
]);
const DISQUALIFYING_IDENTIFIERS = new Set([
  'require', 'Buffer', 'crypto', 'process', 'eval', 'Function', 'fetch', 'setTimeout', 'setInterval',
  '$getWorkflowStaticData', '$evaluateExpression', 'Promise', 'RegExp'
]);
const DISQUALIFYING_NODE_TYPES = new Set([
  'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement',
  'TryStatement', 'ThrowStatement', 'SwitchStatement', 'IfStatement', 'LabeledStatement', 'WithStatement',
  'FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression', 'YieldExpression',
  'UpdateExpression', 'ImportExpression'
]);
const ALLOWED_CONSTRUCTORS = new Set(['Date', 'Set']);
/** Globals a self-contained callback may use besides its own parameters and $-variables. */
const CALLBACK_GLOBALS = new Set(['Date', 'Number', 'String', 'Boolean', 'Math', 'JSON', 'undefined', 'NaN', 'Infinity']);

type AstNode = { type: string; [key: string]: any };

function walk(node: AstNode, visit: (node: AstNode, parent: AstNode | undefined) => void, parent?: AstNode): void {
  visit(node, parent);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visit, node);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walk(value, visit, node);
    }
  }
}

function countCodeLines(code: string): number {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('//');
    }).length;
}

function propertyName(member: AstNode): string | undefined {
  if (member.type !== 'MemberExpression') return undefined;
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (member.property.type === 'Literal' && typeof member.property.value === 'string') return member.property.value;
  return undefined;
}

function isHttpRequestCall(node: AstNode): boolean {
  if (node.type !== 'CallExpression' || propertyName(node.callee) !== 'httpRequest') return false;
  const helpers = node.callee.object;
  // this.helpers.httpRequest(...) or $helpers.httpRequest(...)
  return (helpers.type === 'MemberExpression' && propertyName(helpers) === 'helpers') ||
    (helpers.type === 'Identifier' && helpers.name === '$helpers');
}

/**
 * `$input.all()` or `items`: this node's input items. Another node's items
 * (`$('Node').all()`) are not: a native node after this one only sees its input.
 */
function isItemsSource(node: AstNode | undefined, aliases: Set<string>): boolean {
  if (!node) return false;
  if (node.type === 'Identifier') return node.name === 'items' || aliases.has(node.name);
  if (node.type === 'CallExpression' && propertyName(node.callee) === 'all') {
    const owner = node.callee.object;
    return owner.type === 'Identifier' && owner.name === '$input';
  }
  return false;
}

/**
 * Return the native node that does the same job as this Code node, or undefined
 * when the code may need to be code.
 */
export function findNativeAlternative(jsCode: unknown): NativeAlternative | undefined {
  // Advice only: an unexpected syntax tree must never break validation
  try {
    return analyze(jsCode);
  } catch {
    return undefined;
  }
}

function analyze(jsCode: unknown): NativeAlternative | undefined {
  if (typeof jsCode !== 'string' || jsCode.trim() === '') return undefined;
  if (countCodeLines(jsCode) > MAX_CODE_LINES) return undefined;

  let program: AstNode;
  try {
    program = parse(jsCode, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true
    }) as unknown as AstNode;
  } catch {
    return undefined;
  }

  let disqualified = false;
  const inits = new Map<string, AstNode>(); // variable -> its initializer
  const returns: AstNode[] = [];
  const methods = new Map<string, AstNode[]>(); // array method name -> call nodes
  let httpCalls = 0;
  let usesSet = false;
  let assignsItemField = false;

  walk(program, (node, parent) => {
    if (disqualified) return;
    if (DISQUALIFYING_NODE_TYPES.has(node.type)) { disqualified = true; return; }

    switch (node.type) {
      case 'Literal':
        if (node.regex) disqualified = true;
        break;
      case 'UnaryExpression':
        if (node.operator === 'delete') disqualified = true;
        break;
      case 'ConditionalExpression':
        // Nested ternaries read worse in a node field than in code, and a ternary
        // that picks between item lists (cond ? [] : [...]) changes the item count
        if ([node.consequent, node.alternate].some((branch: AstNode) =>
          branch.type === 'ConditionalExpression' || branch.type === 'ArrayExpression')) {
          disqualified = true;
        }
        break;
      case 'Property':
        // { [key]: value } builds a field name at runtime
        if (node.computed && node.key.type !== 'Literal') disqualified = true;
        break;
      case 'MemberExpression':
        // Binary data, and lookups by a computed key (table[$json.code]), need code
        if (propertyName(node) === 'binary') disqualified = true;
        if (node.computed && node.property.type !== 'Literal' && !isIndexArithmetic(node.property)) disqualified = true;
        break;
      case 'SpreadElement':
        // Spreading the current item is "include other fields"; anything else has unknown keys
        if (!isCurrentItemJson(node.argument)) disqualified = true;
        break;
      case 'ArrayExpression':
        // Several items returned from one input: Edit Fields returns one item per input
        if (parent?.type === 'ReturnStatement' && node.elements.length > 1) disqualified = true;
        break;
      case 'Identifier':
        if (DISQUALIFYING_IDENTIFIERS.has(node.name)) disqualified = true;
        break;
      case 'ReturnStatement':
        returns.push(node);
        break;
      case 'VariableDeclarator':
        if (node.id.type === 'Identifier' && node.init) inits.set(node.id.name, node.init);
        else if (node.id.type !== 'Identifier') disqualified = true; // destructuring
        break;
      case 'AssignmentExpression':
        // Reassigning a variable is imperative code; setting a field on an item is not
        if (node.left.type !== 'MemberExpression') disqualified = true;
        else assignsItemField = true;
        break;
      case 'NewExpression':
        if (node.callee.type !== 'Identifier' || !ALLOWED_CONSTRUCTORS.has(node.callee.name)) disqualified = true;
        if (node.callee.type === 'Identifier' && node.callee.name === 'Set') usesSet = true;
        break;
      case 'AwaitExpression':
        if (!isHttpRequestCall(node.argument)) disqualified = true;
        break;
      case 'ArrowFunctionExpression': {
        // Only a one-expression callback of an array method
        const isCallback = parent?.type === 'CallExpression' && parent.arguments.includes(node) &&
          CALLBACK_METHODS.has(propertyName(parent.callee) ?? '');
        const body = node.body;
        const simpleBody = body.type !== 'BlockStatement' ||
          (body.body.length === 1 && body.body[0].type === 'ReturnStatement');
        if (!isCallback || !simpleBody || node.async || node.params.some((p: AstNode) => p.type !== 'Identifier')) {
          disqualified = true;
        }
        break;
      }
      case 'CallExpression': {
        if (node.callee.type === 'Identifier' && DISQUALIFYING_IDENTIFIERS.has(node.callee.name)) { disqualified = true; break; }
        const method = propertyName(node.callee);
        if (!method) break;
        if (isHttpRequestCall(node)) { httpCalls++; break; }
        if (DISQUALIFYING_METHODS.has(method)) { disqualified = true; break; }
        const object = node.callee.object;
        // Object.keys/entries/assign...: dynamic keys need code
        if (object.type === 'Identifier' && object.name === 'Object') { disqualified = true; break; }
        // Any other helper (this.helpers.*, $helpers.*) needs code
        if ((object.type === 'MemberExpression' && propertyName(object) === 'helpers') ||
            (object.type === 'Identifier' && object.name === '$helpers')) { disqualified = true; break; }
        if (CALLBACK_METHODS.has(method)) methods.set(method, [...(methods.get(method) ?? []), node]);
        break;
      }
    }
  });

  if (disqualified || returns.length === 0) return undefined;
  if (reusesComputedVariable(program, inits)) return undefined;

  const pick = (kind: NativeAlternativeKind): NativeAlternative => ({ kind, ...ALTERNATIVES[kind] });

  /** Follow variables to their initializer and drop a trailing .slice() or .flat(). */
  const resolve = (node: AstNode | undefined, depth = 0): AstNode | undefined => {
    if (!node || depth > 5) return node;
    if (node.type === 'Identifier' && inits.has(node.name)) return resolve(inits.get(node.name), depth + 1);
    if (node.type === 'CallExpression' && ['slice', 'flat'].includes(propertyName(node.callee) ?? '')) {
      return resolve(node.callee.object, depth + 1);
    }
    return node;
  };
  const isItems = (node: AstNode | undefined) => {
    const target = resolve(node);
    return isItemsSource(target, new Set()) || (target?.type === 'Identifier' && target.name === 'items');
  };
  /** The call's result is what the node returns as its items. */
  const returnedAsItems = (call: AstNode) => returns.some(ret => resolve(ret.argument) === call);
  const callsOnItems = (method: string) => (methods.get(method) ?? []).filter(call => isItems(call.callee.object));

  if (httpCalls > 0) {
    // One request and nothing else worth code
    return httpCalls === 1 && methods.size === 0 && !usesSet ? pick('httpRequest') : undefined;
  }
  if (usesSet) return undefined;

  for (const call of callsOnItems('filter')) {
    const callback = call.arguments[0];
    if (!returnedAsItems(call) || !isSelfContained(callback)) continue;
    // filter((item, index, all) => all.findIndex(...) === index) removes duplicates
    const dedupe = callback.params.length === 3 || containsCall(callback, ['indexOf', 'findIndex']);
    return pick(dedupe ? 'removeDuplicates' : 'filter');
  }
  for (const call of callsOnItems('sort')) {
    if (returnedAsItems(call) && isSelfContained(call.arguments[0])) return pick('sort');
  }
  if (methods.has('sort') || methods.has('filter')) return undefined;

  if (methods.has('reduce')) {
    const calls = methods.get('reduce')!;
    const totals = calls.length === 1 && isItems(calls[0].callee.object) && !returnedAsItems(calls[0]) &&
      isNumericAccumulator(calls[0].arguments[0]);
    return totals ? pick('summarize') : undefined;
  }
  if (['find', 'some', 'every', 'findIndex', 'flatMap'].some(method => methods.has(method))) return undefined;

  if (methods.has('map')) {
    const calls = methods.get('map')!;
    if (calls.length !== 1) return undefined;
    const call = calls[0];
    const callback = call.arguments[0];
    if (!callback || callback.type !== 'ArrowFunctionExpression') return undefined;
    const result = callback.body.type === 'BlockStatement' ? callback.body.body[0]?.argument : callback.body;
    if (!result) return undefined;
    const returnsObject = result.type === 'ObjectExpression';
    const returned = returnedAsItems(call);

    // An index parameter (item, i) => ... numbers or pairs items: leave it to code
    if (callback.params.length > 1) return undefined;
    if (isItems(call.callee.object)) {
      // items.map(item => ({ json: {...} })) maps fields
      if (returned) return returnsObject ? pick('editFields') : undefined;
      // items.map(...).join('\n') builds one text: Edit Fields with Execute Once
      if (isJoined(call, program)) return pick('editFields');
      // collected into one item it aggregates
      return pick('aggregate');
    }
    // A list field turned into items: $json.rows.map(row => ({ json: row }))
    return returnsObject && returned && isInputField(resolve(call.callee.object)) ? pick('splitOut') : undefined;
  }

  // No array methods: building fields from the input
  const buildsObject = returns.some(ret => buildsFields(resolve(ret.argument)));
  return buildsObject || assignsItemField ? pick('editFields') : undefined;
}

/** A callback that uses only its parameters, $-variables and plain globals. */
function isSelfContained(callback: AstNode | undefined): boolean {
  if (!callback || callback.type !== 'ArrowFunctionExpression') return false;
  // Parameters of the callback and of callbacks nested in it
  const params = new Set<string>();
  walk(callback, (node) => {
    if (node.type === 'ArrowFunctionExpression') for (const param of node.params) params.add(param.name);
  });
  let selfContained = true;
  walk(callback.body, (node, parent) => {
    if (node.type !== 'Identifier') return;
    // property names in a.b and { b: ... } are not variables
    if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
    if (parent?.type === 'Property' && parent.key === node && !parent.computed) return;
    if (params.has(node.name) || node.name.startsWith('$') || CALLBACK_GLOBALS.has(node.name)) return;
    selfContained = false;
  });
  return selfContained;
}

/** (sum, item) => sum + item.json.amount */
function isNumericAccumulator(callback: AstNode | undefined): boolean {
  if (!callback || callback.type !== 'ArrowFunctionExpression' || callback.params.length < 2) return false;
  const body = callback.body.type === 'BlockStatement' ? callback.body.body[0]?.argument : callback.body;
  const accumulator = callback.params[0].name;
  return body?.type === 'BinaryExpression' && body.operator === '+' &&
    body.left.type === 'Identifier' && body.left.name === accumulator && isSelfContained(callback);
}

function containsCall(node: AstNode, methodNames: string[]): boolean {
  let found = false;
  walk(node, (child) => {
    if (child.type === 'CallExpression' && methodNames.includes(propertyName(child.callee) ?? '')) found = true;
  });
  return found;
}

/**
 * Whether the returned value builds fields: an object literal other than a bare
 * `{ json: <existing value> }` wrapper, which only passes an item through.
 */
function buildsFields(node: AstNode | undefined): boolean {
  if (!node) return false;
  let found = false;
  walk(node, (child) => {
    if (child.type !== 'ObjectExpression') return;
    const wrapperOnly = child.properties.length > 0 && child.properties.every((property: AstNode) => {
      if (property.type !== 'Property') return false;
      const key = property.key?.name ?? property.key?.value;
      if (key === 'pairedItem') return true;
      return key === 'json' && property.value.type !== 'ObjectExpression';
    });
    if (!wrapperOnly) found = true;
  });
  return found;
}

/** $json, item.json, $input.item.json or $input.first().json: the current input item. */
function isCurrentItemJson(node: AstNode): boolean {
  if (node.type === 'Identifier') return node.name === '$json';
  if (propertyName(node) !== 'json') return false;
  const owner = node.object;
  if (owner.type === 'Identifier') return true; // a callback parameter or an item variable
  if (propertyName(owner) === 'item' && owner.object.type === 'Identifier' && owner.object.name === '$input') return true;
  return owner.type === 'CallExpression' && propertyName(owner.callee) === 'first' &&
    owner.callee.object.type === 'Identifier' && owner.callee.object.name === '$input';
}

/** list[list.length - 1] and similar: an index computed from a length or a number. */
function isIndexArithmetic(node: AstNode): boolean {
  if (node.type === 'Literal') return true;
  if (node.type === 'MemberExpression') return propertyName(node) === 'length';
  if (node.type === 'BinaryExpression') return isIndexArithmetic(node.left) && isIndexArithmetic(node.right);
  return false;
}

/** The map() result is turned into one text with .join(). */
function isJoined(call: AstNode, program: AstNode): boolean {
  let joined = false;
  walk(program, (node) => {
    if (node.type === 'CallExpression' && propertyName(node.callee) === 'join' && node.callee.object === call) joined = true;
  });
  return joined;
}

/**
 * A computed intermediate (const ageDays = (now - created) / 86400000) used more
 * than once: each use would repeat the computation in a node field.
 */
function reusesComputedVariable(program: AstNode, inits: Map<string, AstNode>): boolean {
  const computed = new Set(
    [...inits].filter(([, init]) => ['BinaryExpression', 'ConditionalExpression', 'LogicalExpression', 'CallExpression', 'NewExpression']
      .includes(init.type)).map(([name]) => name)
  );
  if (computed.size === 0) return false;
  const uses = new Map<string, number>();
  const counted = new WeakSet<AstNode>(); // in case key and value share a node
  walk(program, (node, parent) => {
    if (node.type !== 'Identifier' || !computed.has(node.name) || counted.has(node)) return;
    counted.add(node);
    if (parent?.type === 'VariableDeclarator' && parent.id === node) return;
    if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
    // a property key is not a use; in a shorthand { total } the value node is
    if (parent?.type === 'Property' && parent.key === node && !parent.computed && parent.value !== node) return;
    uses.set(node.name, (uses.get(node.name) ?? 0) + 1);
  });
  return [...uses.values()].some(count => count > 1);
}

/**
 * A list field of this node's input: $json.rows, items[0].json.rows,
 * $input.first().json.rows. Split Out only sees its input, so a list read from
 * another node ($('Node').first().json.rows) does not count.
 */
function isInputField(node: AstNode | undefined): boolean {
  if (node?.type !== 'MemberExpression') return false;
  let base: AstNode = node;
  while (base.type === 'MemberExpression' || base.type === 'CallExpression') {
    base = base.type === 'MemberExpression' ? base.object : base.callee;
  }
  return base.type === 'Identifier' && ['$json', '$input', 'items'].includes(base.name);
}
