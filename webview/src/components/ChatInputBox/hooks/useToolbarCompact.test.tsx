import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useToolbarCompact } from './useToolbarCompact';

/**
 * happy-dom does no layout, so the geometry the hook measures is stubbed per
 * element class via prototype getters driven by the mutable `dims` object.
 */
const dims = { area: 800, right: 80, left: 300 };

let resizeCallback: ResizeObserverCallback | null = null;

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function Harness() {
  const areaRef = useRef<HTMLDivElement>(null);
  const compact = useToolbarCompact(areaRef);
  return (
    <div ref={areaRef} className={`button-area${compact ? ' toolbar-compact' : ''}`}>
      <div className="button-area-left" />
      <div className="button-area-right" />
    </div>
  );
}

function renderHarness() {
  const result = render(<Harness />);
  return result.container.querySelector('.button-area')!;
}

describe('useToolbarCompact', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    resizeCallback = null;
    dims.area = 800;
    dims.right = 80;
    dims.left = 300;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('button-area') ? dims.area : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('button-area-right') ? dims.right : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('button-area-left') ? dims.left : 0;
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps full labels when the selectors fit with room to spare', () => {
    const area = renderHarness();
    expect(area.classList.contains('toolbar-compact')).toBe(false);
  });

  it('collapses to icons when the selectors would overflow the 20px reserve', () => {
    // available = 400 - 12 (padding) - 80 (right) - 6 (gap) - 20 (reserve) = 282 < 300
    dims.area = 400;
    const area = renderHarness();
    expect(area.classList.contains('toolbar-compact')).toBe(true);
  });

  it('still shows labels when the selectors fit exactly within the reserve', () => {
    // available = 418 - 12 - 80 - 6 - 20 = 300, natural = 300 -> fits, no compact
    dims.area = 418;
    const area = renderHarness();
    expect(area.classList.contains('toolbar-compact')).toBe(false);
  });

  it('expands back to full labels when the toolbar widens again', () => {
    dims.area = 400;
    const area = renderHarness();
    expect(area.classList.contains('toolbar-compact')).toBe(true);

    dims.area = 800;
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });
    expect(area.classList.contains('toolbar-compact')).toBe(false);
  });

  it('re-collapses when labels grow beyond the available space', () => {
    const area = renderHarness();
    expect(area.classList.contains('toolbar-compact')).toBe(false);

    dims.left = 900;
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });
    expect(area.classList.contains('toolbar-compact')).toBe(true);
  });
});
