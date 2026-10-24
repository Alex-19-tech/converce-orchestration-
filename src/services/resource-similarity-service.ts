import { NodeRepository } from '../database/node-repository';
import { logger } from '../utils/logger';
import { ValidationServiceError } from '../errors/validation-service-error';

export interface ResourceSuggestion {
  value: string;
  confidence: number;
  reason: string;
  availableOperations?: string[];
}

interface ResourcePattern {
  pattern: string;
  suggestion: string;
  confidence: number;
  reason: string;
}

export class ResourceSimilarityService {
  private static readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly MIN_CONFIDENCE = 0.3; // 30% minimum confidence to suggest
  private static readonly MAX_SUGGESTIONS = 5;
  // SECURITY (GHSA-xvxq-x6hr-xc2c): bound input length and cache size
  private static readonly MAX_NAME_LENGTH = 128;
  private static readonly MAX_CACHE_KEY_LENGTH = 512;
  private static readonly MAX_RESOURCE_CACHE_ENTRIES = 500;
  private static readonly MAX_SUGGESTION_CACHE_ENTRIES = 100;

  // Confidence thresholds for better code clarity
  private static readonly CONFIDENCE_THRESHOLDS = {
    EXACT: 1.0,
    VERY_HIGH: 0.95,
    HIGH: 0.8,
    MEDIUM: 0.6,
    MIN_SUBSTRING: 0.7
  } as const;

  private repository: NodeRepository;
  private resourceCache: Map<string, { resources: any[], timestamp: number }> = new Map();
  private suggestionCache: Map<string, ResourceSuggestion[]> = new Map();
  private commonPatterns: Map<string, ResourcePattern[]>;

  constructor(repository: NodeRepository) {
    this.repository = repository;
    this.commonPatterns = this.initializeCommonPatterns();
  }

  /**
   * Clean up expired cache entries to prevent memory leaks
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();

    // Clean resource cache
    for (const [key, value] of this.resourceCache.entries()) {
      if (now - value.timestamp >= ResourceSimilarityService.CACHE_DURATION_MS) {
        this.resourceCache.delete(key);
      }
    }

    // Clean suggestion cache - these don't have timestamps, so clear if cache is too large
    if (this.suggestionCache.size > 100) {
      // Keep only the most recent 50 entries
      const entries = Array.from(this.suggestionCache.entries());
      this.suggestionCache.clear();
      entries.slice(-50).forEach(([key, value]) => {
        this.suggestionCache.set(key, value);
      });
    }
  }

  /**
   * Insert into a cache, evicting the oldest entries once it is full.
   * Keys longer than MAX_CACHE_KEY_LENGTH are not cached.
   */
  private static setBounded<V>(cache: Map<string, V>, key: string, value: V, maxEntries: number): void {
    if (key.length > ResourceSimilarityService.MAX_CACHE_KEY_LENGTH) return;
    cache.delete(key);
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(key, value);
  }

