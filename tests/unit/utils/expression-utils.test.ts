/**
 * Tests for Expression Utilities
 *
 * Comprehensive test suite for n8n expression detection utilities
 * that help validators understand when to skip literal validation
 */

import { describe, it, expect } from 'vitest';
import {
  isExpression,
  containsExpression,
  shouldSkipLiteralValidation,
  extractExpressionContent,
  hasMixedContent
} from '../../../src/utils/expression-utils';

describe('Expression Utilities', () => {
  describe('isExpression', () => {
    describe('Valid expressions', () => {
      it('should detect expression with = prefix and {{ }}', () => {
        expect(isExpression('={{ $json.value }}')).toBe(true);
      });

      it('should detect expression with = prefix only', () => {
        expect(isExpression('=$json.value')).toBe(true);
      });

      it('should detect mixed content expression', () => {
        expect(isExpression('=https://api.com/{{ $json.id }}/data')).toBe(true);
      });

      it('should detect expression with complex content', () => {
        expect(isExpression('={{ $json.items.map(item => item.id) }}')).toBe(true);
      });
    });

    describe('Non-expressions', () => {
      it('should return false for plain strings', () => {
        expect(isExpression('plain text')).toBe(false);
      });

      it('should return false for URLs without = prefix', () => {
        expect(isExpression('https://api.example.com')).toBe(false);
      });

      it('should return false for {{ }} without = prefix', () => {
        expect(isExpression('{{ $json.value }}')).toBe(false);
      });

      it('should return false for empty string', () => {
        expect(isExpression('')).toBe(false);
      });
    });

    describe('Edge cases', () => {
      it('should return false for null', () => {
        expect(isExpression(null)).toBe(false);
      });

      it('should return false for undefined', () => {
        expect(isExpression(undefined)).toBe(false);
      });

      it('should return false for number', () => {
        expect(isExpression(123)).toBe(false);
      });

      it('should return false for object', () => {
        expect(isExpression({})).toBe(false);
      });

      it('should return false for array', () => {
        expect(isExpression([])).toBe(false);
      });

      it('should return false for boolean', () => {
        expect(isExpression(true)).toBe(false);
      });
    });

    describe('Type narrowing', () => {
      it('should narrow type to string when true', () => {
        const value: unknown = '=$json.value';
        if (isExpression(value)) {
          // This should compile because isExpression is a type predicate
          const length: number = value.length;
          expect(length).toBeGreaterThan(0);
        }
      });
    });
  });

  describe('containsExpression', () => {
    describe('Valid expression markers', () => {
      it('should detect {{ }} markers', () => {
        expect(containsExpression('{{ $json.value }}')).toBe(true);
      });

      it('should detect expression markers in mixed content', () => {
        expect(containsExpression('Hello {{ $json.name }}!')).toBe(true);
      });

      it('should detect multiple expression markers', () => {
        expect(containsExpression('{{ $json.first }} and {{ $json.second }}')).toBe(true);
      });

      it('should detect expression with = prefix', () => {
        expect(containsExpression('={{ $json.value }}')).toBe(true);
      });

      it('should detect expressions with newlines', () => {
        expect(containsExpression('{{ $json.items\n  .map(item => item.id) }}')).toBe(true);
      });
    });

    describe('Non-expressions', () => {
      it('should return false for plain strings', () => {
        expect(containsExpression('plain text')).toBe(false);
      });

      it('should return false for = prefix without {{ }}', () => {
        expect(containsExpression('=$json.value')).toBe(false);
      });

      it('should return false for single braces', () => {
        expect(containsExpression('{ value }')).toBe(false);
      });

      it('should return false for empty string', () => {
        expect(containsExpression('')).toBe(false);
      });
    });

    describe('Edge cases', () => {
      it('should return false for null', () => {
        expect(containsExpression(null)).toBe(false);
      });

      it('should return false for undefined', () => {
        expect(containsExpression(undefined)).toBe(false);
      });

      it('should return false for number', () => {
        expect(containsExpression(123)).toBe(false);
      });

      it('should return false for object', () => {
        expect(containsExpression({})).toBe(false);
      });

      it('should return false for array', () => {
        expect(containsExpression([])).toBe(false);
      });

      it('should detect markers that share a brace', () => {
        expect(containsExpression('{{}}')).toBe(true);
        expect(containsExpression('{{}')).toBe(false);
        expect(containsExpression('{{{}}')).toBe(true);
        expect(containsExpression('}} {{')).toBe(false);
      });
    });

    describe('Long input', () => {
      it('handles a long run of braces', () => {
        const start = performance.now();
        expect(containsExpression('{'.repeat(130_000))).toBe(false);
        expect(containsExpression('{'.repeat(130_000) + '}}')).toBe(true);
        expect(containsExpression('{{a'.repeat(30_000))).toBe(false);
        expect(performance.now() - start).toBeLessThan(2000);
      });
    });
  });

  describe('shouldSkipLiteralValidation', () => {
    describe('Should skip validation', () => {
      it('should skip for expression with = prefix and {{ }}', () => {
        expect(shouldSkipLiteralValidation('={{ $json.value }}')).toBe(true);
      });

      it('should skip for expression with = prefix only', () => {
        expect(shouldSkipLiteralValidation('=$json.value')).toBe(true);
      });

      it('should skip for {{ }} without = prefix', () => {
        expect(shouldSkipLiteralValidation('{{ $json.value }}')).toBe(true);
      });

      it('should skip for mixed content with expressions', () => {
        expect(shouldSkipLiteralValidation('https://api.com/{{ $json.id }}/data')).toBe(true);
      });

      it('should skip for expression URL', () => {
        expect(shouldSkipLiteralValidation('={{ $json.baseUrl }}/api')).toBe(true);
      });
    });

    describe('Should not skip validation', () => {
      it('should validate plain strings', () => {
        expect(shouldSkipLiteralValidation('plain text')).toBe(false);
      });

      it('should validate literal URLs', () => {
        expect(shouldSkipLiteralValidation('https://api.example.com')).toBe(false);
      });

      it('should validate JSON strings', () => {
        expect(shouldSkipLiteralValidation('{"key": "value"}')).toBe(false);
      });

      it('should validate numbers', () => {
        expect(shouldSkipLiteralValidation(123)).toBe(false);
      });

      it('should validate null', () => {
        expect(shouldSkipLiteralValidation(null)).toBe(false);
      });
    });

    describe('Real-world use cases', () => {
      it('should skip validation for expression-based URLs', () => {
        const url = '={{ $json.protocol }}://{{ $json.domain }}/api';
        expect(shouldSkipLiteralValidation(url)).toBe(true);
      });

      it('should skip validation for expression-based JSON', () => {
        const json = '={{ { key: $json.value } }}';
        expect(shouldSkipLiteralValidation(json)).toBe(true);
      });

      it('should not skip validation for literal URLs', () => {
        const url = 'https://api.example.com/endpoint';
        expect(shouldSkipLiteralValidation(url)).toBe(false);
      });

      it('should not skip validation for literal JSON', () => {
        const json = '{"userId": 123, "name": "test"}';
        expect(shouldSkipLiteralValidation(json)).toBe(false);
      });
    });
  });

  describe('extractExpressionContent', () => {
    describe('Expression with = prefix and {{ }}', () => {
      it('should extract content from ={{ }}', () => {
        expect(extractExpressionContent('={{ $json.value }}')).toBe('$json.value');
      });

      it('should extract complex expression', () => {
        expect(extractExpressionContent('={{ $json.items.map(i => i.id) }}')).toBe('$json.items.map(i => i.id)');
      });

      it('should trim whitespace', () => {
        expect(extractExpressionContent('={{   $json.value   }}')).toBe('$json.value');
      });
    });

    describe('Expression with = prefix only', () => {
      it('should extract content from = prefix', () => {
        expect(extractExpressionContent('=$json.value')).toBe('$json.value');
      });

      it('should handle complex expressions without {{ }}', () => {
        expect(extractExpressionContent('=$json.items[0].name')).toBe('$json.items[0].name');
      });
    });

    describe('Non-expressions', () => {
      it('should return original value for plain strings', () => {
        expect(extractExpressionContent('plain text')).toBe('plain text');
      });

      it('should return original value for {{ }} without = prefix', () => {
        expect(extractExpressionContent('{{ $json.value }}')).toBe('{{ $json.value }}');
      });
    });

    describe('Edge cases', () => {
      it('should handle empty expression', () => {
        expect(extractExpressionContent('=')).toBe('');
      });

      it('should handle expression with only {{ }}', () => {
        // Empty braces don't match the regex pattern, returns as-is
        expect(extractExpressionContent('={{}}')).toBe('{{}}');
      });

      it('should handle nested braces (not valid but should not crash)', () => {
        // The regex extracts content between outermost {{ }}
        expect(extractExpressionContent('={{ {{ value }} }}')).toBe('{{ value }}');
      });
    });
  });

  describe('hasMixedContent', () => {
    describe('Mixed content cases', () => {
      it('should detect mixed content with text and expression', () => {
        expect(hasMixedContent('Hello {{ $json.name }}!')).toBe(true);
      });

      it('should detect URL with expression segments', () => {
        expect(hasMixedContent('https://api.com/{{ $json.id }}/data')).toBe(true);
      });

      it('should detect multiple expressions in text', () => {
        expect(hasMixedContent('{{ $json.first }} and {{ $json.second }}')).toBe(true);
      });

      it('should detect JSON with expressions', () => {
        expect(hasMixedContent('{"id": {{ $json.id }}, "name": "test"}')).toBe(true);
      });
    });

    describe('Pure expression cases', () => {
      it('should return false for pure expression with = prefix', () => {
        expect(hasMixedContent('={{ $json.value }}')).toBe(false);
      });

      it('should return true for {{ }} without = prefix (ambiguous case)', () => {
        // Without = prefix, we can't distinguish between pure expression and mixed content
        // So it's treated as mixed to be safe
        expect(hasMixedContent('{{ $json.value }}')).toBe(true);
      });

      it('should return false for expression with whitespace', () => {
        expect(hasMixedContent('  ={{ $json.value }}  ')).toBe(false);
      });
    });

    describe('Non-expression cases', () => {
      it('should return false for plain text', () => {
        expect(hasMixedContent('plain text')).toBe(false);
      });

      it('should return false for literal URLs', () => {
        expect(hasMixedContent('https://api.example.com')).toBe(false);
      });

      it('should return false for = prefix without {{ }}', () => {
        expect(hasMixedContent('=$json.value')).toBe(false);
      });
    });

    describe('Edge cases', () => {
      it('should return false for null', () => {
        expect(hasMixedContent(null)).toBe(false);
      });

      it('should return false for undefined', () => {
        expect(hasMixedContent(undefined)).toBe(false);
      });

      it('should return false for number', () => {
        expect(hasMixedContent(123)).toBe(false);
      });

      it('should return false for object', () => {
        expect(hasMixedContent({})).toBe(false);
      });

      it('should return false for array', () => {
        expect(hasMixedContent([])).toBe(false);
      });

      it('should return false for empty string', () => {
        expect(hasMixedContent('')).toBe(false);
      });
    });

    describe('Type guard effectiveness', () => {
      it('should handle non-string types without calling containsExpression', () => {
        // This tests the fix from Phase 1 - type guard must come before containsExpression
        expect(() => hasMixedContent(123)).not.toThrow();
        expect(() => hasMixedContent(null)).not.toThrow();
        expect(() => hasMixedContent(undefined)).not.toThrow();
        expect(() => hasMixedContent({})).not.toThrow();
      });
    });
  });

  describe('Integration scenarios', () => {
    it('should correctly identify expression-based URL in HTTP Request node', () => {
      const url = '={{ $json.baseUrl }}/users/{{ $json.userId }}';

      expect(isExpression(url)).toBe(true);
      expect(containsExpression(url)).toBe(true);
      expect(shouldSkipLiteralValidation(url)).toBe(true);
      expect(hasMixedContent(url)).toBe(true);
    });

    it('should correctly identify literal URL for validation', () => {
      const url = 'https://api.example.com/users/123';

      expect(isExpression(url)).toBe(false);
      expect(containsExpression(url)).toBe(false);
      expect(shouldSkipLiteralValidation(url)).toBe(false);
      expect(hasMixedContent(url)).toBe(false);
    });

    it('should handle expression in JSON body', () => {
      const json = '={{ { userId: $json.id, timestamp: $now } }}';

      expect(isExpression(json)).toBe(true);
      expect(shouldSkipLiteralValidation(json)).toBe(true);
      expect(extractExpressionContent(json)).toBe('{ userId: $json.id, timestamp: $now }');
    });

    it('should handle webhook path with expressions', () => {
      const path = '=/webhook/{{ $json.customerId }}/notify';

      expect(isExpression(path)).toBe(true);
      expect(containsExpression(path)).toBe(true);
      expect(shouldSkipLiteralValidation(path)).toBe(true);
      expect(extractExpressionContent(path)).toBe('/webhook/{{ $json.customerId }}/notify');
    });
  });

  describe('Performance characteristics', () => {
    it('should use efficient regex for containsExpression', () => {
      // The implementation should use a single regex test, not two includes()
      const value = 'text {{ expression }} more text';
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        containsExpression(value);
      }
      const duration = performance.now() - start;

      // Performance test - should complete in reasonable time
      expect(duration).toBeLessThan(100); // 100ms for 10k iterations
    });
  });
});
