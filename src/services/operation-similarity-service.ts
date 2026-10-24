import { NodeRepository } from '../database/node-repository';
import { logger } from '../utils/logger';
import { ValidationServiceError } from '../errors/validation-service-error';

export interface OperationSuggestion {
  value: string;
  confidence: number;
  reason: string;
  resource?: string;
  description?: string;
}

interface OperationPattern {
  pattern: string;
  suggestion: string;
  confidence: number;
  reason: string;
}

export class OperationSimilarityService {
  private static readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly MIN_CONFIDENCE = 0.3; // 30% minimum confidence to suggest
  private static readonly MAX_SUGGESTIONS = 5;
  // SECURITY (GHSA-xvxq-x6hr-xc2c): bound input length and cache size
  private static readonly MAX_NAME_LENGTH = 128;
  private static readonly MAX_CACHE_KEY_LENGTH = 512;
  private static readonly MAX_OPERATION_CACHE_ENTRIES = 500;
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
  private operationCache: Map<string, { operations: any[], timestamp: number }> = new Map();
  private suggestionCache: Map<string, OperationSuggestion[]> = new Map();
  private commonPatterns: Map<string, OperationPattern[]>;

  constructor(repository: NodeRepository) {
    this.repository = repository;
    this.commonPatterns = this.initializeCommonPatterns();
  }

  /**
   * Clean up expired cache entries to prevent memory leaks
   * Should be called periodically or before cache operations
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();

    // Clean operation cache
    for (const [key, value] of this.operationCache.entries()) {
      if (now - value.timestamp >= OperationSimilarityService.CACHE_DURATION_MS) {
        this.operationCache.delete(key);
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
    if (key.length > OperationSimilarityService.MAX_CACHE_KEY_LENGTH) return;
    cache.delete(key);
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(key, value);
  }

  /**
   * Initialize common operation mistake patterns
   */
  private initializeCommonPatterns(): Map<string, OperationPattern[]> {
    const patterns = new Map<string, OperationPattern[]>();

    // Google Drive patterns
    patterns.set('googleDrive', [
      { pattern: 'listFiles', suggestion: 'search', confidence: 0.85, reason: 'Use "search" with resource: "fileFolder" to list files' },
      { pattern: 'uploadFile', suggestion: 'upload', confidence: 0.95, reason: 'Use "upload" instead of "uploadFile"' },
      { pattern: 'deleteFile', suggestion: 'deleteFile', confidence: 1.0, reason: 'Exact match' },
      { pattern: 'downloadFile', suggestion: 'download', confidence: 0.95, reason: 'Use "download" instead of "downloadFile"' },
      { pattern: 'getFile', suggestion: 'download', confidence: 0.8, reason: 'Use "download" to retrieve file content' },
      { pattern: 'listFolders', suggestion: 'search', confidence: 0.85, reason: 'Use "search" with resource: "fileFolder"' },
    ]);

    // Slack patterns
    patterns.set('slack', [
      { pattern: 'sendMessage', suggestion: 'send', confidence: 0.95, reason: 'Use "send" instead of "sendMessage"' },
      { pattern: 'getMessage', suggestion: 'get', confidence: 0.9, reason: 'Use "get" to retrieve messages' },
      { pattern: 'postMessage', suggestion: 'send', confidence: 0.9, reason: 'Use "send" to post messages' },
      { pattern: 'deleteMessage', suggestion: 'delete', confidence: 0.95, reason: 'Use "delete" instead of "deleteMessage"' },
      { pattern: 'createChannel', suggestion: 'create', confidence: 0.9, reason: 'Use "create" with resource: "channel"' },
    ]);

    // Database patterns (postgres, mysql, mongodb)
    patterns.set('database', [
      { pattern: 'selectData', suggestion: 'select', confidence: 0.95, reason: 'Use "select" instead of "selectData"' },
      { pattern: 'insertData', suggestion: 'insert', confidence: 0.95, reason: 'Use "insert" instead of "insertData"' },
      { pattern: 'updateData', suggestion: 'update', confidence: 0.95, reason: 'Use "update" instead of "updateData"' },
      { pattern: 'deleteData', suggestion: 'delete', confidence: 0.95, reason: 'Use "delete" instead of "deleteData"' },
      { pattern: 'query', suggestion: 'select', confidence: 0.7, reason: 'Use "select" for queries' },
      { pattern: 'fetch', suggestion: 'select', confidence: 0.7, reason: 'Use "select" to fetch data' },
    ]);

    // HTTP patterns
    patterns.set('httpRequest', [
      { pattern: 'fetch', suggestion: 'GET', confidence: 0.8, reason: 'Use "GET" method for fetching data' },
      { pattern: 'send', suggestion: 'POST', confidence: 0.7, reason: 'Use "POST" method for sending data' },
      { pattern: 'create', suggestion: 'POST', confidence: 0.8, reason: 'Use "POST" method for creating resources' },
      { pattern: 'update', suggestion: 'PUT', confidence: 0.8, reason: 'Use "PUT" method for updating resources' },
      { pattern: 'delete', suggestion: 'DELETE', confidence: 0.9, reason: 'Use "DELETE" method' },
    ]);

    // Generic patterns
    patterns.set('generic', [
      { pattern: 'list', suggestion: 'get', confidence: 0.6, reason: 'Consider using "get" or "search"' },
      { pattern: 'retrieve', suggestion: 'get', confidence: 0.8, reason: 'Use "get" to retrieve data' },
      { pattern: 'fetch', suggestion: 'get', confidence: 0.8, reason: 'Use "get" to fetch data' },
      { pattern: 'remove', suggestion: 'delete', confidence: 0.85, reason: 'Use "delete" to remove items' },
      { pattern: 'add', suggestion: 'create', confidence: 0.7, reason: 'Use "create" to add new items' },
    ]);

    return patterns;
  }

