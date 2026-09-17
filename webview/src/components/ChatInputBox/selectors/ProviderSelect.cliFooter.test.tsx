import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { ProviderSelect } from './ProviderSelect';

vi.mock('../ProviderModelIcon', () => ({
  ProviderModelIcon: ({ icon }: { icon: string }) => <span data-testid={`icon-${icon}`} />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: ((key: string) => key) as TFunction,
  }),
}));

describe('ProviderSelect CLI footer', () => {
  it('routes the footer button to CLI settings without changing provider', () => {
    const onChange = vi.fn();
    const onOpenCliSettings = vi.fn();

    render(
      <ProviderSelect
        value="claude"
        onChange={onChange}
        onOpenCliSettings={onOpenCliSettings}
      />,
    );

    fireEvent.click(screen.getByTitle(/config\.switchProvider/));
    fireEvent.click(screen.getByRole('button', { name: 'providers.manageCli' }));

    expect(onOpenCliSettings).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
