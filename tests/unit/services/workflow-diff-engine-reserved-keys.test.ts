import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkflowDiffEngine } from '@/services/workflow-diff-engine';
import type { WorkflowDiffOperation } from '@/types/workflow-diff';
import type { Workflow } from '@/types/n8n-api';

const RESERVED = ['__proto__', 'constructor', 'prototype'];

function node(id: string, name: string) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position: [0, 0] as [number, number],
    parameters: {}
  };
}

function buildWorkflow(extraNodes: ReturnType<typeof node>[] = []): Workflow {
  return {
    id: 'wf-1',
    name: 'Reserved keys',
    nodes: [node('a', 'A'), node('b', 'B'), node('c', 'C'), ...extraNodes],
    connections: {
      A: { main: [[{ node: 'B', type: 'main', index: 0 }]] }
    },
    settings: {}
  } as unknown as Workflow;
}

// Built-in objects a connection-map key could resolve to, by label.
function watchedObjects(): Map<string, object> {
  const watched = new Map<string, object>([
    ['Object.prototype', Object.prototype],
    ['Object', Object],
    ['Function.prototype', Function.prototype],
    ['Array.prototype', Array.prototype]
  ]);
  for (const [label, owner] of [['Object.prototype', Object.prototype], ['Array.prototype', Array.prototype]] as const) {
    for (const name of Object.getOwnPropertyNames(owner)) {
      const value = Object.getOwnPropertyDescriptor(owner, name)?.value;
      if (typeof value === 'function') watched.set(`${label}.${name}`, value);
    }
  }
  return watched;
}

function globalKeys(): string[] {
  const keys: string[] = [];
  for (const [label, target] of watchedObjects()) {
    for (const name of Object.getOwnPropertyNames(target)) keys.push(`${label}\u0000${name}`);
  }
  return keys.sort();
}

