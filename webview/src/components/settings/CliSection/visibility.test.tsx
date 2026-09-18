import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { TFunction } from 'i18next';
import CliSection from './index';
import { getHiddenCliProviderIds, CLI_PROVIDER_VISIBILITY_KEY } from '../../../utils/cliProviderVisibility';

const translations: Record<string, string> = {
  'settings.cli.title': 'CLI Management',
  'settings.cli.checking': 'Checking CLI status…',
  'settings.cli.timeout': 'Timeout',
  'settings.cli.retry': 'Retry',
  'settings.cli.refresh': 'Refresh',
  'settings.cli.showAll': 'Show all',
  'settings.cli.hide': 'Hide',
  'settings.cli.connectDsh': 'Connect DSH CLI',
  'settings.cli.hostTitle': 'Host',
  'settings.cli.visibility.hide': 'Hide in provider switcher',
  'settings.cli.visibility.show': 'Show in provider switcher',
  'cli.notInstalled': 'Not installed',
  'cli.install': 'Install',
  'cli.installGuide': 'Install Guide',
  'cli.openWebsite': 'Open Website',
  'cli.update': 'Update',
  'cli.copy': 'Copy',
  'cli.docs': 'Docs',
  'cli.tutorial': 'Tutorial',
  'cli.installing': 'Installing…',
  'cli.installSuccess': 'Installed',
  'cli.installFailed': 'Install failed',
  'cli.installedPrefix': 'Installed',
  'cli.defaultBadge': 'Default',
  'cli.openDirectory': 'Open directory',
  'cli.binaryDirMac': 'mac dir',
  'cli.binaryDirWin': 'win dir',
  'cli.copySuccess': 'Copied',
  'cli.dsh.title': 'DSH CLI',
  'cli.dsh.description': 'DSH',
  'cli.dsh.connect': 'Connect',
  'cli.dsh.disconnect': 'Disconnect',
  'cli.dsh.disconnecting': 'Disconnecting…',
  'cli.dsh.connecting': 'Connecting…',
  'cli.dsh.connectedBadge': 'Connected',
  'cli.dsh.connectHint': 'Hint',
  'cli.dsh.connectSuccess': 'Connected',
  'cli.dsh.disconnectSuccess': 'Disconnected',
  'cli.dsh.disconnectFailed': 'Disconnect failed',
  'cli.dsh.connectFailedMissingAuth': 'Missing auth',
  'cli.dsh.connectedAs': 'Connected as',
  'cli.dsh.notLoggedIn': 'Not logged in',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: ((key: string, fallbackOrOptions?: string | { defaultValue?: string }) => {
      if (translations[key]) return translations[key];
      if (typeof fallbackOrOptions === 'string') return fallbackOrOptions;
      if (fallbackOrOptions && typeof fallbackOrOptions === 'object' && fallbackOrOptions.defaultValue) {
        return fallbackOrOptions.defaultValue;
      }
      return key;
    }) as TFunction,
  }),
}));

declare global {
  interface Window {
    sendToJava?: (message: string) => void;
    updateCliStatus?: (json: string) => void;
  }
}

describe('CliSection', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    localStorage.removeItem(CLI_PROVIDER_VISIBILITY_KEY);
  });

  afterEach(() => {
    delete window.updateCliStatus;
  });

  it('persists switcher visibility when the eye toggle is clicked', async () => {
    render(<CliSection />);

    act(() => {
      window.updateCliStatus?.(
        JSON.stringify({
          grok: { id: 'grok', name: 'Grok CLI', binaryName: 'grok', installed: true, version: '1.0.0' },
        }),
      );
    });

    // grok is the first CLI tool card.
    const grokName = await screen.findByText('settings.cli.tools.grok.name');
    const grokCard = grokName.closest('div[class*="cliCard"]') as HTMLElement;
    const toggle = within(grokCard).getByRole('button', { name: 'Hide in provider switcher' });
    expect(getHiddenCliProviderIds().includes('grok')).toBe(false);

    act(() => {
      toggle.click();
    });

    await waitFor(() => {
      expect(getHiddenCliProviderIds().includes('grok')).toBe(true);
    });
    expect(JSON.parse(localStorage.getItem(CLI_PROVIDER_VISIBILITY_KEY) ?? '[]')).toEqual(['grok']);

    const showToggle = within(grokCard).getByRole('button', { name: 'Show in provider switcher' });
    act(() => {
      showToggle.click();
    });

    await waitFor(() => {
      expect(getHiddenCliProviderIds().includes('grok')).toBe(false);
    });
    expect(JSON.parse(localStorage.getItem(CLI_PROVIDER_VISIBILITY_KEY) ?? '[]')).toEqual([]);
  });
});
