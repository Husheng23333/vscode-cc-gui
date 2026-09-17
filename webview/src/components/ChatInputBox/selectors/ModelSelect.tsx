import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_MODELS, normalizeClaudeModelId, modelSupports1MContext, strip1MContextSuffix } from '../types';
import type { ModelInfo } from '../types';
import { readClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import Switch from 'antd/es/switch';
import {
  MODEL_ID_TO_MAPPING_KEY,
  resolveModelDescription,
  resolveModelDisplayLabel,
  resolveModelIdForIcon,
} from '../modelLabelUtils';
import {
  buildModelDropdownSections,
  MAX_VISIBLE_MODEL_OPTIONS,
  shouldShowModelSearch,
} from '../modelSelectUtils';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  maxWidth: 'calc(100vw - 16px)',
  overflowX: 'hidden',
};
const MODEL_OPTION_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' };
const MODEL_TEXT_STYLE: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const LONG_CONTEXT_OPTION_STYLE: React.CSSProperties = { justifyContent: 'space-between', cursor: 'default' };
const LONG_CONTEXT_LABEL_STYLE: React.CSSProperties = { fontSize: '12px' };
interface ModelSelectProps {
  value: string;
  onChange: (modelId: string) => void;
  models?: ModelInfo[];
  currentProvider?: string;
  /** True while CLI providers (OpenCode / Kimi) are still fetching model catalogs. */
  loading?: boolean;
  /** Set when the CLI model catalog fetch failed (or timed out); row offers retry. */
  error?: string | null;
  /** Retries the CLI model catalog fetch for the current provider. */
  onRetry?: () => void;
  onAddModel?: () => void;
  longContextEnabled?: boolean;
  onLongContextChange?: (enabled: boolean) => void;
  /** Render only the dropdown, positioned as a fly-out from triggerRef. */
  embedded?: boolean;
  /** Render the list flat inside a parent popover: no positioning, no close-on-select. */
  inline?: boolean;
  triggerRef?: React.RefObject<HTMLElement | null>;
  onClose?: () => void;
  /** Hide the 1M toggle when the parent menu already exposes it. */
  hideLongContextToggle?: boolean;
}

const LOADING_OPTION_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'default',
};

/** Cap dropdown height so long model catalogs (e.g. OpenCode) stay usable. */
const MODEL_DROPDOWN_MAX_HEIGHT = 300;

/**
 * ModelSelect - Model selector component
 * Supports switching between Sonnet 4.5, Opus 4.5, and other models, including Codex models
 */
