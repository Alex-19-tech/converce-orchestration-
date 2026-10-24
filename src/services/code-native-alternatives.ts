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
   * A condition on the data the native node needs to match the code, when the
   * code doesn't show it (field types): "the field holds numbers".
   */
  when?: string;
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
  // The Sort node compares raw values; a - b also orders numeric strings by value
  sort: { node: 'Sort', nodeType: 'n8n-nodes-base.sort', does: 'sorts items by a field', when: 'the field holds numbers' },
  // Remove Duplicates compares values; === compares objects and lists by reference
  removeDuplicates: { node: 'Remove Duplicates', nodeType: 'n8n-nodes-base.removeDuplicates', does: 'removes duplicate items', when: 'the compared fields hold text or numbers' },
  // Summarize adds numbers; + also joins strings
  summarize: { node: 'Summarize', nodeType: 'n8n-nodes-base.summarize', does: 'totals a field over the items', when: 'the field holds numbers' },
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
  ...CALLBACK_METHODS, 'join', 'slice', 'flat', 'includes', 'indexOf',
  // strings
  'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'substring', 'substr',
  'padStart', 'padEnd', 'startsWith', 'endsWith', 'charAt', 'lastIndexOf', 'toString', 'fromCharCode', 'localeCompare',
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
  // An omitted mode is n8n's default; an expression ({{ ... }}) or unknown value leaves
  // the mode unknown, and the suggestion depends on it
  const knownMode = mode === undefined || mode === null ? 'runOnceForAllItems' : mode;
  if (knownMode !== 'runOnceForAllItems' && knownMode !== 'runOnceForEachItem') return undefined;
  // Advice only: an unexpected syntax tree must never break validation
  try {
    return analyze(jsCode, knownMode);
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
        // $input passed around (const inp = $input, { input: $input }) hides which items are read
        if (node.name === '$input' && !isPropertyName(node, parent) && !(parent?.type === 'MemberExpression' && parent.object === node)) {
          disqualified = true;
        }
        break;
      case 'ReturnStatement':
        returns.push(node);
        break;
      case 'VariableDeclarator':
        // Destructuring, a variable filled in later, or one that hides a global or
        // n8n name (const String = ...) needs code
        // A name declared twice (block scopes) would be resolved wrongly below
        if (node.id.type === 'Identifier' && node.init && !isReservedName(node.id.name) && !inits.has(node.id.name)) {
          inits.set(node.id.name, node.init);
        } else {
          disqualified = true;
        }
        break;
      case 'ExpressionStatement':
        // A statement is either a field assignment (checked below) or a call for its
        // side effect (list.reverse(), $execution.customData.set(...)), which is code
        if (node.expression.type !== 'AssignmentExpression') disqualified = true;
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
        if (!isCallback || !simpleBody || node.async ||
            node.params.some((p: AstNode) => p.type !== 'Identifier' || isReservedName(p.name))) {
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

  // A local `items` that holds anything but $input.all() would be mistaken for the input
  if (disqualified || (inits.has('items') && !isItemsSource(inits.get('items')))) return undefined;
  // The node's own returns; a callback's return is its result (see callbackResult)
  const callbacks = [...methods.values()].flat().map(call => call.arguments[0]).filter(Boolean);
  const nodeReturns = returns.filter(ret => !callbacks.some(callback => contains(callback, ret)));
  returns.length = 0;
  returns.push(...nodeReturns);
  // Without branching, only the first return runs; a second one is dead code
  if (returns.length !== 1) return undefined;
  if (reusesComputedVariable(program, inits) || sharesChangingValue(program, inits)) return undefined;

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
  const readsWholeInput = readsBeyondFirstItem(program, inits);
  // With "Execute Once" n8n hands the node only the first input item, so a suggestion
  // that needs it cannot stand in for code that reads the other items too.
  const result = (kind: NativeAlternativeKind, executeOnce = false): NativeAlternative | undefined =>
    executeOnce && readsWholeInput ? undefined : { kind, ...ALTERNATIVES[kind], executeOnce };

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

  // Returned or mapped items with { json, pairedItem } link outputs to chosen inputs,
  // which a node would undo. (A pairedItem field inside json is ordinary data.)
  const itemObjects = [
    ...returns.flatMap(ret => {
      const value = resolve(ret.argument);
      return value?.type === 'ArrayExpression' ? value.elements : [value];
    }),
    ...(methods.get('map') ?? []).map(call => call.arguments[0]?.type === 'ArrowFunctionExpression'
      ? callbackResult(call.arguments[0]) : undefined)
  ];
  // ...and items that build binary data ({ json, binary: { ... } }) need code
  if (itemObjects.some(item => isPairedItem(item) || hasBinaryOutput(item))) return undefined;

  if (httpCalls > 0) {
    // One request whose response is what the node returns; run once for all items,
    // it is one request
    const returnsResponse = returns.every(ret => isHttpResponse(unwrapItem(resolve(ret.argument), resolve)));
    return httpCalls === 1 && methods.size === 0 && returnsResponse ? result('httpRequest', !perItem) : undefined;
  }

  /** Array-method calls other than `call` and the calls inside its callback */
  const otherCalls = (call: AstNode) => [...allCalls].filter(other => other !== call && !contains(call.arguments[0], other));

  for (const call of callsOnItems('filter')) {
    const callback = call.arguments[0];
    if (!returnedAsItems(call) || callback?.type !== 'ArrowFunctionExpression') continue;
    // Another list call (const ignored = $json.tags.sort()) would be lost
    if (otherCalls(call).length > 0) return undefined;
    // filter((item, index, all) => all.findIndex(...) === index) removes duplicates
    if (callback.params.length === 3) return isDedupeCallback(callback) ? result('removeDuplicates') : undefined;
    return callback.params.length === 1 && isSimpleCondition(callback) ? result('filter') : undefined;
  }
  for (const call of callsOnItems('sort')) {
    if (otherCalls(call).length > 0) return undefined;
    if (returnedAsItems(call) && isSortKeyComparator(call.arguments[0])) return result('sort');
  }
  if (methods.has('sort') || methods.has('filter')) return undefined;

  if (methods.has('reduce')) {
    const calls = methods.get('reduce')!;
    // The total must be the only list call: reduce plus map or find is more than Summarize does
    const totals = calls.length === 1 && otherCalls(calls[0]).length === 0 && isItems(calls[0].callee.object) &&
      usedAsFieldValue(calls[0]) && isFieldTotal(calls[0]);
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
      // items.map(item => ({ json: {...} })) maps fields, one item per item; a callback
      // that returns a list (item => [a, b]) makes several items per item
      if (returned) return mapped.type === 'ObjectExpression' && buildsFields(mapped, resolve) ? result('editFields') : undefined;
      // items.map(...).join('\n') builds one text: Edit Fields run once
      if (isJoined(call, program)) return result('editFields', true);
      // One field of each item (item.json.id) or each item's data (item.json), collected
      // into a field of one item: what Aggregate does. A computed value, or an object
      // of several fields, needs another node first.
      return usedAsFieldValue(call) && isAggregatedValue(mapped, param) ? result('aggregate') : undefined;
    }
    // A list field turned into items, each row as it is: $json.rows.map(row => ({ json: row })).
    // Run once for all items, $json is the first item, so Split Out has to run once too.
    return isWholeRowItem(mapped, param) && returned && isInputField(resolve(call.callee.object))
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

/**
 * A comparator that orders by one data field: (a, b) => a.json.x - b.json.x, or b - a
 * for descending. The Sort node compares the raw values (strings lowercased), so
 * localeCompare, new Date(...) or Number(...) comparators can order differently, and
 * a - b matches it only for numbers (see the `when` condition).
 */
function isSortKeyComparator(callback: AstNode | undefined): boolean {
  if (callback?.type !== 'ArrowFunctionExpression' || callback.params.length !== 2) return false;
  const [a, b] = callback.params.map((param: AstNode) => param.name);
  const body = callbackResult(callback);
  if (body?.type !== 'BinaryExpression' || body.operator !== '-') return false;
  const left = fieldPath(body.left);
  const right = fieldPath(body.right);
  return left !== undefined && right !== undefined && isDataPath(left.segments) &&
    JSON.stringify(left.segments) === JSON.stringify(right.segments) &&
    ((left.root === a && right.root === b) || (left.root === b && right.root === a));
}

/** json.<field>...: a data field of an item, not item metadata (pairedItem, binary) */
function isDataPath(segments: string[]): boolean {
  return segments.length >= 2 && segments[0] === 'json';
}

/**
 * (item, index, all) => all.findIndex(other => other.json.id === item.json.id) === index.
 * all.indexOf(item) compares item objects, which are all distinct, so it removes nothing.
 */
function isDedupeCallback(callback: AstNode): boolean {
  const [item, index, all] = callback.params.map((param: AstNode) => param.name);
  const body = callbackResult(callback);
  if (body?.type !== 'BinaryExpression' || !['===', '=='].includes(body.operator)) return false;
  const sides = [body.left, body.right];
  const indexSide = sides.find(side => isIdentifier(side, index));
  const lookup = sides.find(side => side !== indexSide);
  if (!indexSide || lookup?.type !== 'CallExpression' || !isIdentifier(lookup.callee.object, all)) return false;
  if (propertyName(lookup.callee) !== 'findIndex') return false;
  // The inner predicate says the two items have equal fields: other.json.id === item.json.id
  const inner = lookup.arguments[0];
  if (inner?.type !== 'ArrowFunctionExpression' || inner.params.length !== 1) return false;
  // all.findIndex(item => item.json.id === item.json.id) compares an item with itself
  const other = inner.params[0].name;
  if ([item, index, all].includes(other)) return false;
  return isFieldEquality(callbackResult(inner), other, item);
}

/**
 * Whether the code reads input items past the first: $input.all() or items used as a
 * list, or $input.last(). items[0], $input.first(), $json and other nodes' items are
 * all still there when the node runs once.
 */
function readsBeyondFirstItem(program: AstNode, inits: Map<string, AstNode>): boolean {
  // Variables holding the input list, directly or through other variables
  const aliases = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, init] of inits) {
      if (aliases.has(name)) continue;
      if (isItemsSource(init) || (init.type === 'Identifier' && aliases.has(init.name))) {
        aliases.add(name);
        changed = true;
      }
    }
  }
  let reads = false;
  walk(program, (node, parent) => {
    if (reads) return;
    // $input.last(), or $items() without a literal node name: this node's input items
    if (node.type === 'CallExpression' && ((propertyName(node.callee) === 'last' && isIdentifier(node.callee.object, '$input')) ||
        (isIdentifier(node.callee, '$items') && typeof node.arguments[0]?.value !== 'string'))) {
      reads = true;
      return;
    }
    const isList = isItemsSource(node) || (node.type === 'Identifier' && aliases.has(node.name));
    if (!isList || isPropertyName(node, parent)) return;
    // const items = $input.all() is checked through its uses
    if (parent?.type === 'VariableDeclarator' && parent.init === node) return;
    if (parent?.type === 'VariableDeclarator' && parent.id === node) return;
    // items[0]: the first item
    const firstItem = parent?.type === 'MemberExpression' && parent.object === node && parent.computed &&
      parent.property.type === 'Literal' && parent.property.value === 0;
    if (!firstItem) reads = true;
  });
  return reads;
}