  /**
   * Initialize common resource mistake patterns
   */
  private initializeCommonPatterns(): Map<string, ResourcePattern[]> {
    const patterns = new Map<string, ResourcePattern[]>();

    // Google Drive patterns
    patterns.set('googleDrive', [
      { pattern: 'files', suggestion: 'file', confidence: 0.95, reason: 'Use singular "file" not plural' },
      { pattern: 'folders', suggestion: 'folder', confidence: 0.95, reason: 'Use singular "folder" not plural' },
      { pattern: 'permissions', suggestion: 'permission', confidence: 0.9, reason: 'Use singular form' },
      { pattern: 'fileAndFolder', suggestion: 'fileFolder', confidence: 0.9, reason: 'Use "fileFolder" for combined operations' },
      { pattern: 'driveFiles', suggestion: 'file', confidence: 0.8, reason: 'Use "file" for file operations' },
      { pattern: 'sharedDrives', suggestion: 'drive', confidence: 0.85, reason: 'Use "drive" for shared drive operations' },
    ]);

    // Slack patterns
    patterns.set('slack', [
      { pattern: 'messages', suggestion: 'message', confidence: 0.95, reason: 'Use singular "message" not plural' },
      { pattern: 'channels', suggestion: 'channel', confidence: 0.95, reason: 'Use singular "channel" not plural' },
      { pattern: 'users', suggestion: 'user', confidence: 0.95, reason: 'Use singular "user" not plural' },
      { pattern: 'msg', suggestion: 'message', confidence: 0.85, reason: 'Use full "message" not abbreviation' },
      { pattern: 'dm', suggestion: 'message', confidence: 0.7, reason: 'Use "message" for direct messages' },
      { pattern: 'conversation', suggestion: 'channel', confidence: 0.7, reason: 'Use "channel" for conversations' },
    ]);

    // Database patterns (postgres, mysql, mongodb)
    patterns.set('database', [
      { pattern: 'tables', suggestion: 'table', confidence: 0.95, reason: 'Use singular "table" not plural' },
      { pattern: 'queries', suggestion: 'query', confidence: 0.95, reason: 'Use singular "query" not plural' },
      { pattern: 'collections', suggestion: 'collection', confidence: 0.95, reason: 'Use singular "collection" not plural' },
      { pattern: 'documents', suggestion: 'document', confidence: 0.95, reason: 'Use singular "document" not plural' },
      { pattern: 'records', suggestion: 'record', confidence: 0.85, reason: 'Use "record" or "document"' },
      { pattern: 'rows', suggestion: 'row', confidence: 0.9, reason: 'Use singular "row"' },
    ]);

    // Google Sheets patterns
    patterns.set('googleSheets', [
      { pattern: 'sheets', suggestion: 'sheet', confidence: 0.95, reason: 'Use singular "sheet" not plural' },
      { pattern: 'spreadsheets', suggestion: 'spreadsheet', confidence: 0.95, reason: 'Use singular "spreadsheet"' },
      { pattern: 'cells', suggestion: 'cell', confidence: 0.9, reason: 'Use singular "cell"' },
      { pattern: 'ranges', suggestion: 'range', confidence: 0.9, reason: 'Use singular "range"' },
      { pattern: 'worksheets', suggestion: 'sheet', confidence: 0.8, reason: 'Use "sheet" for worksheet operations' },
    ]);

    // Email patterns
    patterns.set('email', [
      { pattern: 'emails', suggestion: 'email', confidence: 0.95, reason: 'Use singular "email" not plural' },
      { pattern: 'messages', suggestion: 'message', confidence: 0.9, reason: 'Use "message" for email operations' },
      { pattern: 'mails', suggestion: 'email', confidence: 0.9, reason: 'Use "email" not "mail"' },
      { pattern: 'attachments', suggestion: 'attachment', confidence: 0.95, reason: 'Use singular "attachment"' },
    ]);

    // Generic plural/singular patterns
    patterns.set('generic', [
      { pattern: 'items', suggestion: 'item', confidence: 0.9, reason: 'Use singular form' },
      { pattern: 'objects', suggestion: 'object', confidence: 0.9, reason: 'Use singular form' },
      { pattern: 'entities', suggestion: 'entity', confidence: 0.9, reason: 'Use singular form' },
      { pattern: 'resources', suggestion: 'resource', confidence: 0.9, reason: 'Use singular form' },
      { pattern: 'elements', suggestion: 'element', confidence: 0.9, reason: 'Use singular form' },
    ]);

    return patterns;
  }