  /**
   * Find similar operations for an invalid operation using Levenshtein distance
   * and pattern matching algorithms
   *
   * @param nodeType - The n8n node type (e.g., 'nodes-base.slack')
   * @param invalidOperation - The invalid operation provided by the user
   * @param resource - Optional resource to filter operations
   * @param maxSuggestions - Maximum number of suggestions to return (default: 5)
   * @returns Array of operation suggestions sorted by confidence
   *
   * @example
   * findSimilarOperations('nodes-base.googleDrive', 'listFiles', 'fileFolder')
   * // Returns: [{ value: 'search', confidence: 0.85, reason: 'Use "search" with resource: "fileFolder" to list files' }]
   */
  findSimilarOperations(
    nodeType: string,
    invalidOperation: string,
    resource?: string,
    maxSuggestions: number = OperationSimilarityService.MAX_SUGGESTIONS
  ): OperationSuggestion[] {
    // SECURITY (GHSA-xvxq-x6hr-xc2c): no suggestions for values longer than any real name
    const maxLength = OperationSimilarityService.MAX_NAME_LENGTH;
    if ((typeof invalidOperation === 'string' && invalidOperation.length > maxLength) ||
        (typeof resource === 'string' && resource.length > maxLength)) {
      return [];
    }

    // Clean up expired cache entries periodically
    if (Math.random() < 0.1) { // 10% chance to cleanup on each call
      this.cleanupExpiredEntries();
    }
    // Check cache first
    const cacheKey = `${nodeType}:${invalidOperation}:${resource || ''}`;
    if (this.suggestionCache.has(cacheKey)) {
      return this.suggestionCache.get(cacheKey)!;
    }

    const suggestions: OperationSuggestion[] = [];

    // Get valid operations for the node
    let nodeInfo;
    try {
      nodeInfo = this.repository.getNode(nodeType);
      if (!nodeInfo) {
        return [];
      }
    } catch (error) {
      logger.warn(`Error getting node ${nodeType}:`, error);
      return [];
    }

    const validOperations = this.getNodeOperations(nodeType, resource);

    // Early termination for exact match - no suggestions needed
    for (const op of validOperations) {
      const opValue = this.getOperationValue(op);
      if (opValue.toLowerCase() === invalidOperation.toLowerCase()) {
        return []; // Valid operation, no suggestions needed
      }
    }

    // Check for exact pattern matches first
    const nodePatterns = this.getNodePatterns(nodeType);
    for (const pattern of nodePatterns) {
      if (pattern.pattern.toLowerCase() === invalidOperation.toLowerCase()) {
        // Type-safe operation value extraction
        const exists = validOperations.some(op => {
          const opValue = this.getOperationValue(op);
          return opValue === pattern.suggestion;
        });
        if (exists) {
          suggestions.push({
            value: pattern.suggestion,
            confidence: pattern.confidence,
            reason: pattern.reason,
            resource
          });
        }
      }
    }

    // Calculate similarity for all valid operations
    for (const op of validOperations) {
      const opValue = this.getOperationValue(op);

      const similarity = this.calculateSimilarity(invalidOperation, opValue);

      if (similarity >= OperationSimilarityService.MIN_CONFIDENCE) {
        // Don't add if already suggested by pattern
        if (!suggestions.some(s => s.value === opValue)) {
          suggestions.push({
            value: opValue,
            confidence: similarity,
            reason: this.getSimilarityReason(similarity, invalidOperation, opValue),
            resource: typeof op === 'object' ? op.resource : undefined,
            description: typeof op === 'object' ? (op.description || op.name) : undefined
          });
        }
      }
    }

    // Sort by confidence and limit
    suggestions.sort((a, b) => b.confidence - a.confidence);
    const topSuggestions = suggestions.slice(0, maxSuggestions);

    // Cache the result
    OperationSimilarityService.setBounded(
      this.suggestionCache, cacheKey, topSuggestions, OperationSimilarityService.MAX_SUGGESTION_CACHE_ENTRIES
    );

    return topSuggestions;
  }

