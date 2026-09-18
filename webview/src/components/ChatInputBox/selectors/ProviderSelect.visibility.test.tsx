import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { ProviderSelect } from './ProviderSelect';
import { setCliProviderHidden, CLI_PROVIDER_VISIBILITY_KEY } from '../../../utils/cliProviderVisibility';

vi.mock('../ProviderModelIcon', () => ({
  ProviderModelIcon: ({ icon }: { icon: string }) => <span data-testid={`icon-${icon}`} />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: ((key: string) => key) as TFunction,
  }),
}));

describe('ProviderSelect CLI provider visibility', () => {
  beforeEach(() => {
    localStorage.removeItem(CLI_PROVIDER_VISIBILITY_KEY);
  });

  it('hides CLI providers that were hidden from the switcher', () => {
    setCliProviderHidden('grok', true);

    render(
      <ProviderSelect
        value="claude"
        onOpenCliSettings={() => undefined}
        onChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTitle(/config\.switchProvider/));

    expect(screen.queryByText('providers.grok.label')).toBeNull();
    expect(screen.getByText('providers.codex.label')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'providers.manageCli' })).toBeTruthy();
  });

  it('keeps the current provider selectable even when it is hidden', () => {
    setCliProviderHidden('grok', true);

    render(
      <ProviderSelect
        value="grok"
        onOpenCliSettings={() => undefined}
        onChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTitle(/config\.switchProvider/));

    expect(screen.getAllByText('providers.grok.label').length).toBeGreaterThan(0);
  });
});