  /**
   * Find similar resources for an invalid resource using pattern matching
   * and Levenshtein distance algorithms
   *
   * @param nodeType - The n8n node type (e.g., 'nodes-base.googleDrive')
   * @param invalidResource - The invalid resource provided by the user
   * @param maxSuggestions - Maximum number of suggestions to return (default: 5)
   * @returns Array of resource suggestions sorted by confidence
   *
   * @example
   * findSimilarResources('nodes-base.googleDrive', 'files', 3)
   * // Returns: [{ value: 'file', confidence: 0.95, reason: 'Use singular "file" not plural' }]
   */
  findSimilarResources(
    nodeType: string,
    invalidResource: string,
    maxSuggestions: number = ResourceSimilarityService.MAX_SUGGESTIONS
  ): ResourceSuggestion[] {
    // SECURITY (GHSA-xvxq-x6hr-xc2c): no suggestions for values longer than any real name
    if (typeof invalidResource === 'string' && invalidResource.length > ResourceSimilarityService.MAX_NAME_LENGTH) {
      return [];
    }

    // Clean up expired cache entries periodically
    if (Math.random() < 0.1) { // 10% chance to cleanup on each call
      this.cleanupExpiredEntries();
    }
    // Check cache first
    const cacheKey = `${nodeType}:${invalidResource}`;
    if (this.suggestionCache.has(cacheKey)) {
      return this.suggestionCache.get(cacheKey)!;
    }

    const suggestions: ResourceSuggestion[] = [];

    // Get valid resources for the node
    const validResources = this.getNodeResources(nodeType);

    // Early termination for exact match - no suggestions needed
    for (const resource of validResources) {
      const resourceValue = this.getResourceValue(resource);
      if (resourceValue.toLowerCase() === invalidResource.toLowerCase()) {
        return []; // Valid resource, no suggestions needed
      }
    }

    // Check for exact pattern matches first
    const nodePatterns = this.getNodePatterns(nodeType);
    for (const pattern of nodePatterns) {
      if (pattern.pattern.toLowerCase() === invalidResource.toLowerCase()) {
        // Check if the suggested resource actually exists with type safety
        const exists = validResources.some(r => {
          const resourceValue = this.getResourceValue(r);
          return resourceValue === pattern.suggestion;
        });
        if (exists) {
          suggestions.push({
            value: pattern.suggestion,
            confidence: pattern.confidence,
            reason: pattern.reason
          });
        }
      }
    }

    // Handle automatic plural/singular conversion
    const singularForm = this.toSingular(invalidResource);
    const pluralForm = this.toPlural(invalidResource);

    for (const resource of validResources) {
      const resourceValue = this.getResourceValue(resource);

      // Check for plural/singular match
      if (resourceValue === singularForm || resourceValue === pluralForm) {
        if (!suggestions.some(s => s.value === resourceValue)) {
          suggestions.push({
            value: resourceValue,
            confidence: 0.9,
            reason: invalidResource.endsWith('s') ?
              'Use singular form for resources' :
              'Incorrect plural/singular form',
            availableOperations: typeof resource === 'object' ? resource.operations : undefined
          });
        }
      }

      // Calculate similarity
      const similarity = this.calculateSimilarity(invalidResource, resourceValue);
      if (similarity >= ResourceSimilarityService.MIN_CONFIDENCE) {
        if (!suggestions.some(s => s.value === resourceValue)) {
          suggestions.push({
            value: resourceValue,
            confidence: similarity,
            reason: this.getSimilarityReason(similarity, invalidResource, resourceValue),
            availableOperations: typeof resource === 'object' ? resource.operations : undefined
          });
        }
      }
    }

    // Sort by confidence and limit
    suggestions.sort((a, b) => b.confidence - a.confidence);
    const topSuggestions = suggestions.slice(0, maxSuggestions);

    // Cache the result
    ResourceSimilarityService.setBounded(
      this.suggestionCache, cacheKey, topSuggestions, ResourceSimilarityService.MAX_SUGGESTION_CACHE_ENTRIES
    );

    return topSuggestions;
  }

  /**
   * Type-safe extraction of resource value from various formats
   * @param resource - Resource object or string
   * @returns The resource value as a string
   */
  private getResourceValue(resource: any): string {
    if (typeof resource === 'string') {
      return resource;
    }
    if (typeof resource === 'object' && resource !== null) {
      return resource.value || '';
    }
    return '';
  }

  /**
   * Get resources for a node with caching
   */
  private getNodeResources(nodeType: string): any[] {
    // Cleanup cache periodically
    if (Math.random() < 0.05) { // 5% chance
      this.cleanupExpiredEntries();
    }

    const cacheKey = nodeType;
    const cached = this.resourceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < ResourceSimilarityService.CACHE_DURATION_MS) {
      return cached.resources;
    }

