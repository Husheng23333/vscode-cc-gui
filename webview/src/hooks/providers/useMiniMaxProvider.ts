import { MINIMAX_DEFAULT_MODEL_ID } from '../../components/ChatInputBox/types';
import type { PermissionMode } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

export interface UseMiniMaxProviderReturn {
  selectedMiniMaxModel: string;
  setSelectedMiniMaxModel: (value: string) => void;
  miniMaxPermissionMode: PermissionMode;
  setMiniMaxPermissionMode: (value: PermissionMode) => void;
}

/**
 * MiniMax Code CLI provider state.
 * Auth/config comes from MiniMax CLI native home (~/.minimax).
 */
export function useMiniMaxProvider(): UseMiniMaxProviderReturn {
  const state = useCliProviderState(MINIMAX_DEFAULT_MODEL_ID);
  return {
    selectedMiniMaxModel: state.selectedModel,
    setSelectedMiniMaxModel: state.setSelectedModel,
    miniMaxPermissionMode: state.permissionMode,
    setMiniMaxPermissionMode: state.setPermissionMode,
  };
}
