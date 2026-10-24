/**
 * Detect short JavaScript Code nodes whose whole job is something a native n8n
 * node does: build or map fields, filter, sort, dedupe or total items, collect
 * values into a list, split a list into items, or make one HTTP request.
 *
 * Precision matters more than recall: the result becomes a validation warning,
 * so anything that might need code returns undefined. Loops, branching,
 * parsing (regex, split, JSON.parse), state, libraries, error handling,
 * callbacks with more than one statement, and returns that change the number
 * of items in ways a node does not, all count as needing code.
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
  /**
   * The node must run once rather than once per item ("Execute Once" in its
   * settings): the Code node runs once for all items and produces one result.
   */
  executeOnce: boolean;
}

/** Code node execution mode (`parameters.mode`); n8n's default is runOnceForAllItems. */
export type CodeNodeMode = 'runOnceForAllItems' | 'runOnceForEachItem';

const ALTERNATIVES: Record<NativeAlternativeKind, Omit<NativeAlternative, 'kind' | 'executeOnce'>> = {
  editFields: { node: 'Edit Fields (Set)', nodeType: 'n8n-nodes-base.set', does: 'builds or renames fields' },
  filter: { node: 'Filter', nodeType: 'n8n-nodes-base.filter', does: 'filters items' },
  sort: { node: 'Sort', nodeType: 'n8n-nodes-base.sort', does: 'sorts items' },
  removeDuplicates: { node: 'Remove Duplicates', nodeType: 'n8n-nodes-base.removeDuplicates', does: 'removes duplicate items' },
  summarize: { node: 'Summarize', nodeType: 'n8n-nodes-base.summarize', does: 'totals a field over the items' },
  aggregate: { node: 'Aggregate', nodeType: 'n8n-nodes-base.aggregate', does: 'collects item values into one list' },
  splitOut: { node: 'Split Out', nodeType: 'n8n-nodes-base.splitOut', does: 'turns a list field into separate items' },
  httpRequest: { node: 'HTTP Request', nodeType: 'n8n-nodes-base.httpRequest', does: 'makes an HTTP request' },
};

/** Longer bodies are left alone, whatever they contain. */
export const MAX_CODE_LINES = 20;
/** Checked before parsing, so the cost of a check stays bounded. */
export const MAX_CODE_CHARS = 5000;

/** Array methods whose callback may be a one-expression arrow function. */
const CALLBACK_METHODS = new Set(['map', 'filter', 'sort', 'reduce', 'find', 'some', 'every', 'flatMap', 'findIndex']);

/**
 * The only calls the code may make: reading items and other nodes, and value
 * formatting a node field expression does as well. Any other call (parsing,
 * side effects such as $execution.customData.set(), state, libraries) means
 * code.
 */
const ALLOWED_FUNCTIONS = new Set([
  '$', '$items', 'String', 'Number', 'Boolean', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI'
]);
const ALLOWED_METHODS = new Set([
  // items and other nodes
  'first', 'last', 'all',
  // array methods with a callback (checked separately) and plain list methods
  ...CALLBACK_METHODS, 'join', 'slice', 'flat', 'includes', 'indexOf', 'reverse',
  // strings
  'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'substring', 'substr',
  'padStart', 'padEnd', 'startsWith', 'endsWith', 'charAt', 'lastIndexOf', 'toString', 'fromCharCode',
  // numbers and Math
  'toFixed', 'toLocaleString', 'floor', 'ceil', 'round', 'abs', 'min', 'max', 'random',
  // dates (Date and Luxon)
  'now', 'getTime', 'toISOString', 'toLocaleDateString', 'toLocaleTimeString', 'getFullYear', 'getMonth',
  'getDate', 'getDay', 'getHours', 'getMinutes', 'toISO', 'toFormat', 'toMillis', 'plus', 'minus',
  'startOf', 'endOf', 'setZone',
  // JSON.stringify
  'stringify',
  // the single request of the HTTP Request case
  'httpRequest'
]);
const DISQUALIFYING_IDENTIFIERS = new Set([
  'require', 'Buffer', 'crypto', 'process', 'eval', 'Function', 'fetch', 'setTimeout', 'setInterval',
  '$getWorkflowStaticData', '$evaluateExpression', 'Promise', 'RegExp', 'Array', 'globalThis', 'arguments'
]);
const DISQUALIFYING_NODE_TYPES = new Set([
  'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement',
  'TryStatement', 'ThrowStatement', 'SwitchStatement', 'IfStatement', 'LabeledStatement', 'WithStatement',
  'FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression', 'YieldExpression',
  'UpdateExpression', 'ImportExpression', 'SequenceExpression', 'TaggedTemplateExpression'
]);
/** `new Set()` (hand-made dedupe or lookups) is left to code. */
const ALLOWED_CONSTRUCTORS = new Set(['Date']);
/** Initializers that make a variable a computed intermediate (see reusesComputedVariable). */
const COMPUTED_INITIALIZERS = new Set(['BinaryExpression', 'ConditionalExpression', 'LogicalExpression', 'CallExpression', 'NewExpression']);
/** Globals a self-contained callback may use besides its own parameters and $-variables. */
const CALLBACK_GLOBALS = new Set(['Date', 'Number', 'String', 'Boolean', 'Math', 'undefined', 'NaN', 'Infinity']);
/** Calls a filter or sort condition may make; a node condition can express these. */
const CONDITION_FUNCTIONS = new Set(['Number', 'String', 'Boolean']);
const CONDITION_METHODS = new Set([
  'toLowerCase', 'toUpperCase', 'trim', 'includes', 'startsWith', 'endsWith', 'localeCompare', 'getTime'
]);

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