    const nodeInfo = this.repository.getNode(nodeType);
    if (!nodeInfo) return [];

    const resources: any[] = [];
    const resourceMap: Map<string, string[]> = new Map();

    // Parse properties for resource fields
    try {
      const properties = nodeInfo.properties || [];
      for (const prop of properties) {
        if (prop.name === 'resource' && prop.options) {
          for (const option of prop.options) {
            resources.push({
              value: option.value,
              name: option.name,
              operations: []
            });
            resourceMap.set(option.value, []);
          }
        }

        // Find operations for each resource
        if (prop.name === 'operation' && prop.displayOptions?.show?.resource) {
          const resourceValues = Array.isArray(prop.displayOptions.show.resource)
            ? prop.displayOptions.show.resource
            : [prop.displayOptions.show.resource];

          for (const resourceValue of resourceValues) {
            if (resourceMap.has(resourceValue) && prop.options) {
              const ops = prop.options.map((op: any) => op.value);
              resourceMap.get(resourceValue)!.push(...ops);
            }
          }
        }
      }

      // Update resources with their operations
      for (const resource of resources) {
        if (resourceMap.has(resource.value)) {
          resource.operations = resourceMap.get(resource.value);
        }
      }

      // If no explicit resources, check for common patterns
      if (resources.length === 0) {
        // Some nodes don't have explicit resource fields
        const implicitResources = this.extractImplicitResources(properties);
        resources.push(...implicitResources);
      }
    } catch (error) {
      logger.warn(`Failed to extract resources for ${nodeType}:`, error);
    }

