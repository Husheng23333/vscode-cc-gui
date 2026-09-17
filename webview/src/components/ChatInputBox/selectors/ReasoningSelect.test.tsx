import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReasoningSelect } from './ReasoningSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

describe('ReasoningSelect', () => {
  it('shows xhigh and max for Claude Opus 4.7', () => {
    render(
      <ReasoningSelect
        value="high"
        onChange={vi.fn()}
        currentProvider="claude"
        selectedModel="claude-opus-4-8"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('XHigh')).toBeTruthy();
    expect(screen.getByText('Max')).toBeTruthy();
  });

  it('shows max but not xhigh for Claude Sonnet 4.6', () => {
    render(
      <ReasoningSelect
        value="high"
        onChange={vi.fn()}
        currentProvider="claude"
        selectedModel="claude-sonnet-4-6"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText('XHigh')).toBeNull();
    expect(screen.getByText('Max')).toBeTruthy();
  });

  it('resets unavailable effort when selected Claude model changes', () => {
    const onChange = vi.fn();

    render(
      <ReasoningSelect
        value="xhigh"
        onChange={onChange}
        currentProvider="claude"
        selectedModel="claude-sonnet-4-6"
      />,
    );

    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('hides for Claude models without effort support', () => {
    render(
      <ReasoningSelect
        value="high"
        onChange={vi.fn()}
        currentProvider="claude"
        selectedModel="claude-haiku-4-5"
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not force a scrollbar on the embedded submenu when all levels fit', () => {
    const trigger = document.createElement('div');
    trigger.getBoundingClientRect = () => ({
      x: 20,
      y: 80,
      top: 80,
      left: 20,
      bottom: 108,
      right: 200,
      width: 180,
      height: 28,
      toJSON() {
        return {};
      },
    });

    render(
      <ReasoningSelect
        embedded
        triggerRef={{ current: trigger }}
        value="high"
        onChange={vi.fn()}
        currentProvider="kimi"
        selectedModel="kimi-k3"
      />,
    );

    const dropdown = screen.getByTestId('reasoning-selector-dropdown');
    expect(dropdown.style.overflowY).not.toBe('auto');
    expect(dropdown.style.maxHeight).toBe('');
  });
});