function propertyName(member: AstNode): string | undefined {
  if (member.type !== 'MemberExpression') return undefined;
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (member.property.type === 'Literal' && typeof member.property.value === 'string') return member.property.value;
  return undefined;
}

function keyName(property: AstNode): string | undefined {
  if (property.type !== 'Property') return undefined;
  return property.key?.name ?? property.key?.value;
}

function isIdentifier(node: AstNode | undefined, name: string): boolean {
  return node?.type === 'Identifier' && node.name === name;
}

/** a.b and { b: ... }: b is a property name, not a variable. */
function isPropertyName(node: AstNode, parent: AstNode | undefined): boolean {
  if (parent?.type === 'MemberExpression') return parent.property === node && !parent.computed;
  if (parent?.type === 'Property') return parent.key === node && !parent.computed;
  return false;
}

/** this.helpers or $helpers */
function isHelpers(node: AstNode): boolean {
  return propertyName(node) === 'helpers' || isIdentifier(node, '$helpers');
}

function isHttpRequestCall(node: AstNode): boolean {
  return node.type === 'CallExpression' && propertyName(node.callee) === 'httpRequest' && isHelpers(node.callee.object);
}

/** The identifier at the root of a.b.c(...).d */
function rootOf(node: AstNode | undefined): AstNode | undefined {
  let base = node;
  while (base && (base.type === 'MemberExpression' || base.type === 'CallExpression')) {
    base = base.type === 'MemberExpression' ? base.object : base.callee;
  }
  return base;
}

/**
 * `$input.all()` or `items`: this node's input items. Another node's items
 * (`$('Node').all()`) are not: a native node after this one only sees its input.
 */
function isItemsSource(node: AstNode | undefined): boolean {
  if (isIdentifier(node, 'items')) return true;
  return node?.type === 'CallExpression' && propertyName(node.callee) === 'all' && isIdentifier(node.callee.object, '$input');
}

/** The expression an arrow callback returns: its expression body or the argument of its one return. */
function callbackResult(callback: AstNode): AstNode | undefined {
  return callback.body.type === 'BlockStatement' ? callback.body.body[0]?.argument : callback.body;
}

/**
 * Return the native node that does the same job as this Code node, or undefined
 * when the code may need to be code.
 */
export function findNativeAlternative(jsCode: unknown, mode: unknown = 'runOnceForAllItems'): NativeAlternative | undefined {
  // Advice only: an unexpected syntax tree must never break validation
  try {
    return analyze(jsCode, mode === 'runOnceForEachItem' ? 'runOnceForEachItem' : 'runOnceForAllItems');
  } catch {
    return undefined;
  }
}

