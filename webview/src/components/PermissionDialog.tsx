import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCountdown } from '../utils/helpers';
import { useDialogCountdownTimeout } from '../hooks/useDialogCountdownTimeout';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from '../utils/permissionDialogTimeout';
import MarkdownBlock from './MarkdownBlock';
import { useDialogResize } from '../hooks/useDialogResize';
import { isEditableEventTarget } from '../utils/isEditableEventTarget';
import { clearDialogDraft, readDialogDraft, writeDialogDraft } from '../utils/dialogStateStorage';

export interface PermissionRequest {
  channelId: string;
  toolName: string;
  inputs: Record<string, any>;
  /** Working directory from the bridge (top-level field, not only inside inputs). */
  cwd?: string;
  suggestions?: any;
  deadlineMs?: number;
  dialogToken?: string;
}

interface PermissionDialogProps {
  isOpen: boolean;
  request: PermissionRequest | null;
  onApprove: (channelId: string) => void;
  onSkip: (channelId: string) => void;
  onApproveAlways: (channelId: string) => void;
  timeoutSeconds?: number;
}
interface PermissionDialogDraft {
  deadlineMs?: number;
  dialogToken?: string;
  showCommand?: boolean;
  selectedIndex?: number;
}

/**
 * Resolve the path label shown next to the command arrow.
 * Prefer bridge top-level cwd, then tool inputs; fall back to "~".
 * Never prefixes an extra "~" (that used to produce "→ ~ ~").
 */
export function resolvePermissionWorkingDirectory(
  request: Pick<PermissionRequest, 'cwd' | 'inputs'>,
): string {
  const candidates = [
    request.cwd,
    request.inputs?.cwd,
    request.inputs?.file_path,
    request.inputs?.path,
  ];
  for (const value of candidates) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return '~';
}

/**
 * Pretty-print a working directory for the dialog header.
 * Collapses the user's home directory prefix to "~" when possible.
 */
export function formatPermissionWorkingDirectoryDisplay(cwd: string): string {
  const trimmed = (cwd || '').trim();
  if (!trimmed || trimmed === '~') {
    return '~';
  }
  // Already home-relative (e.g. "~/project")
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return trimmed;
  }
  return trimmed;
}

