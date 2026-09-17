import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Horizontal padding of .button-area (4px left + 8px right) and the flex gap
 * between the left selectors and the right tool buttons (6px).
 */
const TOOLBAR_H_PADDING = 12;
const TOOLBAR_GAP = 6;
/** Free space to keep between selectors and the right buttons before collapsing to icons. */
const COMPACT_RESERVE = 20;

/**
 * Dynamically collapse selector labels to icons when the left selectors would
 * overflow the toolbar. Unlike a fixed pixel breakpoint, this measures the real
 * content width (labels vary by provider/model/locale) and only collapses when
 * space actually runs out, keeping a 20px reserve.
 *
 * Returns whether the compact chrome is active; the caller applies the
 * `toolbar-compact` class to the .button-area element.
 */
export function useToolbarCompact(areaRef: RefObject<HTMLDivElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(compact);
  compactRef.current = compact;

  const measureCompact = useCallback(() => {
    const area = areaRef.current;
    if (!area) return;
    const left = area.querySelector<HTMLElement>('.button-area-left');
    const right = area.querySelector<HTMLElement>('.button-area-right');
    if (!left || !right) return;
    const available =
      area.clientWidth - TOOLBAR_H_PADDING - right.offsetWidth - TOOLBAR_GAP - COMPACT_RESERVE;
    // The left pane is flex-growed to fill free space, so its scrollWidth would
    // read the stretched width, not the content width. The measuring class
    // neutralizes the flex grow (and the label-collapse transition) so
    // scrollWidth reflects the natural content width. Class toggling is
    // synchronous — no paint happens in between.
    area.classList.add('toolbar-measuring');
    const wasCompact = compactRef.current;
    if (wasCompact) area.classList.remove('toolbar-compact');
    const naturalWidth = left.scrollWidth;
    if (wasCompact) area.classList.add('toolbar-compact');
    area.classList.remove('toolbar-measuring');
    const shouldCompact = naturalWidth > available;
    if (shouldCompact !== compactRef.current) {
      setCompact(shouldCompact);
    }
  }, [areaRef]);

  // Re-measure whenever content changes (model name, locale, provider, ...).
  useLayoutEffect(() => {
    measureCompact();
  });

  // Re-measure when the toolbar itself is resized (panel drag, zoom, ...).
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureCompact);
      return () => window.removeEventListener('resize', measureCompact);
    }
    const observer = new ResizeObserver(measureCompact);
    observer.observe(area);
    return () => observer.disconnect();
  }, [areaRef, measureCompact]);

  return compact;
}