function analyze(jsCode: unknown, mode: CodeNodeMode): NativeAlternative | undefined {
  if (typeof jsCode !== 'string' || jsCode.trim() === '' || jsCode.length > MAX_CODE_CHARS) return undefined;

  // Lines that hold code: comments are not tokens, a multi-line string counts every line.
  // A syntax error throws and findNativeAlternative returns undefined.
  const codeLines = new Set<number>();
  const program = parse(jsCode, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    locations: true,
    onToken: (token) => {
      if (token.type.label === 'eof' || !token.loc) return;
      for (let line = token.loc.start.line; line <= token.loc.end.line; line++) codeLines.add(line);
    }
  }) as unknown as AstNode;
  if (codeLines.size > MAX_CODE_LINES) return undefined;

  const perItem = mode === 'runOnceForEachItem';
  let disqualified = false;
  const inits = new Map<string, AstNode>(); // variable -> its initializer
  const returns: AstNode[] = [];
  const methods = new Map<string, AstNode[]>(); // array method name -> call nodes
  let httpCalls = 0;
  let assignsItemField = false;

  walk(program, (node, parent) => {
    if (disqualified) return;
    if (DISQUALIFYING_NODE_TYPES.has(node.type)) { disqualified = true; return; }

    switch (node.type) {
      case 'Literal':
        if (node.regex) disqualified = true;
        break;
      case 'ThisExpression':
        // this.helpers.httpRequest is checked below; this.getNodeParameter() and the like need code
        if (!(parent?.type === 'MemberExpression' && propertyName(parent) === 'helpers')) disqualified = true;
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
        // { [key]: value } builds a field name at runtime; getters and methods are code
        if ((node.computed && node.key.type !== 'Literal') || node.kind !== 'init' || node.method) disqualified = true;
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
      case 'Identifier':
        if (DISQUALIFYING_IDENTIFIERS.has(node.name)) disqualified = true;
        break;
      case 'ReturnStatement':
        returns.push(node);
        break;
      case 'VariableDeclarator':
        if (node.id.type === 'Identifier' && node.init) inits.set(node.id.name, node.init);
        else disqualified = true; // destructuring, or a variable filled in later
        break;
      case 'AssignmentExpression':
        // Setting a field on the current item in per-item mode is what Edit Fields does;
        // any other assignment (another item, a variable, a global) is code
        if (perItem && node.operator === '=' && isCurrentItemField(node.left)) assignsItemField = true;
        else disqualified = true;
        break;
      case 'NewExpression':
        if (node.callee.type !== 'Identifier' || !ALLOWED_CONSTRUCTORS.has(node.callee.name)) disqualified = true;
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
        const callee = node.callee;
        if (callee.type === 'Identifier') {
          if (!ALLOWED_FUNCTIONS.has(callee.name)) disqualified = true;
          break;
        }
        const method = propertyName(callee);
        if (!method || !ALLOWED_METHODS.has(method)) { disqualified = true; break; }
        if (isHttpRequestCall(node)) { httpCalls++; break; }
        // Object.keys/entries/assign (dynamic keys) and any other helper need code
        const object = callee.object;
        if (isIdentifier(object, 'Object') || isHelpers(object)) { disqualified = true; break; }
        if (CALLBACK_METHODS.has(method)) methods.set(method, [...(methods.get(method) ?? []), node]);
        break;
      }
    }
  });

  if (disqualified || returns.length === 0) return undefined;
  if (reusesComputedVariable(program, inits)) return undefined;

  /**
   * Follow variables to their initializer and drop a trailing .flat(). A .slice()
   * is not dropped: it keeps some items, which a node after Sort or Filter
   * (Limit) would have to do.
   */
  const resolve = (node: AstNode | undefined, depth = 0): AstNode | undefined => {
    if (!node || depth > 5) return node;
    if (node.type === 'Identifier' && inits.has(node.name)) return resolve(inits.get(node.name), depth + 1);
    if (node.type === 'ChainExpression') return resolve(node.expression, depth + 1);
    if (node.type === 'CallExpression' && propertyName(node.callee) === 'flat') return resolve(node.callee.object, depth + 1);
    return node;
  };
  const isItems = (node: AstNode | undefined) => isItemsSource(resolve(node));
  /** The call's result is what the node returns as its items. */
  const returnedAsItems = (call: AstNode) => returns.some(ret => resolve(ret.argument) === call);
  const callsOnItems = (method: string) => (methods.get(method) ?? []).filter(call => isItems(call.callee.object));
  const result = (kind: NativeAlternativeKind, executeOnce = false): NativeAlternative =>
    ({ kind, ...ALTERNATIVES[kind], executeOnce });

  // What a node can return: one object (one item), a list of one object, or the
  // result of the array method that decides the suggestion. Anything else
  // (x || [...], list.concat(...), a ternary with null) changes the item count.
  const allCalls = new Set([...methods.values()].flat());
  const returnShapesOk = returns.every(ret => {
    const value = resolve(ret.argument);
    if (!value) return false;
    if (value.type === 'ObjectExpression') return true;
    if (value.type === 'ArrayExpression') return value.elements.length === 1 && value.elements[0]?.type === 'ObjectExpression';
    if (allCalls.has(value)) return true;
    // per-item mode: return $input.item after setting its fields
    return perItem && propertyName(value) === 'item' && isIdentifier(value.object, '$input');
  });
  if (!returnShapesOk) return undefined;

  if (httpCalls > 0) {
    // One request whose response is what the node returns; run once for all items,
    // it is one request
    const returnsResponse = returns.every(ret => isHttpResponse(unwrapItem(resolve(ret.argument), resolve)));
    return httpCalls === 1 && methods.size === 0 && returnsResponse ? result('httpRequest', !perItem) : undefined;
  }

  for (const call of callsOnItems('filter')) {
    const callback = call.arguments[0];
    if (!returnedAsItems(call) || callback?.type !== 'ArrowFunctionExpression') continue;
    // filter((item, index, all) => all.findIndex(...) === index) removes duplicates
    if (callback.params.length === 3) return isDedupeCallback(callback) ? result('removeDuplicates') : undefined;
    return callback.params.length === 1 && isSimpleCondition(callback) ? result('filter') : undefined;
  }
  for (const call of callsOnItems('sort')) {
    const callback = call.arguments[0];
    if (returnedAsItems(call) && callback?.params?.length === 2 && isSimpleCondition(callback)) return result('sort');
  }
  if (methods.has('sort') || methods.has('filter')) return undefined;

  if (methods.has('reduce')) {
    const calls = methods.get('reduce')!;
    const totals = calls.length === 1 && isItems(calls[0].callee.object) && usedAsFieldValue(calls[0]) &&
      isFieldTotal(calls[0]);
    return totals ? result('summarize') : undefined;
  }
  if (['find', 'some', 'every', 'findIndex', 'flatMap'].some(method => methods.has(method))) return undefined;

  if (methods.has('map')) {
    const calls = methods.get('map')!;
    if (calls.length !== 1) return undefined;
    const call = calls[0];
    const callback = call.arguments[0];
    if (callback?.type !== 'ArrowFunctionExpression') return undefined;
    // An index parameter (item, i) => ... numbers or pairs items: leave it to code
    if (callback.params.length > 1) return undefined;
    const mapped = callbackResult(callback);
    if (!mapped) return undefined;
    const returned = returnedAsItems(call);

    const param = callback.params[0]?.name;
    if (isItems(call.callee.object)) {
      // items.map(item => ({ json: {...} })) maps fields, one item per item
      if (returned) return buildsFields(mapped, resolve) ? result('editFields') : undefined;
      // items.map(...).join('\n') builds one text: Edit Fields run once
      if (isJoined(call, program)) return result('editFields', true);
      // A field (or fields) read from each item, collected into one item: Aggregate.
      // Computed values (price * qty) are not something Aggregate does.
      return usedAsFieldValue(call) && isProjection(mapped, param) ? result('aggregate') : undefined;
    }
    // A list field turned into items, each made of the row's own fields:
    // $json.rows.map(row => ({ json: { id: row.id } })). Run once for all items,
    // $json is the first item, so Split Out has to run once too.
    return mapped.type === 'ObjectExpression' && isProjection(mapped, param) && returned &&
      isInputField(resolve(call.callee.object))
      ? result('splitOut', !perItem)
      : undefined;
  }

  // No array methods: building fields from the input. Run once for all items, the
  // Code node returns one item, so Edit Fields has to run once too.
  const buildsObject = returns.some(ret => buildsFields(resolve(ret.argument), resolve));
  return buildsObject || assignsItemField ? result('editFields', !perItem) : undefined;

  /** The call's result is the value of a field in what the node returns. */
  function usedAsFieldValue(call: AstNode): boolean {
    let used = false;
    for (const ret of returns) {
      const value = resolve(ret.argument);
      if (!value) continue;
      walk(value, (node) => {
        if (node.type === 'Property' && resolve(node.value) === call) used = true;
      });
    }
    return used;
  }
}

