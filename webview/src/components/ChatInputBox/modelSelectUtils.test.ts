import { describe, expect, it } from 'vitest';
import {
  buildModelDropdownSections,
  getModelProviderGroup,
  shouldGroupModels,
  shouldShowModelSearch,
  MODEL_SEARCH_THRESHOLD,
} from './modelSelectUtils';
import type { ModelInfo } from './types';

const model = (id: string): ModelInfo => ({ id, label: id });

describe('getModelProviderGroup', () => {
  it('extracts the provider prefix from provider/model ids', () => {
    expect(getModelProviderGroup('deepseek/deepseek-v4-flash')).toBe('deepseek');
    expect(getModelProviderGroup('kimi-code/k3')).toBe('kimi-code');
  });

  it('returns empty string for flat ids', () => {
    expect(getModelProviderGroup('auto')).toBe('');
    expect(getModelProviderGroup('claude-sonnet-4-6')).toBe('');
    expect(getModelProviderGroup('/leading-slash')).toBe('');
  });
});

describe('shouldGroupModels', () => {
  it('groups only when at least two distinct provider prefixes exist', () => {
    expect(shouldGroupModels([model('auto'), model('deepseek/a'), model('kimi-code/b')])).toBe(true);
    expect(shouldGroupModels([model('auto'), model('deepseek/a'), model('deepseek/b')])).toBe(false);
    expect(shouldGroupModels([model('auto'), model('smol')])).toBe(false);
  });
});

describe('shouldShowModelSearch', () => {
  it('shows search at the threshold or when a query is typed', () => {
    expect(shouldShowModelSearch(MODEL_SEARCH_THRESHOLD - 1, '')).toBe(false);
    expect(shouldShowModelSearch(MODEL_SEARCH_THRESHOLD, '')).toBe(true);
    expect(shouldShowModelSearch(1, 'k3')).toBe(true);
  });
});

describe('buildModelDropdownSections', () => {
  it('returns a single unlabeled section for flat lists', () => {
    const { sections, hiddenCount } = buildModelDropdownSections([
      model('auto'),
      model('deepseek/a'),
      model('deepseek/b'),
    ]);
    expect(sections).toEqual([{ id: 'all', label: '', models: [model('auto'), model('deepseek/a'), model('deepseek/b')] }]);
    expect(hiddenCount).toBe(0);
  });

  it('groups by provider prefix, putting prefix-less models in the other bucket', () => {
    const { sections, hiddenCount } = buildModelDropdownSections([
      model('auto'),
      model('fufei/kimi-k3'),
      model('kimi-code/k3'),
      model('kimi-code/k3-256k'),
    ]);
    expect(sections.map((s) => [s.id, s.models.map((m) => m.id)])).toEqual([
      ['other', ['auto']],
      ['fufei', ['fufei/kimi-k3']],
      ['kimi-code', ['kimi-code/k3', 'kimi-code/k3-256k']],
    ]);
    expect(hiddenCount).toBe(0);
  });

  it('caps visible rows across sections and reports the hidden count', () => {
    const models = [
      model('auto'),
      ...Array.from({ length: 4 }, (_, i) => model(`deepseek/m${i}`)),
      ...Array.from({ length: 4 }, (_, i) => model(`kimi-code/m${i}`)),
    ];
    const { sections, hiddenCount } = buildModelDropdownSections(models, { visibleLimit: 6 });
    const shown = sections.flatMap((s) => s.models.map((m) => m.id));
    expect(shown).toEqual(['auto', 'deepseek/m0', 'deepseek/m1', 'deepseek/m2', 'deepseek/m3', 'kimi-code/m0']);
    expect(hiddenCount).toBe(3);
  });
});
