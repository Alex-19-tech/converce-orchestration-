/**
 * Tests for ResourceSimilarityService
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResourceSimilarityService } from '../../../src/services/resource-similarity-service';
import { NodeRepository } from '../../../src/database/node-repository';
import { createTestDatabase } from '../../utils/database-utils';

describe('ResourceSimilarityService', () => {
  let service: ResourceSimilarityService;
  let repository: NodeRepository;
  let testDb: any;

  beforeEach(async () => {
    testDb = await createTestDatabase();
    repository = testDb.nodeRepository;
    service = new ResourceSimilarityService(repository);

    // Add test node with resources
    const testNode = {
      nodeType: 'nodes-base.googleDrive',
      packageName: 'n8n-nodes-base',
      displayName: 'Google Drive',
      description: 'Access Google Drive',
      category: 'transform',
      style: 'declarative' as const,
      isAITool: false,
      isTrigger: false,
      isWebhook: false,
      isVersioned: true,
      version: '1',
      properties: [
        {
          name: 'resource',
          type: 'options',
          options: [
            { value: 'file', name: 'File' },
            { value: 'folder', name: 'Folder' },
            { value: 'drive', name: 'Shared Drive' },
            { value: 'fileFolder', name: 'File & Folder' }
          ]
        }
      ],
      operations: [],
      credentials: []
    };

    repository.saveNode(testNode);

    // Add Slack node for testing different patterns
    const slackNode = {
      nodeType: 'nodes-base.slack',
      packageName: 'n8n-nodes-base',
      displayName: 'Slack',
      description: 'Send messages to Slack',
      category: 'communication',
      style: 'declarative' as const,
      isAITool: false,
      isTrigger: false,
      isWebhook: false,
      isVersioned: true,
      version: '2',
      properties: [
        {
          name: 'resource',
          type: 'options',
          options: [
            { value: 'channel', name: 'Channel' },
            { value: 'message', name: 'Message' },
            { value: 'user', name: 'User' },
            { value: 'file', name: 'File' },
            { value: 'star', name: 'Star' }
          ]
        }
      ],
      operations: [],
      credentials: []
    };

    repository.saveNode(slackNode);
  });

  afterEach(async () => {
    if (testDb) {
      await testDb.cleanup();
    }
  });

  describe('findSimilarResources', () => {
    it('should find exact match', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.googleDrive',
        'file',
        5
      );

      expect(suggestions).toHaveLength(0); // No suggestions for valid resource
    });

    it('should suggest singular form for plural input', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.googleDrive',
        'files',
        5
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].value).toBe('file');
      expect(suggestions[0].confidence).toBeGreaterThanOrEqual(0.9);
      expect(suggestions[0].reason).toContain('singular');
    });

    it('should suggest singular form for folders', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.googleDrive',
        'folders',
        5
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].value).toBe('folder');
      expect(suggestions[0].confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should handle typos with Levenshtein distance', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.googleDrive',
        'flie',
        5
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].value).toBe('file');
      expect(suggestions[0].confidence).toBeGreaterThan(0.7);
    });

    it('should handle combined resources', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.googleDrive',
        'fileAndFolder',
        5
      );

      expect(suggestions.length).toBeGreaterThan(0);
      // Should suggest 'fileFolder' (the actual combined resource)
      const fileFolderSuggestion = suggestions.find(s => s.value === 'fileFolder');
      expect(fileFolderSuggestion).toBeDefined();
    });

    it('should return empty array for node not found', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.nonexistent',
        'resource',
        5
      );

      expect(suggestions).toEqual([]);
    });
  });

  describe('plural/singular detection', () => {
    it('should handle regular plurals (s)', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.slack',
        'channels',
        5
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].value).toBe('channel');
    });

    it('should handle plural ending in es', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.slack',
        'messages',
        5
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].value).toBe('message');
    });

    it('should handle plural ending in ies', () => {
      // Test with a hypothetical 'entities' -> 'entity' conversion
      const suggestions = service.findSimilarResources(
        'nodes-base.googleDrive',
        'entities',
        5
      );

      // Should not crash and provide some suggestions
      expect(suggestions).toBeDefined();
    });
  });

  describe('node-specific patterns', () => {
    it('should apply Google Drive specific patterns', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.googleDrive',
        'sharedDrives',
        5
      );

      expect(suggestions.length).toBeGreaterThan(0);
      const driveSuggestion = suggestions.find(s => s.value === 'drive');
      expect(driveSuggestion).toBeDefined();
    });

    it('should apply Slack specific patterns', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.slack',
        'users',
        5
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].value).toBe('user');
    });
  });

  describe('similarity calculation', () => {
    it('should rank exact matches highest', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.googleDrive',
        'file',
        5
      );

      expect(suggestions).toHaveLength(0); // Exact match, no suggestions
    });

    it('should rank substring matches high', () => {
      const suggestions = service.findSimilarResources(
        'nodes-base.googleDrive',
        'fil',
        5
      );

      expect(suggestions.length).toBeGreaterThan(0);
      const fileSuggestion = suggestions.find(s => s.value === 'file');
      expect(fileSuggestion).toBeDefined();
      expect(fileSuggestion!.confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('caching', () => {
    it('should cache results for repeated queries', () => {
      // First call
      const suggestions1 = service.findSimilarResources(
        'nodes-base.googleDrive',
        'files',
        5
      );

      // Second call with same params
      const suggestions2 = service.findSimilarResources(
        'nodes-base.googleDrive',
        'files',
        5
      );

      expect(suggestions1).toEqual(suggestions2);
    });

    it('should clear cache when requested', () => {
      // Add to cache
      service.findSimilarResources(
        'nodes-base.googleDrive',
        'test',
        5
      );

      // Clear cache
      service.clearCache();

      // This would fetch fresh data (behavior is the same, just uncached)
      const suggestions = service.findSimilarResources(
        'nodes-base.googleDrive',
        'test',
        5
      );

      expect(suggestions).toBeDefined();
    });
  });

  describe('input and cache bounds', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('handles a long resource value', () => {
      const start = Date.now();
      const results = Array.from({ length: 5 }, (_, i) =>
        service.findSimilarResources('nodes-base.googleDrive', 'z'.repeat(3_000_000) + i, 5)
      );
      expect(Date.now() - start).toBeLessThan(2000);
      expect(results.every(suggestions => suggestions.length === 0)).toBe(true);
    });

    it('returns no suggestions for values longer than any real name', () => {
      expect(service.findSimilarResources('nodes-base.googleDrive', 'file' + 'x'.repeat(200), 5)).toEqual([]);
    });

    it('does not cache over-long resource values', () => {
      service.findSimilarResources('nodes-base.googleDrive', 'r'.repeat(10_000), 5);

      const keys = [...(service as any).suggestionCache.keys()];
      expect(keys.every((key: string) => key.length <= 512)).toBe(true);
    });

    it('caps the number of cached suggestions', () => {
      // Keep the probabilistic cleanup from running so only the size cap applies.
      vi.spyOn(Math, 'random').mockReturnValue(0.99);

      for (let i = 0; i < 300; i++) {
        service.findSimilarResources('nodes-base.googleDrive', `fil${i}`, 5);
      }

      expect((service as any).suggestionCache.size).toBeLessThanOrEqual(100);
    });

    it('keeps edit distances unchanged', () => {
      const distance = (a: string, b: string) => (service as any).levenshteinDistance(a, b);
      expect(distance('kitten', 'sitting')).toBe(3);
      expect(distance('flie', 'file')).toBe(2);
      expect(distance('folder', 'file')).toBe(3);
      expect(distance('', 'abc')).toBe(3);
      expect(distance('abc', '')).toBe(3);
    });
  });
});
