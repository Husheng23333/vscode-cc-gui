import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelConfigSelect, SUBMENU_HOVER_DELAY_MS } from './ModelConfigSelect';

vi.mock('antd/es/switch', () => ({
  default: ({
    checked,
    disabled,
    onClick,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onClick?: (checked: boolean, e: { stopPropagation: () => void }) => void;
  }) => (
    <button
      type="button"
      aria-pressed={checked}
      disabled={disabled}
      data-testid="context-switch"
      onClick={() => onClick?.(!checked, { stopPropagation: vi.fn() })}
    />
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; model?: string }) =>
      options?.model ?? options?.defaultValue ?? key,
  }),
}));

const claudeModels = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Default' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fast' },
];

const codexModels = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
];

describe('ModelConfigSelect', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('collapses model and effort into one summary trigger', () => {
    render(
      <ModelConfigSelect
        selectedModel="claude-sonnet-5"
        onModelSelect={vi.fn()}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
        longContextEnabled
        onLongContextChange={vi.fn()}
      />,
    );

    const trigger = screen.getByTestId('model-config-trigger');
    expect(trigger.textContent).toContain('models.claude.sonnet5.label');
    expect(trigger.textContent).toContain('1M');
    expect(trigger.textContent).toContain('High');
    expect(screen.queryByTestId('model-config-dropdown')).toBeNull();
  });

  it('opens a nested menu with context, effort, and model rows', () => {
    render(
      <ModelConfigSelect
        selectedModel="claude-sonnet-5"
        onModelSelect={vi.fn()}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
        longContextEnabled
        onLongContextChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('model-config-trigger'));

    expect(screen.getByTestId('model-config-option-context')).toBeTruthy();
    expect(screen.getByTestId('model-config-option-context').textContent).toContain('1M Context');
    expect(screen.getByTestId('model-config-option-effort')).toBeTruthy();
    expect(screen.getByTestId('model-config-option-model')).toBeTruthy();
    expect(screen.queryByTestId('model-config-option-speed')).toBeNull();
  });

  it('opens the effort submenu and selects a new level', () => {
    const onReasoningChange = vi.fn();
    render(
      <ModelConfigSelect
        selectedModel="claude-sonnet-5"
        onModelSelect={vi.fn()}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={onReasoningChange}
        longContextEnabled
        onLongContextChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('model-config-trigger'));
    fireEvent.click(screen.getByTestId('model-config-option-effort'));

    expect(screen.getByTestId('reasoning-selector-dropdown')).toBeTruthy();
    fireEvent.click(screen.getByText('Low'));

    expect(onReasoningChange).toHaveBeenCalledWith('low');
    expect(screen.queryByTestId('model-config-dropdown')).toBeNull();
  });

  it('opens the model submenu and selects a model', () => {
    const onModelSelect = vi.fn();
    render(
      <ModelConfigSelect
        selectedModel="claude-sonnet-5"
        onModelSelect={onModelSelect}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('model-config-trigger'));
    fireEvent.mouseEnter(screen.getByTestId('model-config-option-model'));

    expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy();
    fireEvent.click(screen.getByTestId('model-option-claude-haiku-4-5'));

    expect(onModelSelect).toHaveBeenCalledWith('claude-haiku-4-5');
  });

  it('hides effort for Claude models without adaptive thinking', () => {
    render(
      <ModelConfigSelect
        selectedModel="claude-haiku-4-5"
        onModelSelect={vi.fn()}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
        longContextEnabled
        onLongContextChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('model-config-trigger'));
    expect(screen.queryByTestId('model-config-option-effort')).toBeNull();
    expect(screen.getByTestId('model-config-option-model')).toBeTruthy();
  });

  it('shows Codex speed as a nested row instead of a toolbar dropdown', () => {
    const onCodexFastModeChange = vi.fn();
    render(
      <ModelConfigSelect
        selectedModel="gpt-5.6-sol"
        onModelSelect={vi.fn()}
        models={codexModels}
        currentProvider="codex"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
        codexFastMode="normal"
        onCodexFastModeChange={onCodexFastModeChange}
      />,
    );

    const trigger = screen.getByTestId('model-config-trigger');
    expect(trigger.textContent).toContain('GPT-5.6 Sol');
    expect(trigger.textContent).not.toContain('Standard');

    fireEvent.click(trigger);
    fireEvent.mouseEnter(screen.getByTestId('model-config-option-speed'));
    fireEvent.click(screen.getByText('Fast'));

    expect(onCodexFastModeChange).toHaveBeenCalledWith('fast');
  });

  it('toggles Claude 1M context from the nested menu', () => {
    const onLongContextChange = vi.fn();
    render(
      <ModelConfigSelect
        selectedModel="claude-sonnet-5"
        onModelSelect={vi.fn()}
        models={claudeModels}
        currentProvider="claude"
        reasoningEffort="high"
        onReasoningChange={vi.fn()}
        longContextEnabled
        onLongContextChange={onLongContextChange}
      />,
    );

    fireEvent.click(screen.getByTestId('model-config-trigger'));
    fireEvent.click(screen.getByTestId('context-switch'));

    expect(onLongContextChange).toHaveBeenCalledWith(false);
  });

  describe('submenu hover delay', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not steal the model submenu while the pointer crosses the effort row', () => {
      render(
        <ModelConfigSelect
          selectedModel="claude-sonnet-5"
          onModelSelect={vi.fn()}
          models={claudeModels}
          currentProvider="claude"
          reasoningEffort="high"
          onReasoningChange={vi.fn()}
          longContextEnabled
          onLongContextChange={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByTestId('model-config-trigger'));
      fireEvent.mouseEnter(screen.getByTestId('model-config-option-model'));
      expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy();

      fireEvent.mouseEnter(screen.getByTestId('model-config-option-effort'));
      expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy();
      expect(screen.queryByTestId('reasoning-selector-dropdown')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(SUBMENU_HOVER_DELAY_MS - 1);
      });
      expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy();
      expect(screen.queryByTestId('reasoning-selector-dropdown')).toBeNull();

      // Arriving in the fly-out (which stops mouseenter bubbling) still
      // cancels the pending effort switch.
      fireEvent.mouseOver(screen.getByTestId('model-selector-dropdown'));
      act(() => {
        vi.advanceTimersByTime(SUBMENU_HOVER_DELAY_MS);
      });
      expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy();
      expect(screen.queryByTestId('reasoning-selector-dropdown')).toBeNull();
    });

    it('opens the effort submenu after the pointer rests on it, or immediately on click', () => {
      render(
        <ModelConfigSelect
          selectedModel="claude-sonnet-5"
          onModelSelect={vi.fn()}
          models={claudeModels}
          currentProvider="claude"
          reasoningEffort="high"
          onReasoningChange={vi.fn()}
          longContextEnabled
          onLongContextChange={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByTestId('model-config-trigger'));
      fireEvent.mouseEnter(screen.getByTestId('model-config-option-model'));
      fireEvent.mouseEnter(screen.getByTestId('model-config-option-effort'));

      act(() => {
        vi.advanceTimersByTime(SUBMENU_HOVER_DELAY_MS);
      });
      expect(screen.getByTestId('reasoning-selector-dropdown')).toBeTruthy();
      expect(screen.queryByTestId('model-selector-dropdown')).toBeNull();

      fireEvent.click(screen.getByTestId('model-config-option-model'));
      expect(screen.getByTestId('model-selector-dropdown')).toBeTruthy();
    });
  });
});