    // Cache and return
    ResourceSimilarityService.setBounded(
      this.resourceCache, cacheKey, { resources, timestamp: Date.now() }, ResourceSimilarityService.MAX_RESOURCE_CACHE_ENTRIES
    );
    return resources;
  }

  /**
   * Extract implicit resources from node properties
   */
  private extractImplicitResources(properties: any[]): any[] {
    const resources: any[] = [];

    // Look for properties that suggest resources
    for (const prop of properties) {
      if (prop.name === 'operation' && prop.options) {
        // If there's no explicit resource field, operations might imply resources
        const resourceFromOps = this.inferResourceFromOperations(prop.options);
        if (resourceFromOps) {
          resources.push({
            value: resourceFromOps,
            name: resourceFromOps.charAt(0).toUpperCase() + resourceFromOps.slice(1),
            operations: prop.options.map((op: any) => op.value)
          });
        }
      }
    }

    return resources;
  }

  /**
   * Infer resource type from operations
   */
  private inferResourceFromOperations(operations: any[]): string | null {
    // Common patterns in operation names that suggest resources
    const patterns = [
      { keywords: ['file', 'upload', 'download'], resource: 'file' },
      { keywords: ['folder', 'directory'], resource: 'folder' },
      { keywords: ['message', 'send', 'reply'], resource: 'message' },
      { keywords: ['channel', 'broadcast'], resource: 'channel' },
      { keywords: ['user', 'member'], resource: 'user' },
      { keywords: ['table', 'row', 'column'], resource: 'table' },
      { keywords: ['document', 'doc'], resource: 'document' },
    ];

    for (const pattern of patterns) {
      for (const op of operations) {
        const opName = (op.value || op).toLowerCase();
        if (pattern.keywords.some(keyword => opName.includes(keyword))) {
          return pattern.resource;
        }
      }
    }

    return null;
  }

  /**
   * Get patterns for a specific node type
   */
  private getNodePatterns(nodeType: string): ResourcePattern[] {
    const patterns: ResourcePattern[] = [];

    // Add node-specific patterns
    if (nodeType.includes('googleDrive')) {
      patterns.push(...(this.commonPatterns.get('googleDrive') || []));
    } else if (nodeType.includes('slack')) {
      patterns.push(...(this.commonPatterns.get('slack') || []));
    } else if (nodeType.includes('postgres') || nodeType.includes('mysql') || nodeType.includes('mongodb')) {
      patterns.push(...(this.commonPatterns.get('database') || []));
    } else if (nodeType.includes('googleSheets')) {
      patterns.push(...(this.commonPatterns.get('googleSheets') || []));
    } else if (nodeType.includes('gmail') || nodeType.includes('email')) {
      patterns.push(...(this.commonPatterns.get('email') || []));
    }

    // Always add generic patterns
    patterns.push(...(this.commonPatterns.get('generic') || []));

    return patterns;
  }

  /**
   * Convert to singular form (simple heuristic)
   */
  private toSingular(word: string): string {
    if (word.endsWith('ies')) {
      return word.slice(0, -3) + 'y';
    } else if (word.endsWith('es')) {
      return word.slice(0, -2);
    } else if (word.endsWith('s') && !word.endsWith('ss')) {
      return word.slice(0, -1);
    }
    return word;
  }

  /**
   * Convert to plural form (simple heuristic)
   */
  private toPlural(word: string): string {
    if (word.endsWith('y') && !['ay', 'ey', 'iy', 'oy', 'uy'].includes(word.slice(-2))) {
      return word.slice(0, -1) + 'ies';
    } else if (word.endsWith('s') || word.endsWith('x') || word.endsWith('z') ||
               word.endsWith('ch') || word.endsWith('sh')) {
      return word + 'es';
    } else {
      return word + 's';
    }
  }

  /**
   * Calculate similarity between two strings using Levenshtein distance
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    // Exact match
    if (s1 === s2) return 1.0;

    // One is substring of the other
    if (s1.includes(s2) || s2.includes(s1)) {
      const ratio = Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
      return Math.max(ResourceSimilarityService.CONFIDENCE_THRESHOLDS.MIN_SUBSTRING, ratio);
    }

    // Calculate Levenshtein distance
    const distance = this.levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);

    // Convert distance to similarity
    let similarity = 1 - (distance / maxLength);

    // Boost confidence for single character typos and transpositions in short words
    if (distance === 1 && maxLength <= 5) {
      similarity = Math.max(similarity, 0.75);
    } else if (distance === 2 && maxLength <= 5) {
      // Boost for transpositions (e.g., "flie" -> "file")
      similarity = Math.max(similarity, 0.72);
    }

    return similarity;
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(str1: string, str2: string): number {
    // SECURITY (GHSA-xvxq-x6hr-xc2c): two-row distance, linear memory
    const m = str1.length;
    const n = str2.length;
    if (m === 0) return n;
    if (n === 0) return m;

    let prev: number[] = new Array(n + 1);
    let curr: number[] = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          curr[j] = prev[j - 1];
        } else {
          curr[j] = Math.min(
            prev[j] + 1,     // deletion
            curr[j - 1] + 1, // insertion
            prev[j - 1] + 1  // substitution
          );
        }
      }
      [prev, curr] = [curr, prev];
    }

    return prev[n];
  }

  /**
   * Generate a human-readable reason for the similarity
   * @param confidence - Similarity confidence score
   * @param invalid - The invalid resource string
   * @param valid - The valid resource string
   * @returns Human-readable explanation of the similarity
   */
  private getSimilarityReason(confidence: number, invalid: string, valid: string): string {
    const { VERY_HIGH, HIGH, MEDIUM } = ResourceSimilarityService.CONFIDENCE_THRESHOLDS;

    if (confidence >= VERY_HIGH) {
      return 'Almost exact match - likely a typo';
    } else if (confidence >= HIGH) {
      return 'Very similar - common variation';
    } else if (confidence >= MEDIUM) {
      return 'Similar resource name';
    } else if (invalid.includes(valid) || valid.includes(invalid)) {
      return 'Partial match';
    } else {
      return 'Possibly related resource';
    }
  }

  /**
   * Clear caches
   */
  clearCache(): void {
    this.resourceCache.clear();
    this.suggestionCache.clear();
  }
}