/** Whether `node` is `target` or contains it */
function contains(node: AstNode | undefined, target: AstNode): boolean {
  if (!node) return false;
  let found = false;
  walk(node, (child) => { if (child === target) found = true; });
  return found;
}

/** An item object with a binary property */
function hasBinaryOutput(node: AstNode | undefined): boolean {
  return node?.type === 'ObjectExpression' && node.properties.some((property: AstNode) => keyName(property) === 'binary');
}

/** { json: ..., pairedItem: ... } */
function isPairedItem(node: AstNode | undefined): boolean {
  if (node?.type !== 'ObjectExpression') return false;
  const keys = node.properties.map(keyName);
  return keys.includes('json') && keys.includes('pairedItem');
}

/** item.json.id or item.json: one field, or the whole data, of the callback's item */
function isAggregatedValue(node: AstNode, param: string | undefined): boolean {
  const path = fieldPath(node);
  return path !== undefined && path.root === param && path.segments.length >= 1 && path.segments[0] === 'json';
}

/** { json: row } */
function isWholeRowItem(node: AstNode, param: string | undefined): boolean {
  return node.type === 'ObjectExpression' && node.properties.length === 1 && keyName(node.properties[0]) === 'json' &&
    !node.properties[0].computed && isIdentifier(node.properties[0].value, param ?? '');
}

