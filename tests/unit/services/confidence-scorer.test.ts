import { describe, it, expect } from 'vitest';
import { ConfidenceScorer } from '../../../src/services/confidence-scorer';

describe('ConfidenceScorer', () => {
  describe('scoreResourceLocatorRecommendation', () => {
    it('should give high confidence for exact field matches', () => {
      const score = ConfidenceScorer.scoreResourceLocatorRecommendation(
        'owner',
        'n8n-nodes-base.github',
        '={{ $json.owner }}'
      );

      expect(score.value).toBeGreaterThanOrEqual(0.5);
      expect(score.factors.find(f => f.name === 'exact-field-match')?.matched).toBe(true);
    });

    it('should give medium confidence for field pattern matches', () => {
      const score = ConfidenceScorer.scoreResourceLocatorRecommendation(
        'customerId',
        'n8n-nodes-base.customApi',
        '={{ $json.id }}'
      );

      expect(score.value).toBeGreaterThan(0);
      expect(score.value).toBeLessThan(0.8);
      expect(score.factors.find(f => f.name === 'field-pattern')?.matched).toBe(true);
    });

    it('should give low confidence for unrelated fields', () => {
      const score = ConfidenceScorer.scoreResourceLocatorRecommendation(
        'message',
        'n8n-nodes-base.emailSend',
        '={{ $json.content }}'
      );

      expect(score.value).toBeLessThan(0.3);
    });

    it('should consider value patterns', () => {
      const score = ConfidenceScorer.scoreResourceLocatorRecommendation(
        'target',
        'n8n-nodes-base.httpRequest',
        '={{ $json.userId }}'
      );

      const valueFactor = score.factors.find(f => f.name === 'value-pattern');
      expect(valueFactor?.matched).toBe(true);
    });

    it('should consider node category', () => {
      const scoreGitHub = ConfidenceScorer.scoreResourceLocatorRecommendation(
        'field',
        'n8n-nodes-base.github',
        '={{ $json.value }}'
      );

      const scoreEmail = ConfidenceScorer.scoreResourceLocatorRecommendation(
        'field',
        'n8n-nodes-base.emailSend',
        '={{ $json.value }}'
      );

      expect(scoreGitHub.value).toBeGreaterThan(scoreEmail.value);
    });

    it('should handle GitHub repository field with high confidence', () => {
      const score = ConfidenceScorer.scoreResourceLocatorRecommendation(
        'repository',
        'n8n-nodes-base.github',
        '={{ $vars.GITHUB_REPO }}'
      );

      expect(score.value).toBeGreaterThanOrEqual(0.5);
      expect(ConfidenceScorer.getConfidenceLevel(score.value)).not.toBe('very-low');
    });

    it('should handle Slack channel field with high confidence', () => {
      const score = ConfidenceScorer.scoreResourceLocatorRecommendation(
        'channel',
        'n8n-nodes-base.slack',
        '={{ $json.channelId }}'
      );

      expect(score.value).toBeGreaterThanOrEqual(0.5);
    });

    it('should only match identifier keywords inside an expression on one line', () => {
      const valueMatched = (value: string) =>
        ConfidenceScorer.scoreResourceLocatorRecommendation('target', 'n8n-nodes-base.httpRequest', value)
          .factors.find(f => f.name === 'value-pattern')?.matched;

      expect(valueMatched('={{ $json.user_KEY }}')).toBe(true);
      expect(valueMatched('=prefix {{ $json.a }} middle {{ $json.path }}')).toBe(true);
      expect(valueMatched('=id {{ $json.value }}')).toBe(false);
      expect(valueMatched('={{ $json.value }} id')).toBe(false);
      expect(valueMatched('={{ $json\n.id }}')).toBe(false);
    });

    it('handles a long expression value', () => {
      const start = performance.now();
      for (const value of ['{{}}' + '{{id'.repeat(1_450), '}}' + '{{.name'.repeat(1_200), '{{}}' + '{{id'.repeat(100_000)]) {
        const score = ConfidenceScorer.scoreResourceLocatorRecommendation('target', 'n8n-nodes-base.httpRequest', value);
        expect(score.factors.find(f => f.name === 'value-pattern')?.matched).toBe(false);
      }
      expect(performance.now() - start).toBeLessThan(2000);
    });
  });

  describe('getConfidenceLevel', () => {
    it('should return correct confidence levels', () => {
      expect(ConfidenceScorer.getConfidenceLevel(0.9)).toBe('high');
      expect(ConfidenceScorer.getConfidenceLevel(0.8)).toBe('high');
      expect(ConfidenceScorer.getConfidenceLevel(0.6)).toBe('medium');
      expect(ConfidenceScorer.getConfidenceLevel(0.5)).toBe('medium');
      expect(ConfidenceScorer.getConfidenceLevel(0.4)).toBe('low');
      expect(ConfidenceScorer.getConfidenceLevel(0.3)).toBe('low');
      expect(ConfidenceScorer.getConfidenceLevel(0.2)).toBe('very-low');
      expect(ConfidenceScorer.getConfidenceLevel(0)).toBe('very-low');
    });
  });

  describe('shouldApplyRecommendation', () => {
    it('should apply based on threshold', () => {
      // Strict threshold (0.8)
      expect(ConfidenceScorer.shouldApplyRecommendation(0.9, 'strict')).toBe(true);
      expect(ConfidenceScorer.shouldApplyRecommendation(0.7, 'strict')).toBe(false);

      // Normal threshold (0.5)
      expect(ConfidenceScorer.shouldApplyRecommendation(0.6, 'normal')).toBe(true);
      expect(ConfidenceScorer.shouldApplyRecommendation(0.4, 'normal')).toBe(false);

      // Relaxed threshold (0.3)
      expect(ConfidenceScorer.shouldApplyRecommendation(0.4, 'relaxed')).toBe(true);
      expect(ConfidenceScorer.shouldApplyRecommendation(0.2, 'relaxed')).toBe(false);
    });

    it('should use normal threshold by default', () => {
      expect(ConfidenceScorer.shouldApplyRecommendation(0.6)).toBe(true);
      expect(ConfidenceScorer.shouldApplyRecommendation(0.4)).toBe(false);
    });
  });

  describe('confidence factors', () => {
    it('should include all expected factors', () => {
      const score = ConfidenceScorer.scoreResourceLocatorRecommendation(
        'testField',
        'n8n-nodes-base.testNode',
        '={{ $json.test }}'
      );

      expect(score.factors).toHaveLength(4);
      expect(score.factors.map(f => f.name)).toContain('exact-field-match');
      expect(score.factors.map(f => f.name)).toContain('field-pattern');
      expect(score.factors.map(f => f.name)).toContain('value-pattern');
      expect(score.factors.map(f => f.name)).toContain('node-category');
    });

    it('should have reasonable weights', () => {
      const score = ConfidenceScorer.scoreResourceLocatorRecommendation(
        'testField',
        'n8n-nodes-base.testNode',
        '={{ $json.test }}'
      );

      const totalWeight = score.factors.reduce((sum, f) => sum + f.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 1);
    });
  });
});