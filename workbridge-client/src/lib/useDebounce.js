'use client';

import { useEffect, useState } from 'react';

// `value`가 `delay`ms 동안 바뀌지 않으면 그 값을 돌려준다. 입력마다 요청하지 않게 검색·필터 입력에 쓴다.
export default function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debounced;
}
