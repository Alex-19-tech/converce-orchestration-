/**
 * Confidence Scorer for node-specific validations
 *
 * Provides confidence scores for node-specific recommendations,
 * allowing users to understand the reliability of suggestions.
 */

export interface ConfidenceScore {
  value: number; // 0.0 to 1.0
  reason: string;
  factors: ConfidenceFactor[];
}

export interface ConfidenceFactor {
  name: string;
  weight: number;
  matched: boolean;
  description: string;
}

export class ConfidenceScorer {
  /**
   * Calculate confidence score for resource locator recommendation
   */
  static scoreResourceLocatorRecommendation(
    fieldName: string,
    nodeType: string,
    value: string
  ): ConfidenceScore {
    const factors: ConfidenceFactor[] = [];
    let totalWeight = 0;
    let matchedWeight = 0;

    // Factor 1: Exact field name match (highest confidence)
    const exactFieldMatch = this.checkExactFieldMatch(fieldName, nodeType);
    factors.push({
      name: 'exact-field-match',
      weight: 0.5,
      matched: exactFieldMatch,
      description: `Field name '${fieldName}' is known to use resource locator in ${nodeType}`
    });

    // Factor 2: Field name pattern (medium confidence)
    const patternMatch = this.checkFieldPattern(fieldName);
    factors.push({
      name: 'field-pattern',
      weight: 0.3,
      matched: patternMatch,
      description: `Field name '${fieldName}' matches common resource locator patterns`
    });

    // Factor 3: Value pattern (low confidence)
    const valuePattern = this.checkValuePattern(value);
    factors.push({
      name: 'value-pattern',
      weight: 0.1,
      matched: valuePattern,
      description: 'Value contains patterns typical of resource identifiers'
    });

    // Factor 4: Node type category (medium confidence)
    const nodeCategory = this.checkNodeCategory(nodeType);
    factors.push({
      name: 'node-category',
      weight: 0.1,
      matched: nodeCategory,
      description: `Node type '${nodeType}' typically uses resource locators`
    });

    // Calculate final score
    for (const factor of factors) {
      totalWeight += factor.weight;
      if (factor.matched) {
        matchedWeight += factor.weight;
      }
    }

    const score = totalWeight > 0 ? matchedWeight / totalWeight : 0;

    // Determine reason based on score
    let reason: string;
    if (score >= 0.8) {
      reason = 'High confidence: Multiple strong indicators suggest resource locator format';
    } else if (score >= 0.5) {
      reason = 'Medium confidence: Some indicators suggest resource locator format';
    } else if (score >= 0.3) {
      reason = 'Low confidence: Weak indicators for resource locator format';
    } else {
      reason = 'Very low confidence: Minimal evidence for resource locator format';
    }

    return {
      value: score,
      reason,
      factors
    };
  }

  /**
   * Known field mappings with exact matches
   */
  private static readonly EXACT_FIELD_MAPPINGS: Record<string, string[]> = {
    'github': ['owner', 'repository', 'user', 'organization'],
    'googlesheets': ['sheetId', 'documentId', 'spreadsheetId'],
    'googledrive': ['fileId', 'folderId', 'driveId'],
    'slack': ['channel', 'user', 'channelId', 'userId'],
    'notion': ['databaseId', 'pageId', 'blockId'],
    'airtable': ['baseId', 'tableId', 'viewId']
  };

  private static checkExactFieldMatch(fieldName: string, nodeType: string): boolean {
    const nodeBase = nodeType.split('.').pop()?.toLowerCase() || '';

    for (const [pattern, fields] of Object.entries(this.EXACT_FIELD_MAPPINGS)) {
      if (nodeBase === pattern || nodeBase.startsWith(`${pattern}-`)) {
        return fields.includes(fieldName);
      }
    }

    return false;
  }

  /**
   * Common patterns in field names that suggest resource locators
   */
  private static readonly FIELD_PATTERNS = [
    /^.*Id$/i,           // ends with Id
    /^.*Ids$/i,          // ends with Ids
    /^.*Key$/i,          // ends with Key
    /^.*Name$/i,         // ends with Name
    /^.*Path$/i,         // ends with Path
    /^.*Url$/i,          // ends with Url
    /^.*Uri$/i,          // ends with Uri
    /^(table|database|collection|bucket|folder|file|document|sheet|board|project|issue|user|channel|team|organization|repository|owner)$/i
  ];

  private static checkFieldPattern(fieldName: string): boolean {
    return this.FIELD_PATTERNS.some(pattern => pattern.test(fieldName));
  }

  /**
   * Check if the value looks like it contains identifiers
   */
  private static checkValuePattern(value: string): boolean {
    // Remove = prefix if present for analysis
    const content = value.startsWith('=') ? value.substring(1) : value;

    // Skip if not an expression
    if (!content.includes('{{') || !content.includes('}}')) {
      return false;
    }

    // Check for patterns that suggest IDs or resource references: a keyword
    // between '{{' and a later '}}' on the same line.
    // SECURITY (GHSA-xvxq-x6hr-xc2c): per-line indexOf scan instead of wildcard regexes
    const keyword = /id|key|name|path|url|uri/i;
    return content.split(/[\n\r\u2028\u2029]/).some(line => {
      const open = line.indexOf('{{');
      if (open === -1) return false;
      const close = line.lastIndexOf('}}');
      return close > open + 2 && keyword.test(line.slice(open + 2, close));
    });
  }

  /**
   * Node categories that commonly use resource locators
   */
  private static readonly RESOURCE_HEAVY_NODES = [
    'github', 'gitlab', 'bitbucket',           // Version control
    'googlesheets', 'googledrive', 'dropbox',  // Cloud storage
    'slack', 'discord', 'telegram',            // Communication
    'notion', 'airtable', 'baserow',          // Databases
    'jira', 'asana', 'trello', 'monday',      // Project management
    'salesforce', 'hubspot', 'pipedrive',     // CRM
    'stripe', 'paypal', 'square',             // Payment
    'aws', 'gcp', 'azure',                    // Cloud providers
    'mysql', 'postgres', 'mongodb', 'redis'   // Databases
  ];

  private static checkNodeCategory(nodeType: string): boolean {
    const nodeBase = nodeType.split('.').pop()?.toLowerCase() || '';

    return this.RESOURCE_HEAVY_NODES.some(category =>
      nodeBase.includes(category)
    );
  }

  /**
   * Get confidence level as a string
   */
  static getConfidenceLevel(score: number): 'high' | 'medium' | 'low' | 'very-low' {
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    if (score >= 0.3) return 'low';
    return 'very-low';
  }

  /**
   * Should apply recommendation based on confidence and threshold
   */
  static shouldApplyRecommendation(
    score: number,
    threshold: 'strict' | 'normal' | 'relaxed' = 'normal'
  ): boolean {
    const thresholds = {
      strict: 0.8,   // Only apply high confidence recommendations
      normal: 0.5,   // Apply medium and high confidence
      relaxed: 0.3   // Apply low, medium, and high confidence
    };

    return score >= thresholds[threshold];
  }
}