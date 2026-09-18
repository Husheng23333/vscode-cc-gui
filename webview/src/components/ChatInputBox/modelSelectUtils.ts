/**
 * Pure helpers for the model dropdown: provider grouping and list shaping.
 * Used heavily by OMP/OpenCode (provider/model ids) but works for any long
 * model catalog that follows the same shape.
 *
 * Ported from jetbrains-cc-gui (pinning intentionally omitted).
 */

import type { ModelInfo } from './types';

/** Show search once the list is long enough to scroll through. */
export const MODEL_SEARCH_THRESHOLD = 8;

/** Cap rendered rows so huge catalogs stay responsive; search finds the rest. */
export const MAX_VISIBLE_MODEL_OPTIONS = 100;

export interface ModelGroup {
  id: string;
  label: string;
  models: ModelInfo[];
}

/**
 * Extract the vendor/group key from a model id.
 * OpenCode-style ids look like `opencode/big-pickle` → `opencode`.
 * Flat ids (Claude, Codex, OMP 'auto') return empty string (no group).
 */
export function getModelProviderGroup(modelId: string): string {
  const slash = modelId.indexOf('/');
  if (slash <= 0) return '';
  return modelId.slice(0, slash).trim();
}

export function shouldShowModelSearch(modelCount: number, searchQuery: string): boolean {
  return modelCount >= MODEL_SEARCH_THRESHOLD || searchQuery.trim().length > 0;
}

/**
 * Whether the list should render provider section headers.
 * Only when at least two distinct non-empty provider prefixes exist.
 */
export function shouldGroupModels(models: ModelInfo[]): boolean {
  const groups = new Set<string>();
  for (const model of models) {
    const group = getModelProviderGroup(model.id);
    if (group) groups.add(group);
    if (groups.size >= 2) return true;
  }
  return false;
}

/**
 * Build dropdown sections: either one flat section or provider-prefix groups.
 * Models without a provider prefix (e.g. OMP 'auto') land in the 'other' bucket.
 *
 * `visibleLimit` caps total models across all sections.
 */
export function buildModelDropdownSections(
  models: ModelInfo[],
  options?: { visibleLimit?: number },
): { sections: ModelGroup[]; hiddenCount: number } {
  const visibleLimit = options?.visibleLimit ?? MAX_VISIBLE_MODEL_OPTIONS;
  const useGroups = shouldGroupModels(models);

  const sections: ModelGroup[] = [];
  let remaining = visibleLimit;

  if (useGroups) {
    const order: string[] = [];
    const buckets = new Map<string, ModelInfo[]>();
    for (const model of models) {
      const key = getModelProviderGroup(model.id) || 'other';
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key)!.push(model);
    }
    for (const key of order) {
      if (remaining <= 0) break;
      const bucket = buckets.get(key) ?? [];
      const slice = bucket.slice(0, remaining);
      remaining -= slice.length;
      if (slice.length > 0) {
        sections.push({ id: key, label: key, models: slice });
      }
    }
  } else if (models.length > 0) {
    const slice = models.slice(0, remaining);
    sections.push({ id: 'all', label: '', models: slice });
  }

  const totalShown = sections.reduce((n, s) => n + s.models.length, 0);
  return { sections, hiddenCount: Math.max(0, models.length - totalShown) };
}
