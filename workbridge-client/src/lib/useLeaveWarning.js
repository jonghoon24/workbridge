'use client';

import { useEffect } from 'react';

// active인 동안 탭을 닫거나 새로고침하려 하면 브라우저 확인 창을 띄운다(파일 업로드 중).
export default function useLeaveWarning(active) {
  useEffect(() => {
    if (!active) return undefined;
    const warn = (event) => {
      event.preventDefault();
      // 일부 브라우저는 returnValue가 있어야 확인 창을 띄운다.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
}
