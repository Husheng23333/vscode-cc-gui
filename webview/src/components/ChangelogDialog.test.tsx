import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import ChangelogDialog from './ChangelogDialog';

const REPO_URL = 'https://github.com/zhukunpenglinyutong/vscode-cc-gui';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: ((key: string) => key) as TFunction,
  }),
}));

const entries = [
  {
    version: '1.2.3',
    date: '2026-09-01',
    content: { en: '- new feature', zh: '- 新功能' },
  },
];

describe('ChangelogDialog open source banner', () => {
  beforeEach(() => {
    (window as unknown as { sendToJava?: unknown }).sendToJava = undefined;
    (window as unknown as { vscodeBridge?: unknown }).vscodeBridge = undefined;
  });

  it('shows the open source banner with a star action', () => {
    render(<ChangelogDialog isOpen onClose={() => undefined} entries={entries} />);

    expect(screen.getByText('chat.openSourceBanner')).toBeTruthy();
    const starButton = screen.getByRole('button', { name: 'chat.openSourceBannerStarAria' });
    expect(starButton).toBeTruthy();
    expect(starButton.textContent).toContain('chat.openSourceBannerStar');
  });

  it('opens the repository URL in the system browser when clicking star', () => {
    const sendToJava = vi.fn();
    (window as unknown as { sendToJava?: unknown }).sendToJava = sendToJava;

    render(<ChangelogDialog isOpen onClose={() => undefined} entries={entries} />);

    fireEvent.click(screen.getByRole('button', { name: 'chat.openSourceBannerStarAria' }));

    expect(sendToJava).toHaveBeenCalledTimes(1);
    expect(sendToJava).toHaveBeenCalledWith(`open_browser:${REPO_URL}`);
  });
});
