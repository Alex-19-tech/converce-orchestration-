import { describe, it, expect } from 'vitest';
import { validateAISpecificNodes } from '@/services/ai-node-validator';

const node = (name: string, type: string, parameters: Record<string, unknown> = {}) => ({
  id: name, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters
});
const conn = (target: string, type = 'main') => ({ node: target, type, index: 0 });
const AGENT = '@n8n/n8n-nodes-langchain.agent';
const CHAT_TRIGGER = '@n8n/n8n-nodes-langchain.chatTrigger';

describe('validateAISpecificNodes - large workflows', () => {
  it('handles many agents fed by one source', () => {
    const count = 50_000;
    const nodes: any[] = Array.from({ length: count }, (_, i) => node(`Agent ${i}`, AGENT));
    nodes.push(node('Source', 'n8n-nodes-base.noOp'));
    const workflow = { nodes, connections: { Source: { main: [nodes.slice(0, count).map(n => conn(n.name))] } } };
    const start = performance.now();
    const issues = validateAISpecificNodes(workflow as any);
    expect(performance.now() - start).toBeLessThan(2_000);
    expect(issues.filter(i => i.code === 'MISSING_LANGUAGE_MODEL')).toHaveLength(count);
  });

  it('handles many chat triggers connected to one node', () => {
    const count = 50_000;
    const nodes: any[] = Array.from({ length: count }, (_, i) => node(`Chat ${i}`, CHAT_TRIGGER, { options: { responseMode: 'streaming' } }));
    nodes.push(node('Reply', 'n8n-nodes-base.noOp'));
    const connections: any = {};
    for (let i = 0; i < count; i++) connections[`Chat ${i}`] = { main: [[conn('Reply')]] };
    const start = performance.now();
    const issues = validateAISpecificNodes({ nodes, connections } as any);
    expect(performance.now() - start).toBeLessThan(2_000);
    expect(issues.filter(i => i.code === 'STREAMING_WRONG_TARGET')).toHaveLength(count);
  });

  it('handles many same-name agents with many incoming connections', () => {
    const count = 1_700;
    const nodes: any[] = [];
    const connections: any = {};
    for (let i = 0; i < count; i++) {
      nodes.push(node(`Input ${i}`, 'n8n-nodes-base.noOp'));
      connections[`Input ${i}`] = { main: [[conn('Agent')]] };
    }
    for (let i = 0; i < count; i++) {
      nodes.push(node('Agent', AGENT, { options: { streamResponse: true } }));
    }
    connections.Agent = { main: [[conn('Input 0')]] };
    const start = performance.now();
    const issues = validateAISpecificNodes({ nodes, connections } as any);
    expect(performance.now() - start).toBeLessThan(2_000);
    expect(issues.filter(i => i.code === 'STREAMING_WITH_MAIN_OUTPUT')).toHaveLength(count);
  });

  it('uses the first node when several nodes share the target name', () => {
    const trigger = node('Chat', CHAT_TRIGGER, { options: { responseMode: 'streaming' } });
    const connections = { Chat: { main: [[conn('Bot')]] } };
    const agentFirst = validateAISpecificNodes({
      nodes: [trigger, node('Bot', AGENT), node('Bot', 'n8n-nodes-base.noOp')], connections
    } as any);
    const agentSecond = validateAISpecificNodes({
      nodes: [trigger, node('Bot', 'n8n-nodes-base.noOp'), node('Bot', AGENT)], connections
    } as any);
    expect(agentFirst.some(i => i.code === 'STREAMING_WRONG_TARGET')).toBe(false);
    expect(agentSecond.some(i => i.code === 'STREAMING_WRONG_TARGET')).toBe(true);
  });

  it('counts incoming AI connections per agent name', () => {
    const nodes = [
      node('Model A', '@n8n/n8n-nodes-langchain.lmChatOpenAi'),
      node('Model B', '@n8n/n8n-nodes-langchain.lmChatOpenAi'),
      node('Model C', '@n8n/n8n-nodes-langchain.lmChatOpenAi'),
      node('Memory A', '@n8n/n8n-nodes-langchain.memoryBufferWindow'),
      node('Memory B', '@n8n/n8n-nodes-langchain.memoryBufferWindow'),
      node('Agent', AGENT),
      node('Agent', AGENT, { needsFallback: true })
    ];
    const connections = {
      'Model A': { ai_languageModel: [[conn('Agent', 'ai_languageModel')]] },
      'Model B': { ai_languageModel: [[conn('Agent', 'ai_languageModel')]] },
      'Model C': { ai_languageModel: [[conn('Agent', 'ai_languageModel')]] },
      'Memory A': { ai_memory: [[conn('Agent', 'ai_memory')]] },
      'Memory B': { ai_memory: [[conn('Agent', 'ai_memory')]] }
    };
    const issues = validateAISpecificNodes({ nodes, connections } as any);
    const tooMany = issues.filter(i => i.code === 'TOO_MANY_LANGUAGE_MODELS');
    expect(tooMany).toHaveLength(2);
    expect(tooMany[0].message).toContain('has 3 ai_languageModel connections');
    expect(issues.filter(i => i.code === 'MULTIPLE_MEMORY_CONNECTIONS')).toHaveLength(2);
  });
});