/**
 * A filter or sort callback that reads only the item(s) it is given, with
 * operators and a few string, number and date calls: what a node condition or
 * sort key expresses. Reading another node or list ($('Sheet').all(), a local
 * array) does not count.
 */
function isSimpleCondition(callback: AstNode): boolean {
  const params = new Set(callback.params.map((param: AstNode) => param.name));
  let simple = true;
  walk(callback.body, (node, parent) => {
    if (!simple) return;
    if (node.type === 'Identifier' && !isPropertyName(node, parent)) {
      // $json here would be the first input item, not the one being tested
      if (!params.has(node.name) && !CALLBACK_GLOBALS.has(node.name)) simple = false;
    }
    if (node.type === 'ArrowFunctionExpression' || node.type === 'ArrayExpression' || node.type === 'ObjectExpression') simple = false;
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      if (callee.type === 'Identifier') {
        if (!CONDITION_FUNCTIONS.has(callee.name)) simple = false;
      } else if (propertyName(callee) === 'now' && isIdentifier(callee.object, 'Date')) {
        // Date.now()
      } else if (!CONDITION_METHODS.has(propertyName(callee) ?? '') || !params.has(rootOf(callee)?.name)) {
        simple = false;
      }
    }
  });
  return simple;
}

/** (item, index, all) => all.findIndex(other => ...) === index, or all.indexOf(item) === index */
function isDedupeCallback(callback: AstNode): boolean {
  const [item, index, all] = callback.params.map((param: AstNode) => param.name);
  const body = callbackResult(callback);
  if (body?.type !== 'BinaryExpression' || !['===', '=='].includes(body.operator)) return false;
  const sides = [body.left, body.right];
  const indexSide = sides.find(side => isIdentifier(side, index));
  const lookup = sides.find(side => side !== indexSide);
  if (!indexSide || lookup?.type !== 'CallExpression' || !isIdentifier(lookup.callee.object, all)) return false;
  const method = propertyName(lookup.callee);
  if (method === 'indexOf') return isIdentifier(lookup.arguments[0], item);
  if (method !== 'findIndex') return false;
  // The inner predicate says the two items have equal fields: other.json.id === item.json.id
  const inner = lookup.arguments[0];
  if (inner?.type !== 'ArrowFunctionExpression' || inner.params.length !== 1) return false;
  return isFieldEquality(callbackResult(inner), inner.params[0].name, item);
}

