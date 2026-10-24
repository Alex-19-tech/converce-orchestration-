import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowValidator } from '@/services/workflow-validator';

vi.mock('@/utils/logger');

const conn = (node: string) => ({ node, type: 'main', index: 0 });
const node = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  id: name, name, type, typeVersion: 1, position: [0, 0], parameters: {}, ...extra
});

describe('WorkflowValidator - large workflows', () => {
  let validator: WorkflowValidator;
  let nodeInfo: (type: string) => unknown;
  let mockNodeValidator: any;

  beforeEach(() => {
    nodeInfo = () => null;
    const mockNodeRepository: any = { getNode: (type: string) => nodeInfo(type) };
    mockNodeValidator = { validateWithMode: vi.fn().mockReturnValue({ errors: [], warnings: [] }) };
    validator = new WorkflowValidator(mockNodeRepository, mockNodeValidator);
  });

  describe('trigger reachability', () => {
    it('handles many triggers with the same name feeding many nodes', async () => {
      const count = 20_000;
      const nodes: any[] = Array.from({ length: count }, () => node('Trigger', 'n8n-nodes-base.manualTrigger'));
      for (let k = 0; k < count; k++) nodes.push(node(`Step ${k}`, 'n8n-nodes-base.noOp'));
      nodes.push(node('Detached', 'n8n-nodes-base.noOp'));
      const connections: any = { Trigger: { main: [Array.from({ length: count }, (_, k) => conn(`Step ${k}`))] } };

      const start = performance.now();
      const result = await validator.validateWorkflow({ name: 'Triggers', nodes, connections } as any, { validateNodes: false });
      expect(performance.now() - start).toBeLessThan(2_000);
      const unreachable = result.warnings.filter((w: any) => w.message === 'Node is not reachable from any trigger node');
      expect(unreachable.map((w: any) => w.nodeName)).toEqual(['Detached']);
    });
  });

  describe('cycle detection', () => {
    // A chain from Start; nodes from `backFrom` on also connect back to Start
    const buildChain = (length: number, backFrom: number, backEdges: number, exitAt: number) => {
      const nodes: any[] = [];
      const back = conn('Start');
      const connections: any = {};
      for (let i = 0; i <= length; i++) {
        const name = i === 0 ? 'Start' : `Step ${i}`;
        nodes.push(node(name, 'n8n-nodes-base.noOp', i === exitAt ? { onError: 'continueErrorOutput' } : {}));
        const next = i < length ? [conn(`Step ${i + 1}`)] : [];
        connections[name] = { main: [[...next, ...(i >= backFrom ? Array(backEdges).fill(back) : [])]] };
      }
      return { name: 'Chain', nodes, connections };
    };
    const cycleWarning = (result: any) =>
      result.warnings.some((w: any) => w.message.includes('cycle with no recognized exit'));

    it('handles a long chain with many connections back to its first node', async () => {
      const workflow = buildChain(3000, 1500, 25, 1500);
      const start = performance.now();
      const result = await validator.validateWorkflow(workflow as any, { validateNodes: false, validateExpressions: false });
      expect(performance.now() - start).toBeLessThan(2_000);
      expect(cycleWarning(result)).toBe(false);
    });

    it('reports a cycle when no node on it can exit', async () => {
      const withExit = await validator.validateWorkflow(buildChain(50, 10, 2, 5) as any, { validateNodes: false });
      const exitAfterFirstBackEdge = await validator.validateWorkflow(buildChain(50, 10, 2, 20) as any, { validateNodes: false });
      const withoutExit = await validator.validateWorkflow(buildChain(50, 10, 2, -1) as any, { validateNodes: false });
      expect(cycleWarning(withExit)).toBe(false);
      expect(cycleWarning(exitAfterFirstBackEdge)).toBe(true);
      expect(cycleWarning(withoutExit)).toBe(true);
    });

    it('evaluates the exit over the cycle only, not the path before it', async () => {
      // Exit-capable node sits before the cycle: Gate -> A -> B -> A
      const workflow = {
        name: 'Prefix exit',
        nodes: [
          node('Gate', 'n8n-nodes-base.noOp', { onError: 'continueErrorOutput' }),
          node('A', 'n8n-nodes-base.noOp'),
          node('B', 'n8n-nodes-base.noOp')
        ],
        connections: { Gate: { main: [[conn('A')]] }, A: { main: [[conn('B')]] }, B: { main: [[conn('A')]] } }
      };
      const result = await validator.validateWorkflow(workflow as any, { validateNodes: false });
      expect(cycleWarning(result)).toBe(true);
    });
  });

  describe('condition node errors', () => {
    const ifNode = (name: string) => node(name, 'n8n-nodes-base.if', {
      typeVersion: 2,
      parameters: { conditions: { conditions: [{ leftValue: 'a', rightValue: 'b', operator: { type: 'unknownType', operation: 'equals' } }] } }
    });
    const operatorError = (result: any, nodeName: string) =>
      result.errors.filter((e: any) => e.nodeName === nodeName && e.message.startsWith('conditions.conditions[0].operator'));

    beforeEach(() => {
      nodeInfo = type => (type === 'nodes-base.if' ? { properties: [], isVersioned: false } : null);
    });

    it('handles many IF nodes with invalid operators', async () => {
      const nodes = Array.from({ length: 60_000 }, (_, i) => ifNode(`Check ${i}`));
      const start = performance.now();
      const result = await validator.validateWorkflow({ name: 'Many IF', nodes, connections: {} } as any, { validateConnections: false, validateExpressions: false });
      expect(performance.now() - start).toBeLessThan(2_000);
      expect(operatorError(result, 'Check 0')).toHaveLength(1);
      expect(operatorError(result, 'Check 59999')).toHaveLength(1);
    });

    it('does not repeat an operator error the config validator already reported', async () => {
      const [expected] = (await validator.validateWorkflow({ name: 'One', nodes: [ifNode('Check')], connections: {} } as any, { validateConnections: false }))
        .errors.filter(e => e.nodeName === 'Check').map(e => e.message);
      expect(expected).toBeDefined();
      mockNodeValidator.validateWithMode.mockReturnValue({ errors: [expected], warnings: [] });
      const result = await validator.validateWorkflow({ name: 'Two', nodes: [ifNode('Check'), ifNode('Other')], connections: {} } as any, { validateConnections: false });
      expect(result.errors.filter(e => e.nodeName === 'Check' && e.message === expected)).toHaveLength(1);
      expect(result.errors.filter(e => e.nodeName === 'Other' && e.message === expected)).toHaveLength(1);
    });
  });

  describe('error handling detection', () => {
    it('handles many same-name nodes with an unwired error output', async () => {
      const count = 60_000;
      const nodes = Array.from({ length: count }, () => node('Worker', 'community.unknownNode', { onError: 'continueErrorOutput' }));
      const workflow = { name: 'Same names', nodes, connections: { Worker: { main: Array.from({ length: count }, () => []) } } };
      const start = performance.now();
      const result = await validator.validateWorkflow(workflow as any, {
        validateNodes: false, validateConnections: false, validateExpressions: false, profile: 'ai-friendly'
      });
      expect(performance.now() - start).toBeLessThan(2_000);
      expect(result.warnings.some(w => w.message.includes('error handling'))).toBe(true);
    });
  });
});
