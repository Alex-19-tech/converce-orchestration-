import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { TestDatabase, createTestDatabaseAdapter } from '../database/test-utils';
import { NodeRepository } from '../../../src/database/node-repository';
import { WorkflowVersioningService } from '../../../src/services/workflow-versioning-service';
import { handleWorkflowVersions } from '../../../src/mcp/handlers-n8n-manager';
import { N8nApiClient } from '../../../src/services/n8n-api-client';
import { N8nApiError, N8nAuthenticationError } from '../../../src/utils/n8n-errors';
import { getInstanceScopeId, type InstanceContext } from '../../../src/types/instance-context';

/**
 * Local version snapshots for an instance scope are served only while the
 * scope's n8n instance accepts the API key.
 */
describe('n8n_workflow_versions local store: n8n key check', () => {
  let testDb: TestDatabase;
  let repository: NodeRepository;
  let listWorkflows: MockInstance<N8nApiClient['listWorkflows']>;
  let contextCounter = 0;

  // A fresh key per test, so a check cached by one test never answers for another.
  function newContext(): InstanceContext {
    contextCounter += 1;
    return {
      n8nApiUrl: 'https://tenant-key-check.example.com',
      n8nApiKey: `n8n_api_key_key_check_${contextCounter}_0123456789`
    };
  }

  beforeEach(async () => {
    listWorkflows = vi.spyOn(N8nApiClient.prototype, 'listWorkflows');
    testDb = new TestDatabase({ mode: 'memory' });
    const db = await testDb.initialize();
    repository = new NodeRepository(createTestDatabaseAdapter(db));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await testDb.cleanup();
  });

  async function seedBackups(context: InstanceContext): Promise<number[]> {
    const service = new WorkflowVersioningService(repository, undefined, getInstanceScopeId(context));
    const ids: number[] = [];
    for (const name of ['First', 'Second', 'Third']) {
      const result = await service.createBackup(
        'wf-key',
        { name, nodes: [], connections: {}, settings: {} },
        { trigger: 'partial_update' }
      );
      ids.push(result.versionId);
    }
    return ids;
  }

  function storedVersionCount(context: InstanceContext): number {
    return repository.getWorkflowVersions('wf-key', getInstanceScopeId(context), 100).length;
  }

  function allModes(ids: number[]) {
    return [
      { mode: 'list', workflowId: 'wf-key' },
      { mode: 'get', versionId: ids[0] },
      { mode: 'diff', workflowId: 'wf-key', versionId: ids[0], toVersionId: ids[1] },
      { mode: 'delete', versionId: ids[0] },
      { mode: 'delete', workflowId: 'wf-key', deleteAll: true },
      { mode: 'prune', workflowId: 'wf-key', maxVersions: 1 },
      { mode: 'rollback', workflowId: 'wf-key', versionId: ids[0] }
    ];
  }

  it('refuses every mode and keeps the snapshots when n8n rejects the key', async () => {
    const context = newContext();
    const ids = await seedBackups(context);
    listWorkflows.mockRejectedValue(new N8nAuthenticationError('Failed to authenticate with n8n'));

    for (const args of allModes(ids)) {
      const res = await handleWorkflowVersions(args, repository, context);
      expect(res.success, `mode ${args.mode}`).toBe(false);
      expect(res.code, `mode ${args.mode}`).toBe('UNAUTHORIZED');
      expect(res.data, `mode ${args.mode}`).toBeUndefined();
    }

    expect(storedVersionCount(context)).toBe(3);
  });

  it('refuses a key that gets 403 on list when the mode names no workflow', async () => {
    const context = newContext();
    const ids = await seedBackups(context);
    listWorkflows.mockRejectedValue(new N8nApiError('Forbidden', 403, 'API_ERROR'));
    const getWorkflow = vi.spyOn(N8nApiClient.prototype, 'getWorkflow').mockResolvedValue({} as any);

    for (const args of [
      { mode: 'get', versionId: ids[0], workflowId: 'wf-key' },
      { mode: 'delete', versionId: ids[0], workflowId: 'wf-key' }
    ]) {
      const res = await handleWorkflowVersions(args, repository, context);
      expect(res.success, `mode ${args.mode}`).toBe(false);
      expect(res.code, `mode ${args.mode}`).toBe('UNAUTHORIZED');
    }
    expect(getWorkflow).not.toHaveBeenCalled();
    expect(storedVersionCount(context)).toBe(3);
  });

  it('accepts a key that gets 403 on list but can read the named workflow', async () => {
    const context = newContext();
    await seedBackups(context);
    listWorkflows.mockRejectedValue(new N8nApiError('Forbidden', 403, 'API_ERROR'));
    const getWorkflow = vi.spyOn(N8nApiClient.prototype, 'getWorkflow').mockResolvedValue({} as any);

    const res = await handleWorkflowVersions({ mode: 'list', workflowId: 'wf-key' }, repository, context);
    expect(res.success).toBe(true);
    expect((res.data as any).count).toBe(3);
    expect(getWorkflow).toHaveBeenCalledWith('wf-key');
  });

  it('refuses a key that gets 403 on list and cannot read the named workflow', async () => {
    const context = newContext();
    await seedBackups(context);
    listWorkflows.mockRejectedValue(new N8nApiError('Forbidden', 403, 'API_ERROR'));
    vi.spyOn(N8nApiClient.prototype, 'getWorkflow').mockRejectedValue(new N8nApiError('Forbidden', 403, 'API_ERROR'));

    const prune = await handleWorkflowVersions({ mode: 'prune', workflowId: 'wf-key', maxVersions: 1 }, repository, context);
    expect(prune.success).toBe(false);
    expect(prune.code).toBe('UNAUTHORIZED');
    expect(storedVersionCount(context)).toBe(3);
  });

  describe('rollback with a key that gets 403 on list but can read the workflow', () => {
    let updateWorkflow: MockInstance<N8nApiClient['updateWorkflow']>;

    beforeEach(() => {
      listWorkflows.mockRejectedValue(new N8nApiError('Forbidden', 403, 'API_ERROR'));
      vi.spyOn(N8nApiClient.prototype, 'getWorkflow').mockResolvedValue({
        id: 'wf-key', name: 'Current', nodes: [], connections: {}, settings: {}
      } as any);
      updateWorkflow = vi.spyOn(N8nApiClient.prototype, 'updateWorkflow').mockResolvedValue({} as any);
    });

    it('restores the latest snapshot of the workflow', async () => {
      const context = newContext();
      await seedBackups(context);

      const res = await handleWorkflowVersions(
        { mode: 'rollback', workflowId: 'wf-key', validateBefore: false }, repository, context
      );
      expect(res.success).toBe(true);
      expect(updateWorkflow).toHaveBeenCalledTimes(1);
      expect(updateWorkflow.mock.calls[0][0]).toBe('wf-key');
      expect((updateWorkflow.mock.calls[0][1] as any).name).toBe('Third');
    });

    it('restores a named snapshot that belongs to the workflow', async () => {
      const context = newContext();
      const ids = await seedBackups(context);

      const res = await handleWorkflowVersions(
        { mode: 'rollback', workflowId: 'wf-key', versionId: ids[0], validateBefore: false }, repository, context
      );
      expect(res.success).toBe(true);
      expect((updateWorkflow.mock.calls[0][1] as any).name).toBe('First');
    });

    it('refuses a named snapshot that belongs to another workflow', async () => {
      const context = newContext();
      await seedBackups(context);
      const service = new WorkflowVersioningService(repository, undefined, getInstanceScopeId(context));
      const other = await service.createBackup(
        'wf-other',
        { name: 'Other', nodes: [], connections: {}, settings: {} },
        { trigger: 'partial_update' }
      );

      const res = await handleWorkflowVersions(
        { mode: 'rollback', workflowId: 'wf-key', versionId: other.versionId, validateBefore: false }, repository, context
      );
      expect(res.success).toBe(false);
      expect(res.code).toBe('INVALID_ARGS');
      expect(updateWorkflow).not.toHaveBeenCalled();
      expect(storedVersionCount(context)).toBe(3);
    });
  });

  it('refuses while n8n cannot be reached', async () => {
    const context = newContext();
    const ids = await seedBackups(context);
    listWorkflows.mockRejectedValue(new N8nApiError('No response from n8n server', undefined, 'NO_RESPONSE'));

    const get = await handleWorkflowVersions({ mode: 'get', versionId: ids[0] }, repository, context);
    expect(get.success).toBe(false);
    expect(get.code).toBe('N8N_UNAVAILABLE');
    expect(get.data).toBeUndefined();

    const del = await handleWorkflowVersions({ mode: 'delete', workflowId: 'wf-key', deleteAll: true }, repository, context);
    expect(del.success).toBe(false);
    expect(storedVersionCount(context)).toBe(3);
  });

  it('serves the snapshots when n8n accepts the key and reuses the check briefly', async () => {
    const context = newContext();
    const ids = await seedBackups(context);
    listWorkflows.mockResolvedValue({ data: [], nextCursor: null });

    const list = await handleWorkflowVersions({ mode: 'list', workflowId: 'wf-key' }, repository, context);
    expect(list.success).toBe(true);
    expect((list.data as any).count).toBe(3);

    const get = await handleWorkflowVersions({ mode: 'get', versionId: ids[1] }, repository, context);
    expect(get.success).toBe(true);
    expect((get.data as any).workflowName).toBe('Second');

    expect(listWorkflows).toHaveBeenCalledTimes(1);
  });

  it('checks the key again once the cached result expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const context = newContext();
    const ids = await seedBackups(context);
    listWorkflows.mockResolvedValueOnce({ data: [], nextCursor: null });

    const first = await handleWorkflowVersions({ mode: 'get', versionId: ids[0] }, repository, context);
    expect(first.success).toBe(true);

    // The key is revoked; after the cache window the next call sees it.
    listWorkflows.mockRejectedValue(new N8nAuthenticationError('Failed to authenticate with n8n'));
    vi.setSystemTime(Date.now() + 61_000);

    const second = await handleWorkflowVersions({ mode: 'get', versionId: ids[0] }, repository, context);
    expect(second.success).toBe(false);
    expect(second.code).toBe('UNAUTHORIZED');
    expect(listWorkflows).toHaveBeenCalledTimes(2);
  });

  it('does not contact n8n for the default scope', async () => {
    const service = new WorkflowVersioningService(repository, undefined, getInstanceScopeId(undefined));
    await service.createBackup(
      'wf-key',
      { name: 'Default', nodes: [], connections: {}, settings: {} },
      { trigger: 'partial_update' }
    );

    const res = await handleWorkflowVersions({ mode: 'list', workflowId: 'wf-key' }, repository, undefined);
    expect(res.success).toBe(true);
    expect(listWorkflows).not.toHaveBeenCalled();
  });
});
