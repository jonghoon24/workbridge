'use client';

import { useEffect, useRef, useState } from 'react';
import Button from '@/components/ui/Button';
import { CheckIcon, LinkIcon } from '@/components/ui/Icons';

const RESET_AFTER_MS = 2000;

// Clipboard API는 보안 컨텍스트(https, localhost)에서만 있다. 그 밖(사내망 http 주소 등)에서는
// 선택 영역 복사로 대신한다.
async function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 권한 거부 등. 아래 방식으로 한 번 더 시도한다.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

// 같은 사이트 안의 경로(`/users/12`)를 지금 주소의 출처를 붙인 전체 URL로 복사한다.
// 운영·프리뷰·로컬 어디서 눌러도 그 환경의 주소가 된다.
export default function CopyLinkButton({ path, label = '링크 복사', size = 'sm', variant = 'secondary', className = '' }) {
  const [status, setStatus] = useState('idle'); // idle | copied | failed
  const [url, setUrl] = useState('');
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleClick() {
    const fullUrl = new URL(path, window.location.origin).toString();
    const ok = await copyText(fullUrl);
    setUrl(fullUrl);
    setStatus(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    // 실패하면 주소를 직접 복사할 수 있게 다시 누를 때까지 남겨 둔다.
    if (ok) timer.current = setTimeout(() => setStatus('idle'), RESET_AFTER_MS);
  }

  return (
    <div className={`relative inline-flex ${className}`}>
      <Button variant={variant} size={size} onClick={handleClick}>
        {status === 'copied' ? (
          <CheckIcon className="h-4 w-4 text-green-600" />
        ) : (
          <LinkIcon className="h-4 w-4" />
        )}
        {status === 'copied' ? '복사됨' : label}
      </Button>
      {/* 스크린 리더에 결과를 알린다. 실패는 눈으로도 보이게 버튼 아래에 띄운다. */}
      <span role="status" aria-live="polite" className="sr-only">
        {status === 'copied' ? '링크를 복사했습니다' : ''}
      </span>
      {status === 'failed' && (
        <div
          role="alert"
          className="absolute right-0 top-full z-10 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700 shadow-lg"
        >
          <p className="mb-1.5">자동으로 복사하지 못했습니다. 아래 주소를 직접 복사해 주세요.</p>
          <input
            readOnly
            value={url}
            onFocus={(e) => e.target.select()}
            aria-label="복사할 주소"
            className="block w-full rounded-md border-gray-300 text-xs focus:border-primary-500 focus:ring-primary-500"
          />
        </div>
      )}
    </div>
  );
}