  /**
   * Type-safe extraction of operation value from various formats
   * @param op - Operation object or string
   * @returns The operation value as a string
   */
  private getOperationValue(op: any): string {
    if (typeof op === 'string') {
      return op;
    }
    if (typeof op === 'object' && op !== null) {
      return op.operation || op.value || '';
    }
    return '';
  }

  /**
   * Type-safe extraction of resource value
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
   * Get operations for a node, handling resource filtering
   */
  private getNodeOperations(nodeType: string, resource?: string): any[] {
    // Cleanup cache periodically
    if (Math.random() < 0.05) { // 5% chance
      this.cleanupExpiredEntries();
    }

    const cacheKey = `${nodeType}:${resource || 'all'}`;
    const cached = this.operationCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < OperationSimilarityService.CACHE_DURATION_MS) {
      return cached.operations;
    }

    const nodeInfo = this.repository.getNode(nodeType);
    if (!nodeInfo) return [];

    let operations: any[] = [];

    // Parse operations from the node with safe JSON parsing
    try {
      const opsData = nodeInfo.operations;
      if (typeof opsData === 'string') {
        // Safe JSON parsing
        try {
          operations = JSON.parse(opsData);
        } catch (parseError) {
          logger.error(`JSON parse error for operations in ${nodeType}:`, parseError);
          throw ValidationServiceError.jsonParseError(nodeType, parseError as Error);
        }
      } else if (Array.isArray(opsData)) {
        operations = opsData;
      } else if (opsData && typeof opsData === 'object') {
        operations = Object.values(opsData).flat();
      }
    } catch (error) {
      // Re-throw ValidationServiceError, log and continue for others
      if (error instanceof ValidationServiceError) {
        throw error;
      }
      logger.warn(`Failed to process operations for ${nodeType}:`, error);
    }

    // Also check properties for operation fields
    try {
      const properties = nodeInfo.properties || [];
      for (const prop of properties) {
        if (prop.name === 'operation' && prop.options) {
          // Filter by resource if specified
          if (prop.displayOptions?.show?.resource) {
            const allowedResources = Array.isArray(prop.displayOptions.show.resource)
              ? prop.displayOptions.show.resource
              : [prop.displayOptions.show.resource];
            // Only filter if a specific resource is requested
            if (resource && !allowedResources.includes(resource)) {
              continue;
            }
            // If no resource specified, include all operations
          }

          operations.push(...prop.options.map((opt: any) => ({
            operation: opt.value,
            name: opt.name,
            description: opt.description,
            resource
          })));
        }
      }
    } catch (error) {
      logger.warn(`Failed to extract operations from properties for ${nodeType}:`, error);
    }

