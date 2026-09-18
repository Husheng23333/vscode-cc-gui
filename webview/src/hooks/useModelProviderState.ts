import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import {
  apply1MContextSuffix,
  isValidDshPreset,
  isValidPermissionMode,
  normalizeClaudeModelId,
  strip1MContextSuffix,
} from '../components/ChatInputBox/types';
import type { PermissionMode } from '../components/ChatInputBox/types';
import { isSpecialProviderId } from '../types/provider';
import { useClaudeProvider } from './providers/useClaudeProvider';
import { useCodexProvider } from './providers/useCodexProvider';
import { useGrokProvider } from './providers/useGrokProvider';
import { useKimiProvider } from './providers/useKimiProvider';
import { useMiniMaxProvider } from './providers/useMiniMaxProvider';
import { useOpenCodeProvider } from './providers/useOpenCodeProvider';
import { usePiProvider } from './providers/usePiProvider';
import { useOmpProvider } from './providers/useOmpProvider';
import { useDshProvider } from './providers/useDshProvider';
import { useZcodeProvider } from './providers/useZcodeProvider';
import { isCliOnlyProvider, normalizeCliPermissionMode, ompModeForModelId } from './providers/cliProviders';
import { useOmpRoles } from './providers/useCliModels';
import { useUsageTracking } from './providers/useUsageTracking';
import { useProviderSettings } from './providers/useProviderSettings';
import { useModelStatePersistence } from './providers/useModelStatePersistence';

export type ViewMode = 'chat' | 'history' | 'settings';

export interface UseModelProviderStateOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/**
 * Orchestrates provider/model/permission state across Claude / Codex / CLI providers.
 */
