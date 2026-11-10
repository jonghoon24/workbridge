'use client';

import { useState } from 'react';
import { openAttachment } from '@/lib/attachments';
import { toUserMessage } from '@/lib/errorMessages';

// 비공개 저장소의 첨부 링크. 누르면 다운로드 경로에서 새 서명 URL을 받아 원래 파일 이름으로 내려받는다.
// 목록 응답의 url(15분)은 새 탭 열기·주소 복사용 대체 링크로만 둔다.
export default function AttachmentLink({ attachment, downloadPath, className, errorClassName = 'text-red-600', children }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleClick(e) {
    // 새 탭 열기(가운데 클릭, Ctrl/⌘ 클릭)는 브라우저에 맡긴다.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await openAttachment(downloadPath);
    } catch (err) {
      setError(toUserMessage(err, '파일을 내려받지 못했습니다. 잠시 후 다시 시도해 주세요.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <a
        href={attachment.url || '#'}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleClick}
        aria-busy={busy}
        className={`${className} ${busy ? 'cursor-wait opacity-70' : ''}`}
      >
        {children}
      </a>
      {error && (
        <p className={`mt-0.5 text-[11px] ${errorClassName}`} role="alert">
          {error}
        </p>
      )}
    </>
  );
}