    // Cache and return
    OperationSimilarityService.setBounded(
      this.operationCache, cacheKey, { operations, timestamp: Date.now() }, OperationSimilarityService.MAX_OPERATION_CACHE_ENTRIES
    );
    return operations;
  }

  /**
   * Get patterns for a specific node type
   */
  private getNodePatterns(nodeType: string): OperationPattern[] {
    const patterns: OperationPattern[] = [];

    // Add node-specific patterns
    if (nodeType.includes('googleDrive')) {
      patterns.push(...(this.commonPatterns.get('googleDrive') || []));
    } else if (nodeType.includes('slack')) {
      patterns.push(...(this.commonPatterns.get('slack') || []));
    } else if (nodeType.includes('postgres') || nodeType.includes('mysql') || nodeType.includes('mongodb')) {
      patterns.push(...(this.commonPatterns.get('database') || []));
    } else if (nodeType.includes('httpRequest')) {
      patterns.push(...(this.commonPatterns.get('httpRequest') || []));
    }

    // Always add generic patterns
    patterns.push(...(this.commonPatterns.get('generic') || []));

    return patterns;
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
      return Math.max(OperationSimilarityService.CONFIDENCE_THRESHOLDS.MIN_SUBSTRING, ratio);
    }

    // Calculate Levenshtein distance
    const distance = this.levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);

    // Convert distance to similarity (0 to 1)
    let similarity = 1 - (distance / maxLength);

    // Boost confidence for single character typos and transpositions in short words
    if (distance === 1 && maxLength <= 5) {
      similarity = Math.max(similarity, 0.75);
    } else if (distance === 2 && maxLength <= 5) {
      // Boost for transpositions
      similarity = Math.max(similarity, 0.72);
    }

    // Boost similarity for common patterns
    if (this.areCommonVariations(s1, s2)) {
      return Math.min(1.0, similarity + 0.2);
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
   * Check if two strings are common variations
   */
  private areCommonVariations(str1: string, str2: string): boolean {
    // Handle edge cases first
    if (str1 === '' || str2 === '' || str1 === str2) {
      return false;
    }

    // Check for common prefixes/suffixes
    const commonPrefixes = ['get', 'set', 'create', 'delete', 'update', 'send', 'fetch'];
    const commonSuffixes = ['data', 'item', 'record', 'message', 'file', 'folder'];

    for (const prefix of commonPrefixes) {
      if ((str1.startsWith(prefix) && !str2.startsWith(prefix)) ||
          (!str1.startsWith(prefix) && str2.startsWith(prefix))) {
        const s1Clean = str1.startsWith(prefix) ? str1.slice(prefix.length) : str1;
        const s2Clean = str2.startsWith(prefix) ? str2.slice(prefix.length) : str2;
        // Only return true if at least one string was actually cleaned (not empty after cleaning)
        if ((str1.startsWith(prefix) && s1Clean !== str1) || (str2.startsWith(prefix) && s2Clean !== str2)) {
          if (s1Clean === s2Clean || this.levenshteinDistance(s1Clean, s2Clean) <= 2) {
            return true;
          }
        }
      }
    }

    for (const suffix of commonSuffixes) {
      if ((str1.endsWith(suffix) && !str2.endsWith(suffix)) ||
          (!str1.endsWith(suffix) && str2.endsWith(suffix))) {
        const s1Clean = str1.endsWith(suffix) ? str1.slice(0, -suffix.length) : str1;
        const s2Clean = str2.endsWith(suffix) ? str2.slice(0, -suffix.length) : str2;
        // Only return true if at least one string was actually cleaned (not empty after cleaning)
        if ((str1.endsWith(suffix) && s1Clean !== str1) || (str2.endsWith(suffix) && s2Clean !== str2)) {
          if (s1Clean === s2Clean || this.levenshteinDistance(s1Clean, s2Clean) <= 2) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Generate a human-readable reason for the similarity
   * @param confidence - Similarity confidence score
   * @param invalid - The invalid operation string
   * @param valid - The valid operation string
   * @returns Human-readable explanation of the similarity
   */
  private getSimilarityReason(confidence: number, invalid: string, valid: string): string {
    const { VERY_HIGH, HIGH, MEDIUM } = OperationSimilarityService.CONFIDENCE_THRESHOLDS;

    if (confidence >= VERY_HIGH) {
      return 'Almost exact match - likely a typo';
    } else if (confidence >= HIGH) {
      return 'Very similar - common variation';
    } else if (confidence >= MEDIUM) {
      return 'Similar operation';
    } else if (invalid.includes(valid) || valid.includes(invalid)) {
      return 'Partial match';
    } else {
      return 'Possibly related operation';
    }
  }

  /**
   * Clear caches
   */
  clearCache(): void {
    this.operationCache.clear();
    this.suggestionCache.clear();
  }
}