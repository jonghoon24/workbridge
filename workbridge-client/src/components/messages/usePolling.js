'use client';

import { useEffect, useRef } from 'react';

// 탭이 보일 때만 `callback`을 `intervalMs`마다 부른다(BEHAVIOR.md MG20: 열린 대화방 5초, 배지 30초).
// 탭이 다시 보이면 기다리지 않고 한 번 바로 부른 뒤 주기를 다시 시작한다. `callback`은 매 렌더의
// 최신 값을 쓰므로 호출하는 쪽에서 useCallback으로 감쌀 필요가 없다.
export default function usePolling(callback, intervalMs, { enabled = true, immediate = false } = {}) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return undefined;

    let timer = null;
    const tick = () => callbackRef.current?.();

    function start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }

    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        tick();
        start();
      } else {
        stop();
      }
    }

    if (immediate) tick();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled, immediate, intervalMs]);
}