/** a.json.x === b.json.x, optionally joined with && for several fields */
function isFieldEquality(node: AstNode | undefined, a: string, b: string): boolean {
  if (!node) return false;
  if (node.type === 'LogicalExpression' && node.operator === '&&') {
    return isFieldEquality(node.left, a, b) && isFieldEquality(node.right, a, b);
  }
  // == coerces (0 == '' == '0' is not transitive); Remove Duplicates compares values
  if (node.type !== 'BinaryExpression' || node.operator !== '===') return false;
  const left = fieldPath(node.left);
  const right = fieldPath(node.right);
  // A data field under json (other.json === item.json compares objects, not data), and
  // segment lists compared as lists: item.json['a.b'] is not item.json.a.b
  if (!left || !right || !isDataPath(left.segments) ||
      JSON.stringify(left.segments) !== JSON.stringify(right.segments)) return false;
  return (left.root === a && right.root === b) || (left.root === b && right.root === a);
}

/** item.json.address.city -> { root: 'item', segments: ['json', 'address', 'city'] } */
function fieldPath(node: AstNode): { root: string; segments: string[] } | undefined {
  const segments: string[] = [];
  let current = node.type === 'ChainExpression' ? node.expression : node;
  while (current.type === 'MemberExpression') {
    const name = propertyName(current);
    if (name === undefined) return undefined;
    segments.unshift(name);
    current = current.object;
  }
  return current.type === 'Identifier' ? { root: current.name, segments } : undefined;
}