const PermissionDialog = ({
  isOpen,
  request,
  onApprove,
  onSkip,
  onApproveAlways,
  timeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
}: PermissionDialogProps) => {
  const [showCommand, setShowCommand] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hydratedRequestKey, setHydratedRequestKey] = useState<string | null>(null);
  const { t } = useTranslation();
  const { dialogRef, dialogHeight, setDialogHeight, handleResizeStart } = useDialogResize({ minHeight: 150 });

  const handleTimeout = useCallback(() => {
    if (request) {
      clearDialogDraft('permission', request.channelId, request.dialogToken);
      onSkip(request.channelId);
    }
  }, [request, onSkip]);

  const { remainingSeconds, isTimeWarning, markSubmitted } = useDialogCountdownTimeout({
    isOpen,
    requestKey: request?.dialogToken ?? request?.channelId,
    timeoutSeconds,
    deadlineMs: request?.deadlineMs,
    onTimeout: handleTimeout,
  });

  const handleApprove = useCallback(() => {
    if (!request || !markSubmitted()) return;
    clearDialogDraft('permission', request.channelId, request.dialogToken);
    onApprove(request.channelId);
  }, [request, markSubmitted, onApprove]);

  const handleApproveAlways = useCallback(() => {
    if (!request || !markSubmitted()) return;
    clearDialogDraft('permission', request.channelId, request.dialogToken);
    onApproveAlways(request.channelId);
  }, [request, markSubmitted, onApproveAlways]);

  const handleSkip = useCallback(() => {
    if (!request || !markSubmitted()) return;
    clearDialogDraft('permission', request.channelId, request.dialogToken);
    onSkip(request.channelId);
  }, [request, markSubmitted, onSkip]);

  useEffect(() => {
    if (!isOpen || !request) {
      setHydratedRequestKey(null);
      return;
    }
    const draft = readDialogDraft<PermissionDialogDraft>('permission', request.channelId, request.deadlineMs, request.dialogToken);
    const restoredIndex = draft?.selectedIndex;
    setShowCommand(draft?.showCommand !== false);
    setSelectedIndex(
      typeof restoredIndex === 'number' && Number.isInteger(restoredIndex)
        ? Math.max(0, Math.min(2, restoredIndex))
        : 0,
    );
    setDialogHeight(null);
    setHydratedRequestKey(request.dialogToken ?? request.channelId);
  }, [isOpen, request?.channelId, request?.dialogToken, request?.deadlineMs, setDialogHeight]);

  useEffect(() => {
    const channelId = request?.channelId;
    const deadlineMs = request?.deadlineMs;
    if (!isOpen || channelId === undefined || hydratedRequestKey !== (request?.dialogToken ?? channelId)) {
      return;
    }
    writeDialogDraft('permission', channelId, {
      deadlineMs,
      dialogToken: request?.dialogToken,
      showCommand,
      selectedIndex,
    });
  }, [hydratedRequestKey, isOpen, request?.channelId, request?.dialogToken, request?.deadlineMs, selectedIndex, showCommand]);

  useEffect(() => {
    if (!isOpen || !request) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableEventTarget(e.target)) {
        return;
      }

      if (e.key === '1') {
        handleApprove();
      } else if (e.key === '2') {
        handleApproveAlways();
      } else if (e.key === '3') {
        handleSkip();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(2, prev + 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        setSelectedIndex(current => {
          if (current === 0) handleApprove();
          else if (current === 1) handleApproveAlways();
          else if (current === 2) handleSkip();
          return current;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, request, handleApprove, handleApproveAlways, handleSkip]);

  if (!isOpen || !request) {
    return null;
  }

  // Format input parameters for display
  const formatInputValue = (value: any): string => {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object') {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  };

  // Get the command or primary action content
  const getCommandContent = (): string => {
    // Get primary content based on tool type
    if (request.inputs.command) {
      return request.inputs.command;
    }
    if (request.inputs.content) {
      return request.inputs.content;
    }
    if (request.inputs.text) {
      return request.inputs.text;
    }
    // For other tools, format all inputs
    return Object.entries(request.inputs)
      .map(([key, value]) => `${key}: ${formatInputValue(value)}`)
      .join('\n');
  };

  // Map tool name to display title
  const getToolTitle = (toolName: string): string => {
    const key = `permission.tools.${toolName}`;
    const translated = t(key);
    // If translation key does not exist, return default template
    if (translated === key) {
      return t('permission.tools.execute', { toolName });
    }
    return translated;
  };

  const commandContent = getCommandContent();
  const workingDirectory = formatPermissionWorkingDirectoryDisplay(
    resolvePermissionWorkingDirectory(request),
  );

  return (
    <div className="permission-dialog-overlay">
      <div
        ref={dialogRef}
        className="permission-dialog-v3"
        style={dialogHeight ? { height: dialogHeight, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' as const } : undefined}
      >
        <div className="permission-dialog-v3-resize-handle" onPointerDown={handleResizeStart} />
        <div className="permission-dialog-v3-header-row">
          <h3 className="permission-dialog-v3-title">{getToolTitle(request.toolName)}</h3>
          <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
            <span className="codicon codicon-clock" />
            <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
          </span>
        </div>
        {isTimeWarning && (
          <div className="timeout-warning-banner">
            <span className="codicon codicon-warning" />
            <span>{t('permission.timeoutWarning', 'Please answer soon, dialog will close in {{seconds}} seconds', { seconds: remainingSeconds })}</span>
          </div>
        )}
        <p className="permission-dialog-v3-subtitle">{t('permission.fromExternalProcess')}</p>

        <div className="permission-dialog-v3-command-box">
          <div className="permission-dialog-v3-command-header">
            <span className="command-path" title={workingDirectory}>
              <span className="command-arrow">→</span>
              <span className="command-cwd">{workingDirectory}</span>
            </span>
            <button
              className="command-toggle"
              onClick={() => setShowCommand(!showCommand)}
              title={showCommand ? t('chat.collapse') : t('chat.expand')}
            >
              <span className={`codicon codicon-chevron-${showCommand ? 'up' : 'down'}`} />
            </button>
          </div>

          {showCommand && (
            <div
              className="permission-dialog-v3-command-content"
              style={dialogHeight ? { maxHeight: 'none' } : undefined}
            >
              <MarkdownBlock content={commandContent} isStreaming={false} />
            </div>
          )}
        </div>

        {/* Option buttons list */}
        <div className="permission-dialog-v3-options">
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 0 ? 'selected' : ''}`}
            onClick={handleApprove}
            onMouseEnter={() => setSelectedIndex(0)}
            aria-label={`${t('permission.allow')} 1`}
          >
            <span className="option-text">{t('permission.allow')}</span>
            <span className="option-key">1</span>
          </button>
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 1 ? 'selected' : ''}`}
            onClick={handleApproveAlways}
            onMouseEnter={() => setSelectedIndex(1)}
            aria-label={`${t('permission.allowAlways')} 2`}
          >
            <span className="option-text">{t('permission.allowAlways')}</span>
            <span className="option-key">2</span>
          </button>
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 2 ? 'selected' : ''}`}
            onClick={handleSkip}
            onMouseEnter={() => setSelectedIndex(2)}
            aria-label={`${t('permission.deny')} 3`}
          >
            <span className="option-text">{t('permission.deny')}</span>
            <span className="option-key">3</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default PermissionDialog;