export const ModelSelect = ({
  value,
  onChange,
  models = AVAILABLE_MODELS,
  currentProvider = 'claude',
  loading = false,
  error = null,
  onRetry,
  onAddModel,
  longContextEnabled = true,
  onLongContextChange,
  embedded = false,
  inline = false,
  triggerRef,
  onClose,
  hideLongContextToggle = false,
}: ModelSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, maxHeight, maxWidth, recalculate } = useDropdownPosition({
    buttonRef: (embedded ? triggerRef : buttonRef) as React.RefObject<HTMLElement | null>,
    dropdownRef,
    preferredAlignment: 'right',
    submenu: embedded,
    minWidth: embedded ? 220 : 200,
    maxWidth: 360,
    submenuMaxHeight: MODEL_DROPDOWN_MAX_HEIGHT,
  });
  const dropdownMaxHeight = maxHeight != null
    ? Math.min(maxHeight, MODEL_DROPDOWN_MAX_HEIGHT)
    : MODEL_DROPDOWN_MAX_HEIGHT;

  // Strip [1m] suffix for finding the model in the list
  const strippedValue = strip1MContextSuffix(value);
  const normalizedValue = currentProvider === 'claude' ? normalizeClaudeModelId(strippedValue) : strippedValue;
  // Prefer the user's selection even when it is absent from the dropdown list
  // (e.g. an OMP role id set via the mode selector, or a catalog still loading).
  // Falling back to models[0] would visually snap the trigger to the first entry.
  const currentModel = models.find(m => m.id === normalizedValue)
    || models.find(m => m.id === strippedValue)
    || (strippedValue
      ? { id: strippedValue, label: strippedValue } as ModelInfo
      : models[0]);
  const modelMapping = readClaudeModelMapping();

  const isSelectedModel = (modelId: string): boolean => {
    if (currentProvider !== 'claude') {
      return modelId === strippedValue;
    }
    return normalizeClaudeModelId(modelId) === normalizedValue;
  };

  const getModelLabel = (model: ModelInfo, show1MContext = false): string => {
    return resolveModelDisplayLabel(model, {
      t,
      currentProvider,
      modelMapping: currentProvider === 'claude' ? modelMapping : {},
      show1MContext,
      longContextEnabled,
    });
  };

  const getModelDescription = (model: ModelInfo): string | undefined => {
    return resolveModelDescription(model, t);
  };

  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase();
  const filteredModels = normalizedSearchQuery
    ? models.filter((model) => {
        const label = getModelLabel(model, false);
        const description = getModelDescription(model) ?? '';
        return [model.id, label, description].some((value) => value.toLowerCase().includes(normalizedSearchQuery));
      })
    : models;
  const { sections, hiddenCount: hiddenModelCount } = buildModelDropdownSections(filteredModels, {
    visibleLimit: MAX_VISIBLE_MODEL_OPTIONS,
  });
  const visibleModelCount = sections.reduce((n, s) => n + s.models.length, 0);
  const showSearch = shouldShowModelSearch(models.length, searchQuery);

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (!nextOpen) {
      setSearchQuery('');
    }
    if (nextOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  /**
   * Select model
   */
  const handleSelect = useCallback((modelId: string) => {
    onChange(modelId);
    if (inline) return;
    setIsOpen(false);
    setSearchQuery('');
    onClose?.();
  }, [inline, onChange, onClose]);

  /**
   * Close on outside click
   */
  useEffect(() => {
    if (embedded || !isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    // Delay adding event listener to prevent immediate trigger
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [embedded, isOpen]);

  useLayoutEffect(() => {
    if (!inline && (embedded || isOpen)) {
      recalculate();
    }
  }, [embedded, inline, isOpen, filteredModels.length, loading, recalculate]);

  const dropdownStyle: React.CSSProperties = embedded
    ? {
        minWidth: 0,
        maxWidth: maxWidth ?? 360,
        maxHeight: dropdownMaxHeight,
        overflowX: 'hidden',
        overflowY: 'auto',
        ...positionedStyle,
      }
    : {
        ...DROPDOWN_STYLE,
        ...positionedStyle,
        maxHeight: dropdownMaxHeight,
        overflowY: 'auto',
      };

  const renderDropdown = () => (
        <div
          ref={dropdownRef}
          className={inline ? 'model-selector-inline' : 'selector-dropdown model-selector-dropdown'}
          data-testid="model-selector-dropdown"
          style={inline ? undefined : dropdownStyle}
          onMouseEnter={(e) => e.stopPropagation()}
        >
          {showSearch && (
            <div className="selector-search-row">
              <input
                className="selector-search-input"
                data-testid="model-search-input"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('models.searchPlaceholder', { defaultValue: 'Search models' })}
                autoFocus
              />
            </div>
          )}
          {loading && (
            <div
              className="selector-option selector-option-status"
              data-testid="model-loading"
              style={LOADING_OPTION_STYLE}
            >
              <span className="codicon codicon-loading codicon-modifier-spin" />
              <span>{t('chat.loadingDropdown', { defaultValue: 'Loading…' })}</span>
            </div>
          )}
          {!loading && error && (
            <div
              className="selector-option selector-option-status"
              data-testid="model-load-error"
              style={{ ...LOADING_OPTION_STYLE, cursor: onRetry ? 'pointer' : 'default' }}
              title={error}
              onClick={() => onRetry?.()}
            >
              <span className="codicon codicon-warning" />
              <span>
                {t('models.cliLoadFailed', {
                  defaultValue: 'Failed to load models. Click to retry.',
                })}
              </span>
            </div>
          )}
          {sections.map((section) => (
            <div key={section.id} className="model-selector-section" data-testid={`model-section-${section.id}`}>
              {section.label !== '' && (
                <div className="model-selector-group-header" data-testid={`model-group-${section.id}`}>
                  <span>{section.label}</span>
                </div>
              )}
              {section.models.map((model) => (
                <div
                  key={model.id}
                  className={`selector-option ${isSelectedModel(model.id) ? 'selected' : ''}`}
                  onClick={() => handleSelect(model.id)}
                  data-testid={`model-option-${model.id}`}
                >
                  <ProviderModelIcon
                    providerId={currentProvider}
                    modelId={resolveModelIdForIcon(model.id, currentProvider === 'claude' ? modelMapping : {}, MODEL_ID_TO_MAPPING_KEY)}
                    size={16}
                    colored
                  />
                  <div style={MODEL_OPTION_INFO_STYLE}>
                    <span style={MODEL_TEXT_STYLE}>{getModelLabel(model, false)}</span>
                    {getModelDescription(model) && (
                      <span className="model-description" style={MODEL_TEXT_STYLE}>{getModelDescription(model)}</span>
                    )}
                  </div>
                  {isSelectedModel(model.id) && (
                    <span className="codicon codicon-check check-mark" />
                  )}
                </div>
              ))}
            </div>
          ))}
          {visibleModelCount === 0 && (
            <div className="selector-option selector-option-status">
              {t('models.noModelsFound', { defaultValue: 'No models found' })}
            </div>
          )}
          {hiddenModelCount > 0 && (
            <div className="selector-option selector-option-status" data-testid="model-hidden-count">
              {t('models.hiddenModelCount', {
                count: hiddenModelCount,
                defaultValue: `+ ${hiddenModelCount} more models. Type to search.`,
              })}
            </div>
          )}
          {!hideLongContextToggle && currentProvider === 'claude' && onLongContextChange && (
            <>
              <div className="selector-divider" />
              <div
                className="selector-option"
                style={LONG_CONTEXT_OPTION_STYLE}
                onClick={(e) => e.stopPropagation()}
              >
                <span style={LONG_CONTEXT_LABEL_STYLE}>{t('models.longContext.shortLabel')}</span>
                <Switch
                  size="small"
                  checked={modelSupports1MContext(value) ? longContextEnabled : false}
                  disabled={!modelSupports1MContext(value)}
                  onChange={onLongContextChange}
                />
              </div>
            </>
          )}
          {onAddModel && (
            <>
              <div className="selector-divider" />
              <div
                className="selector-option selector-option-add"
                onClick={() => {
                  onAddModel();
                  setIsOpen(false);
                  setSearchQuery('');
                  onClose?.();
                }}
              >
                <span className="codicon codicon-add selector-add-icon" />
                <span>{t('models.addModel')}</span>
              </div>
            </>
          )}
        </div>
  );

  if (embedded || inline) {
    return renderDropdown();
  }

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        title={t('chat.currentModel', { model: getModelLabel(currentModel, true) })}
      >
        <ProviderModelIcon
          providerId={currentProvider}
          modelId={
            currentModel
              ? resolveModelIdForIcon(currentModel.id, currentProvider === 'claude' ? modelMapping : {}, MODEL_ID_TO_MAPPING_KEY)
              : undefined
          }
          size={12}
          colored
        />
        <span className="selector-button-text">{getModelLabel(currentModel, true)}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && renderDropdown()}
    </div>
  );
};

export default ModelSelect;