describe('WorkflowDiffEngine reserved connection keys', () => {
  let engine: WorkflowDiffEngine;
  let before: string[];

  beforeEach(() => {
    engine = new WorkflowDiffEngine();
    before = globalKeys();
  });

  afterEach(() => {
    const added = globalKeys().filter(k => !before.includes(k));
    const watched = watchedObjects();
    for (const key of added) {
      const [label, name] = key.split('\u0000');
      delete (watched.get(label) as any)[name];
    }
    expect(added).toEqual([]);
  });

  async function apply(operations: WorkflowDiffOperation[], workflow = buildWorkflow(), validateOnly = false) {
    return engine.applyDiff(workflow, { id: 'wf-1', operations, validateOnly } as any);
  }

  describe.each(RESERVED)('key %s', (key) => {
    it('rejects it as an addConnection sourceOutput', async () => {
      const result = await apply([{ type: 'addConnection', source: 'B', target: 'C', sourceOutput: key } as any]);
      expect(result.success).toBe(false);
      expect(result.errors![0].message).toContain('reserved');
    });

    it('rejects it as an addConnection sourceOutput in validateOnly mode', async () => {
      const result = await apply([{ type: 'addConnection', source: 'B', target: 'C', sourceOutput: key } as any], buildWorkflow(), true);
      expect(result.success).toBe(false);
    });

    it('rejects it as an addConnection targetInput', async () => {
      const result = await apply([{ type: 'addConnection', source: 'B', target: 'C', targetInput: key } as any]);
      expect(result.success).toBe(false);
      expect(result.errors![0].message).toContain('reserved');
    });

    it('rejects it as a removeConnection or rewireConnection sourceOutput', async () => {
      const remove = await apply([{ type: 'removeConnection', source: 'A', target: 'B', sourceOutput: key, ignoreErrors: true } as any]);
      expect(remove.success).toBe(false);
      expect(remove.errors![0].message).toContain('reserved');
      const rewire = await apply([{ type: 'rewireConnection', source: 'A', from: 'B', to: 'C', sourceOutput: key } as any]);
      expect(rewire.success).toBe(false);
      expect(rewire.errors![0].message).toContain('reserved');
    });

    it('rejects it as a new node name', async () => {
      const result = await apply([{ type: 'addNode', node: { name: key, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, 0], parameters: {} } } as any]);
      expect(result.success).toBe(false);
      expect(result.errors![0].message).toContain('reserved');
    });

    it('rejects a rename to it', async () => {
      const result = await apply([{ type: 'updateNode', nodeName: 'B', updates: { name: key } } as any]);
      expect(result.success).toBe(false);
      expect(result.errors![0].message).toContain('reserved');
    });

    it('rejects connections from an existing node with that name', async () => {
      const workflow = buildWorkflow([node('r', key)]);
      const result = await apply([{ type: 'addConnection', source: 'r', target: 'C' } as any], workflow);
      expect(result.success).toBe(false);
      expect(result.errors![0].message).toContain('reserved');
    });

    it('rejects it as a key in replaceConnections', async () => {
      const connections = JSON.parse(`{"A": {"${key}": [[{"node": "B", "type": "main", "index": 0}]]}}`);
      const result = await apply([{ type: 'replaceConnections', connections } as any]);
      expect(result.success).toBe(false);
      expect(result.errors![0].message).toContain('reserved');
    });
  });

  describe('names inherited from Object.prototype', () => {
    it('stores a connection from a node named toString on the workflow', async () => {
      const workflow = buildWorkflow([node('t', 'toString')]);
      const result = await apply([{ type: 'addConnection', source: 'toString', target: 'C' }], workflow);
      expect(result.success).toBe(true);
      const conns = result.workflow!.connections;
      expect(Object.prototype.hasOwnProperty.call(conns, 'toString')).toBe(true);
      expect(conns.toString.main[0]).toEqual([{ node: 'C', type: 'main', index: 0 }]);
    });

    it('stores a connection on an output named valueOf on the workflow', async () => {
      const result = await apply([{ type: 'addConnection', source: 'B', target: 'C', sourceOutput: 'valueOf' } as any]);
      expect(result.success).toBe(true);
      const outputs = result.workflow!.connections.B;
      expect(Object.prototype.hasOwnProperty.call(outputs, 'valueOf')).toBe(true);
      expect(outputs.valueOf[0]).toEqual([{ node: 'C', type: 'valueOf', index: 0 }]);
    });

    it('reports a missing connection on an output named hasOwnProperty', async () => {
      const result = await apply([{ type: 'removeConnection', source: 'A', target: 'B', sourceOutput: 'hasOwnProperty' } as any]);
      expect(result.success).toBe(false);
      expect(result.errors![0].message).not.toContain('Diff engine error');
    });

    it('reports a missing rewire source on an output named toString', async () => {
      const result = await apply([{ type: 'rewireConnection', source: 'A', from: 'B', to: 'C', sourceOutput: 'toString' } as any]);
      expect(result.success).toBe(false);
      expect(result.errors![0].message).toBe('No connections found from "A" on output "toString"');
    });

    it.each(['__proto__', 'length', -1, 1.5])('rejects sourceIndex %j', async (sourceIndex) => {
      const result = await apply([{ type: 'addConnection', source: 'B', target: 'C', sourceIndex } as any]);
      expect(result.success).toBe(false);
      expect(result.errors![0].message).toContain('sourceIndex');
    });

    it('keeps connections from same-named nodes in separate workflows apart', async () => {
      await apply([{ type: 'addConnection', source: 'valueOf', target: 'C' }], buildWorkflow([node('v', 'valueOf')]));
      const result = await apply([{ type: 'addConnection', source: 'valueOf', target: 'A' }], buildWorkflow([node('v', 'valueOf')]));
      expect(result.success).toBe(true);
      expect(result.workflow!.connections.valueOf).toEqual({ main: [[{ node: 'A', type: 'main', index: 0 }]] });
    });
  });

  describe('workflows fetched with unusual keys', () => {
    it('keeps an own __proto__ connection key as data when another node is renamed', async () => {
      const workflow = buildWorkflow([node('r', '__proto__')]);
      workflow.connections = JSON.parse('{"__proto__": {"main": [[{"node": "C", "type": "main", "index": 0}]]}}');
      const result = await apply([{ type: 'updateNode', nodeName: 'B', updates: { name: 'B2' } } as any], workflow);
      expect(result.success).toBe(true);
      const conns = result.workflow!.connections;
      expect(Object.getPrototypeOf(conns)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(conns, '__proto__')).toBe(true);
    });

    it('rejects connections from a node whose name is not a string', async () => {
      const workflow = buildWorkflow([{ ...node('p', 'x'), name: ['__proto__'] as any }]);
      const result = await apply([{ type: 'addConnection', source: 'p', target: 'C' } as any], workflow);
      expect(result.success).toBe(false);
      expect(Object.getPrototypeOf(workflow.connections)).toBe(Object.prototype);
    });
  });
});