/** a.json.x === b.json.x, optionally joined with && for several fields */
function isFieldEquality(node: AstNode | undefined, a: string, b: string): boolean {
  if (!node) return false;
  if (node.type === 'LogicalExpression' && node.operator === '&&') {
    return isFieldEquality(node.left, a, b) && isFieldEquality(node.right, a, b);
  }
  if (node.type !== 'BinaryExpression' || !['===', '=='].includes(node.operator)) return false;
  const left = fieldPath(node.left);
  const right = fieldPath(node.right);
  if (!left || !right || left.path !== right.path || left.path === '') return false;
  return (left.root === a && right.root === b) || (left.root === b && right.root === a);
}

/** item.json.address.city -> { root: 'item', path: 'json.address.city' } */
function fieldPath(node: AstNode): { root: string; path: string } | undefined {
  const names: string[] = [];
  let current = node.type === 'ChainExpression' ? node.expression : node;
  while (current.type === 'MemberExpression') {
    const name = propertyName(current);
    if (name === undefined) return undefined;
    names.unshift(name);
    current = current.object;
  }
  return current.type === 'Identifier' ? { root: current.name, path: names.join('.') } : undefined;
}

/**
 * A value read straight from the callback's item, or an object of such values:
 * row.id, { id: row.id, name: row.name }, { json: row }.
 */
function isProjection(node: AstNode | undefined, param: string | undefined): boolean {
  if (!node || !param) return false;
  if (node.type === 'ChainExpression') return isProjection(node.expression, param);
  if (node.type === 'ObjectExpression') {
    return node.properties.length > 0 && node.properties.every((property: AstNode) =>
      property.type === 'Property' && !property.computed && (keyName(property) === 'pairedItem' || isProjection(property.value, param)));
  }
  return fieldPath(node)?.root === param;
}

