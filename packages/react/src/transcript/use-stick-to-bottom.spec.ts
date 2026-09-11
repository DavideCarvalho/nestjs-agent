// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStickToBottom } from './use-stick-to-bottom.js';

/** A scrollable element jsdom won't lay out for us — the metrics are the whole point here. */
function scrollable({ scrollHeight = 1000, clientHeight = 300, scrollTop = 700 } = {}) {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, writable: true });
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, writable: true });
  element.scrollTop = scrollTop;
  return element;
}

describe('useStickToBottom', () => {
  it('pins a container that mounts already at the bottom', () => {
    const element = scrollable();
    const { result } = renderHook(() => useStickToBottom({ contentKey: 'a' }));
    act(() => result.current.getContainerProps().ref(element));
    expect(result.current.isAtBottom).toBe(true);
    expect(result.current.showJumpToLatest).toBe(false);
  });

  it('unpins the moment the reader scrolls up, and asks for a jump-to-latest', () => {
    const element = scrollable();
    const { result } = renderHook(() => useStickToBottom({ contentKey: 'a' }));
    act(() => result.current.getContainerProps().ref(element));

    element.scrollTop = 100;
    act(() => result.current.getContainerProps().onScroll());

    expect(result.current.isAtBottom).toBe(false);
    expect(result.current.showJumpToLatest).toBe(true);
  });

  it('tolerates a sub-pixel residue at the bottom', () => {
    const element = scrollable({ scrollTop: 690 });
    const { result } = renderHook(() => useStickToBottom({ contentKey: 'a' }));
    act(() => result.current.getContainerProps().ref(element));
    expect(result.current.isAtBottom).toBe(true);
  });

  it('follows new content while pinned', () => {
    const element = scrollable();
    const { result, rerender } = renderHook(
      ({ contentKey }: { contentKey: string }) => useStickToBottom({ contentKey }),
      { initialProps: { contentKey: 'a' } },
    );
    act(() => result.current.getContainerProps().ref(element));

    Object.defineProperty(element, 'scrollHeight', { value: 2000, writable: true });
    rerender({ contentKey: 'b' });

    expect(element.scrollTop).toBe(2000);
  });

  it('leaves the viewport alone while the reader is scrolled up', () => {
    const element = scrollable();
    const { result, rerender } = renderHook(
      ({ contentKey }: { contentKey: string }) => useStickToBottom({ contentKey }),
      { initialProps: { contentKey: 'a' } },
    );
    act(() => result.current.getContainerProps().ref(element));

    element.scrollTop = 100;
    act(() => result.current.getContainerProps().onScroll());
    Object.defineProperty(element, 'scrollHeight', { value: 2000, writable: true });
    rerender({ contentKey: 'b' });

    expect(element.scrollTop).toBe(100);
  });

  it('re-pins on demand', () => {
    const element = scrollable();
    const { result } = renderHook(() => useStickToBottom({ contentKey: 'a' }));
    act(() => result.current.getContainerProps().ref(element));
    element.scrollTop = 100;
    act(() => result.current.getContainerProps().onScroll());

    act(() => result.current.scrollToBottom());

    expect(element.scrollTop).toBe(1000);
    expect(result.current.isAtBottom).toBe(true);
  });
});