export function useModelProviderState({ addToast, t }: UseModelProviderStateOptions) {
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;

  const claude = useClaudeProvider();
  const codex = useCodexProvider();
  const grok = useGrokProvider();
  const kimi = useKimiProvider();
  const miniMax = useMiniMaxProvider();
  const openCode = useOpenCodeProvider();
  const pi = usePiProvider();
  const omp = useOmpProvider();
  // Dynamic omp model roles (listModels payload; static smol/slow/plan until
  // loaded) — drive mode⇔model unification for omp.
  const ompRoles = useOmpRoles();
  const dsh = useDshProvider();
  const zcode = useZcodeProvider();
  const { isSdkInstalled, ...usage } = useUsageTracking();
  const settings = useProviderSettings({ addToast, t });

  const {
    selectedClaudeModel, setSelectedClaudeModel,
    claudePermissionMode, setClaudePermissionMode,
    longContextEnabled, setLongContextEnabled,
    setClaudeSettingsAlwaysThinkingEnabled,
  } = claude;
  const {
    selectedCodexModel, setSelectedCodexModel,
    codexPermissionMode, setCodexPermissionMode,
    reasoningEffort, setReasoningEffort,
    codexFastMode, setCodexFastMode,
  } = codex;
  const {
    selectedGrokModel, setSelectedGrokModel,
    grokPermissionMode, setGrokPermissionMode,
  } = grok;
  const {
    selectedKimiModel, setSelectedKimiModel,
    kimiPermissionMode, setKimiPermissionMode,
  } = kimi;
  const {
    selectedMiniMaxModel, setSelectedMiniMaxModel,
    miniMaxPermissionMode, setMiniMaxPermissionMode,
  } = miniMax;
  const {
    selectedOpenCodeModel, setSelectedOpenCodeModel,
    openCodePermissionMode, setOpenCodePermissionMode,
  } = openCode;
  const {
    selectedPiModel, setSelectedPiModel,
    piPermissionMode, setPiPermissionMode,
  } = pi;
  const {
    selectedOmpModel, setSelectedOmpModel,
    ompPermissionMode, setOmpPermissionMode,
  } = omp;
  const {
    selectedDshModel, setSelectedDshModel,
    dshPermissionMode, setDshPermissionMode,
    dshPreset, setDshPreset,
  } = dsh;
  const {
    selectedZcodeModel, setSelectedZcodeModel,
    zcodePermissionMode, setZcodePermissionMode,
  } = zcode;

  useModelStatePersistence({
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedMiniMaxModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setSelectedOmpModel,
    setSelectedDshModel,
    setSelectedZcodeModel,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setMiniMaxPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setOmpPermissionMode,
    setDshPermissionMode,
    setZcodePermissionMode,
    setDshPreset,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setCodexFastMode,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    selectedGrokModel,
    selectedKimiModel,
    selectedMiniMaxModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedOmpModel,
    selectedDshModel,
    selectedZcodeModel,
    grokPermissionMode,
    kimiPermissionMode,
    miniMaxPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    ompPermissionMode,
    dshPermissionMode,
    zcodePermissionMode,
    dshPreset,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
  });

  const selectedModel = currentProvider === 'codex'
    ? selectedCodexModel
    : currentProvider === 'grok'
      ? selectedGrokModel
      : currentProvider === 'kimi'
        ? selectedKimiModel
        : currentProvider === 'minimax'
          ? selectedMiniMaxModel
          : currentProvider === 'opencode'
            ? selectedOpenCodeModel
            : currentProvider === 'pi'
              ? selectedPiModel
            : currentProvider === 'omp'
              ? selectedOmpModel
              : currentProvider === 'dsh'
                ? selectedDshModel
                : currentProvider === 'zcode'
                  ? selectedZcodeModel
                  : selectedClaudeModel;

  const currentSdkInstalled = useMemo(
    () => isSdkInstalled(currentProvider),
    [isSdkInstalled, currentProvider],
  );

  // Codex native auto review config is available in the verified @openai/codex-sdk 0.146.0 floor.
  // Unknown (`undefined`, backend has not reported yet) is treated conservatively as
  // unavailable so an 'auto' send cannot race the dependency-status response.
  const codexSdkMeetsMinimum = usage.sdkStatus?.['codex-sdk']?.meetsMinimumVersion;
  const codexNativeAutoReviewAvailable = codexSdkMeetsMinimum === true;

  // A saved auto mode can outlive the SDK that supports it. Reset it before a
  // send can race the dependency-status response; otherwise the selected mode
  // would be sent to an SDK that cannot implement the native reviewer.
  useEffect(() => {
    if (codexSdkMeetsMinimum !== false || codexPermissionMode !== 'auto') {
      return;
    }
    setCodexPermissionMode('default');
    if (currentProvider === 'codex' && permissionMode === 'auto') {
      setPermissionMode('default');
      sendBridgeEvent('set_mode', 'default');
    }
  }, [codexPermissionMode, codexSdkMeetsMinimum, currentProvider, permissionMode, setCodexPermissionMode, setPermissionMode]);

  const handleModeSelect = useCallback((mode: PermissionMode) => {
    if (currentProvider === 'codex') {
      const codexMode: PermissionMode = mode === 'plan'
        || (mode === 'auto' && codexSdkMeetsMinimum === false)
        ? 'default'
        : mode;
      setPermissionMode(codexMode);
      setCodexPermissionMode(codexMode);
      sendBridgeEvent('set_mode', codexMode);
      return;
    }
    if (isCliOnlyProvider(currentProvider)) {
      const cliMode = normalizeCliPermissionMode(mode, currentProvider);
      setPermissionMode(cliMode);
      if (currentProvider === 'grok') setGrokPermissionMode(cliMode);
      if (currentProvider === 'kimi') setKimiPermissionMode(cliMode);
      if (currentProvider === 'minimax') setMiniMaxPermissionMode(cliMode);
      if (currentProvider === 'opencode') setOpenCodePermissionMode(cliMode);
      if (currentProvider === 'pi') setPiPermissionMode(cliMode);
      if (currentProvider === 'dsh') setDshPermissionMode(cliMode);
      if (currentProvider === 'zcode') setZcodePermissionMode(cliMode);
      if (currentProvider === 'omp') {
        setOmpPermissionMode(cliMode);
        // The omp mode selector is a shortcut over the model value: role modes
        // set the model to the role id, 'default' selects the CLI default.
        const ompModel = cliMode === 'default' ? 'auto' : cliMode;
        setSelectedOmpModel(ompModel);
        sendBridgeEvent('set_model', ompModel);
        // The backend's VALID_PERMISSION_MODES is a static whitelist — dynamic
        // roles (e.g. 'designer') would be rejected there; set_model carries them.
        if (isValidPermissionMode(cliMode)) {
          sendBridgeEvent('set_mode', cliMode);
        }
        return;
      }
      sendBridgeEvent('set_mode', cliMode);
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeEvent('set_mode', mode);
  }, [
    currentProvider,
    codexSdkMeetsMinimum,
    setCodexPermissionMode,
    setClaudePermissionMode,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setMiniMaxPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setOmpPermissionMode,
    setSelectedOmpModel,
    setDshPermissionMode,
    setZcodePermissionMode,
  ]);

  const handleModelSelect = useCallback((modelId: string) => {
    if (currentProvider === 'claude') {
      const strippedModelId = strip1MContextSuffix(modelId);
      const normalizedModelId = normalizeClaudeModelId(strippedModelId);
      setSelectedClaudeModel(normalizedModelId);
      sendBridgeEvent('set_model', apply1MContextSuffix(normalizedModelId, longContextEnabled));
    } else if (currentProvider === 'codex') {
      setSelectedCodexModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'grok') {
      setSelectedGrokModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'kimi') {
      setSelectedKimiModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'minimax') {
      setSelectedMiniMaxModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'opencode') {
      setSelectedOpenCodeModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'pi') {
      setSelectedPiModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'omp') {
      setSelectedOmpModel(modelId);
      sendBridgeEvent('set_model', modelId);
      // Mode⇔model unification: role models select the same-named mode,
      // anything else ('auto' or catalog models) selects 'default'.
      const ompMode = ompModeForModelId(modelId, ompRoles);
      setOmpPermissionMode(ompMode);
      setPermissionMode(ompMode);
      // Dynamic roles are not in the backend's static mode whitelist — set_model
      // above already carries the role; skip set_mode for them.
      if (isValidPermissionMode(ompMode)) {
        sendBridgeEvent('set_mode', ompMode);
      }
    } else if (currentProvider === 'dsh') {
      setSelectedDshModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'zcode') {
      setSelectedZcodeModel(modelId);
      sendBridgeEvent('set_model', modelId);
    }
  }, [
    currentProvider,
    longContextEnabled,
    ompRoles,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedMiniMaxModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setSelectedOmpModel,
    setOmpPermissionMode,
    setSelectedDshModel,
    setSelectedZcodeModel,
  ]);

  const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);

    let modeToSet: PermissionMode = claudePermissionMode;
    if (providerId === 'codex') {
      // Check for 'auto' BEFORE normalizeCliPermissionMode, which coerces
      // 'auto' → 'default' for every CLI provider — after normalization the
      // SDK-floor check would be dead code and a saved 'auto' would be
      // silently demoted on every provider switch.
      modeToSet = codexPermissionMode === 'auto'
        ? (codexSdkMeetsMinimum === false ? 'default' : 'auto')
        : normalizeCliPermissionMode(codexPermissionMode, providerId);
    } else if (providerId === 'grok') {
      modeToSet = normalizeCliPermissionMode(grokPermissionMode, providerId);
    } else if (providerId === 'kimi') {
      modeToSet = normalizeCliPermissionMode(kimiPermissionMode, providerId);
    } else if (providerId === 'minimax') {
      modeToSet = normalizeCliPermissionMode(miniMaxPermissionMode, providerId);
    } else if (providerId === 'opencode') {
      modeToSet = normalizeCliPermissionMode(openCodePermissionMode, providerId);
    } else if (providerId === 'pi') {
      modeToSet = normalizeCliPermissionMode(piPermissionMode, providerId);
    } else if (providerId === 'omp') {
      modeToSet = normalizeCliPermissionMode(ompPermissionMode, providerId);
    } else if (providerId === 'dsh') {
      modeToSet = normalizeCliPermissionMode(dshPermissionMode, providerId);
    } else if (providerId === 'zcode') {
      modeToSet = normalizeCliPermissionMode(zcodePermissionMode, providerId);
    }
    setPermissionMode(modeToSet);
    // Dynamic omp roles are not in the backend's static mode whitelist — the
    // set_model event below carries the role; skip set_mode for them.
    if (providerId !== 'omp' || isValidPermissionMode(modeToSet)) {
      sendBridgeEvent('set_mode', modeToSet);
    }

    let newModel = apply1MContextSuffix(selectedClaudeModel, longContextEnabled);
    if (providerId === 'codex') newModel = selectedCodexModel;
    else if (providerId === 'grok') newModel = selectedGrokModel;
    else if (providerId === 'kimi') newModel = selectedKimiModel;
    else if (providerId === 'minimax') newModel = selectedMiniMaxModel;
    else if (providerId === 'opencode') newModel = selectedOpenCodeModel;
    else if (providerId === 'pi') newModel = selectedPiModel;
    else if (providerId === 'omp') newModel = selectedOmpModel;
    else if (providerId === 'dsh') newModel = selectedDshModel;
    else if (providerId === 'zcode') newModel = selectedZcodeModel;
    sendBridgeEvent('set_model', newModel);
  }, [
    claudePermissionMode,
    codexPermissionMode,
    codexSdkMeetsMinimum,
    grokPermissionMode,
    kimiPermissionMode,
    miniMaxPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    ompPermissionMode,
    dshPermissionMode,
    zcodePermissionMode,
    selectedCodexModel,
    selectedClaudeModel,
    selectedGrokModel,
    selectedKimiModel,
    selectedMiniMaxModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedOmpModel,
    selectedDshModel,
    selectedZcodeModel,
    longContextEnabled,
  ]);

  const handleLongContextChange = useCallback((enabled: boolean) => {
    setLongContextEnabled(enabled);
    if (currentProvider === 'claude') {
      sendBridgeEvent('set_model', apply1MContextSuffix(selectedClaudeModel, enabled));
    }
  }, [currentProvider, selectedClaudeModel, setLongContextEnabled]);

  // The preset rides each dsh send payload (state + persistence live here);
  // no separate bridge event — the daemon applies it per turn via --patch.
  const handleDshPresetChange = useCallback((preset: string) => {
    if (!isValidDshPreset(preset)) return;
    setDshPreset(preset);
  }, [setDshPreset]);

  const handleToggleThinking = useCallback((enabled: boolean) => {
    const config = settings.activeProviderConfig;
    const isSpecialProvider = isSpecialProviderId(config?.id || '');

    setClaudeSettingsAlwaysThinkingEnabled(enabled);

    if (!config || isSpecialProvider) {
      settings.setActiveProviderConfig(prev => prev ? {
        ...prev,
        settingsConfig: {
          ...prev.settingsConfig,
          alwaysThinkingEnabled: enabled,
        },
      } : prev);
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    settings.setActiveProviderConfig(prev => prev ? {
      ...prev,
      settingsConfig: {
        ...prev.settingsConfig,
        alwaysThinkingEnabled: enabled,
      },
    } : null);

    sendBridgeEvent('update_provider', JSON.stringify({
      id: config.id,
      updates: {
        settingsConfig: {
          ...(config.settingsConfig || {}),
          alwaysThinkingEnabled: enabled,
        },
      },
    }));
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  }, [settings, setClaudeSettingsAlwaysThinkingEnabled, addToast, t]);

  return {
    ...claude,
    ...codex,
    ...grok,
    ...kimi,
    ...miniMax,
    ...openCode,
    ...pi,
    ...omp,
    ...dsh,
    ...zcode,
    ...usage,
    ...settings,
    currentProvider, setCurrentProvider,
    permissionMode, setPermissionMode,
    selectedModel,
    currentSdkInstalled,
    codexNativeAutoReviewAvailable,
    currentProviderRef,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleDshPresetChange,
    handleLongContextChange,
    handleToggleThinking,
  };
}