/** { json: X } or [{ json: X }] -> X */
function unwrapItem(node: AstNode | undefined, resolve: (node: AstNode | undefined) => AstNode | undefined): AstNode | undefined {
  let value = node;
  if (value?.type === 'ArrayExpression' && value.elements.length === 1) value = resolve(value.elements[0]);
  if (value?.type === 'ObjectExpression' && value.properties.length === 1 && keyName(value.properties[0]) === 'json') {
    value = resolve(value.properties[0].value);
  }
  return value;
}

/** await this.helpers.httpRequest(...) */
function isHttpResponse(node: AstNode | undefined): boolean {
  return node?.type === 'AwaitExpression' && isHttpRequestCall(node.argument);
}

/** items.reduce((sum, item) => sum + item.json.amount, 0): a field totalled from 0 */
function isFieldTotal(call: AstNode): boolean {
  const [callback, initial] = call.arguments;
  if (callback?.type !== 'ArrowFunctionExpression' || callback.params.length !== 2) return false;
  if (initial?.type !== 'Literal' || (initial.value !== 0 && initial.value !== '')) return false;
  const body = callbackResult(callback);
  if (body?.type !== 'BinaryExpression' || body.operator !== '+' || !isIdentifier(body.left, callback.params[0].name)) return false;
  // The added value is a plain field of the item: item.json.amount
  let field = body.right;
  if (field.type !== 'MemberExpression') return false;
  while (field.type === 'MemberExpression' && !field.computed) field = field.object;
  return isIdentifier(field, callback.params[1].name);
}

/**
 * Whether a returned value builds fields: an object literal other than a bare
 * `{ json: <existing value> }` wrapper or a lone spread, which only pass an item
 * through. `pairedItem` is item linking, not a field.
 */
function buildsFields(node: AstNode | undefined, resolve: (node: AstNode | undefined) => AstNode | undefined): boolean {
  if (!node) return false;
  if (node.type === 'ArrayExpression') return node.elements.some((element: AstNode) => buildsFields(element, resolve));
  if (node.type !== 'ObjectExpression') return false;
  const properties = node.properties.filter((property: AstNode) => keyName(property) !== 'pairedItem');
  if (properties.length === 0) return false;
  if (properties.every((property: AstNode) => property.type === 'SpreadElement')) return false;
  if (properties.length === 1 && keyName(properties[0]) === 'json') return buildsFields(resolve(properties[0].value), resolve);
  return true;
}

/** $json, item.json, $input.item.json or $input.first().json: the current input item. */
function isCurrentItemJson(node: AstNode): boolean {
  if (node.type === 'Identifier') return node.name === '$json';
  if (propertyName(node) !== 'json') return false;
  const owner = node.object;
  if (owner.type === 'Identifier') return true; // a callback parameter or an item variable
  if (propertyName(owner) === 'item' && isIdentifier(owner.object, '$input')) return true;
  return owner.type === 'CallExpression' && propertyName(owner.callee) === 'first' && isIdentifier(owner.callee.object, '$input');
}

/** $json.field or $input.item.json.field (also nested): a field of the item a per-item run handles. */
function isCurrentItemField(node: AstNode): boolean {
  if (node.type !== 'MemberExpression') return false;
  let owner: AstNode = node.object;
  while (owner.type === 'MemberExpression' && !(propertyName(owner) === 'json' && isInputItem(owner.object))) {
    owner = owner.object;
  }
  return isIdentifier(owner, '$json') || (propertyName(owner) === 'json' && isInputItem(owner.object));
}

function isInputItem(node: AstNode): boolean {
  return propertyName(node) === 'item' && isIdentifier(node.object, '$input');
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
  const computed = new Set<string>();
  for (const [name, init] of inits) if (COMPUTED_INITIALIZERS.has(init.type)) computed.add(name);
  if (computed.size === 0) return false;
  const uses = new Map<string, number>();
  walk(program, (node, parent) => {
    if (node.type !== 'Identifier' || !computed.has(node.name)) return;
    if (parent?.type === 'VariableDeclarator' && parent.id === node) return;
    // A shorthand { total } still counts: acorn gives its value a node of its own
    if (isPropertyName(node, parent)) return;
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
  const base = rootOf(node);
  return base?.type === 'Identifier' && ['$json', '$input', 'items'].includes(base.name);
}