/** A name a variable or parameter must not hide: a global the analysis trusts, or an n8n $-name. */
function isReservedName(name: string): boolean {
  return name.startsWith('$') || ALLOWED_FUNCTIONS.has(name) || CALLBACK_GLOBALS.has(name) ||
    ['JSON', 'Object'].includes(name);
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

/** items.reduce((sum, item) => sum + item.json.amount, 0): a data field totalled from 0 */
function isFieldTotal(call: AstNode): boolean {
  const [callback, initial] = call.arguments;
  if (callback?.type !== 'ArrowFunctionExpression' || callback.params.length !== 2) return false;
  // Starting from '' would join text, not total numbers
  if (initial?.type !== 'Literal' || initial.value !== 0) return false;
  const body = callbackResult(callback);
  if (body?.type !== 'BinaryExpression' || body.operator !== '+' || !isIdentifier(body.left, callback.params[0].name)) return false;
  const field = fieldPath(body.right);
  return field !== undefined && field.root === callback.params[1].name && isDataPath(field.segments);
}

/**
 * Whether a returned value builds fields: an object literal other than a bare
 * `{ json: <existing value> }` wrapper or a lone spread, which only pass an item
 * through.
 */
function buildsFields(node: AstNode | undefined, resolve: (node: AstNode | undefined) => AstNode | undefined): boolean {
  if (!node) return false;
  if (node.type === 'ArrayExpression') return node.elements.some((element: AstNode) => buildsFields(element, resolve));
  if (node.type !== 'ObjectExpression') return false;
  const properties = node.properties;
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
  for (const [name, init] of inits) {
    // Math?.random() is a ChainExpression around the call
    const value = init.type === 'ChainExpression' ? init.expression : init;
    if (COMPUTED_INITIALIZERS.has(value.type)) computed.add(name);
  }
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
 * Math.random(), Date.now(), DateTime.now(), new Date() or $now: a new value on each
 * evaluation. So is anything built from a variable in `changing`.
 */
function isChangingValue(node: AstNode, changing: Set<string>): boolean {
  let found = false;
  walk(node, (child, parent) => {
    if (child.type === 'Identifier' && (child.name === '$now' || changing.has(child.name)) && !isPropertyName(child, parent)) found = true;
    if (child.type === 'CallExpression' && ['random', 'now'].includes(propertyName(child.callee) ?? '')) found = true;
    if (child.type === 'NewExpression' && child.arguments.length === 0) found = true;
  });
  return found;
}

/**
 * const batchId = Math.random(); items.map(item => ({ json: { ...item.json, batchId } })):
 * the code gives every item the same value, where a node field evaluates it per item.
 */
function sharesChangingValue(program: AstNode, inits: Map<string, AstNode>): boolean {
  // Variables holding such a value, directly or through other variables
  const changing = new Set<string>();
  for (let added = true; added;) {
    added = false;
    for (const [name, init] of inits) {
      if (changing.has(name)) continue;
      if (isChangingValue(init, changing)) {
        changing.add(name);
        added = true;
      }
    }
  }
  if (changing.size === 0) return false;
  const callbacks: AstNode[] = [];
  walk(program, (node) => { if (node.type === 'ArrowFunctionExpression') callbacks.push(node); });
  let shared = false;
  walk(program, (node, parent) => {
    if (shared || node.type !== 'Identifier' || !changing.has(node.name) || isPropertyName(node, parent)) return;
    if (callbacks.some(callback => contains(callback, node))) shared = true;
  });
  return shared;
}

/**
 * A list field of the first input item (or, per item, of the current one):
 * $json.rows, $input.first().json.rows, $input.item.json.rows, items[0].json.rows.
 * Split Out only sees its input, and with Execute Once only the first item, so a
 * list of another node or of another item does not count.
 */
function isInputField(node: AstNode | undefined): boolean {
  if (node?.type !== 'MemberExpression') return false;
  if (isIdentifier(rootOf(node), '$json')) return true;
  // Find the .json read straight off an item accessor; a field named json deeper down is data
  for (let current: AstNode = node; current.type === 'MemberExpression'; current = current.object) {
    if (current !== node && propertyName(current) === 'json' && isFirstOrCurrentItem(current.object)) return true;
  }
  return false;
}

/** $input.item, $input.first(), items[0] or $input.all()[0] */
function isFirstOrCurrentItem(node: AstNode): boolean {
  if (isInputItem(node)) return true;
  if (node.type === 'CallExpression' && propertyName(node.callee) === 'first' && isIdentifier(node.callee.object, '$input')) return true;
  return node.type === 'MemberExpression' && node.computed && node.property.type === 'Literal' && node.property.value === 0 &&
    isItemsSource(node.object);
}
