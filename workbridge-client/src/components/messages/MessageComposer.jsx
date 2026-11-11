'use client';

import { useRef, useState } from 'react';
import useLeaveWarning from '@/lib/useLeaveWarning';
import Button from '@/components/ui/Button';
import { formatFileSize } from '@/lib/format';
import { ATTACHMENT_ACCEPT } from '@/constants/milestones';
import { MESSAGE_LIMITS, closedReasonText } from './messageUtils';
import { PaperclipIcon } from '@/components/ui/Icons';

// 메시지 입력창. Enter 전송, Shift+Enter 줄바꿈. 파일은 최대 5개, 개당 10MB.
// 파일은 전송할 때 저장소로 직접 올라가고(진행률 표시), 실패하면 선택한 파일을 그대로 두어 다시 보낼 수 있다.
// 보낼 수 없는 대화방이면 입력창 대신 이유를 보여준다.
export default function MessageComposer({ canSend, closedReason, contractStatus, onSend }) {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const composing = useRef(false);
  // 파일을 올리는 동안 창을 닫거나 다른 페이지로 가면 업로드가 끊긴다.
  useLeaveWarning(progress !== null);

  if (!canSend) {
    return (
      <div className="border-t border-gray-200 bg-gray-50 px-4 py-4 text-center text-sm text-gray-500">
        {closedReasonText(closedReason, contractStatus)}
      </div>
    );
  }

  function handleFileChange(e) {
    const selected = Array.from(e.target.files || []);
    const merged = [...files, ...selected];
    if (merged.length > MESSAGE_LIMITS.filesMax) {
      setError(`파일은 최대 ${MESSAGE_LIMITS.filesMax}개까지 첨부할 수 있습니다.`);
    } else {
      setError('');
    }
    setFiles(merged.slice(0, MESSAGE_LIMITS.filesMax));
    setFileInputKey((key) => key + 1);
  }

  function removeFile(index) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function validate(trimmed) {
    if (!trimmed && files.length === 0) return '메시지를 입력하거나 파일을 첨부해 주세요.';
    if (trimmed.length > MESSAGE_LIMITS.bodyMax) {
      return `메시지는 ${MESSAGE_LIMITS.bodyMax.toLocaleString()}자 이하로 입력해 주세요.`;
    }
    const big = files.find((file) => file.size > MESSAGE_LIMITS.fileMaxBytes);
    if (big) return `파일은 개당 10MB 이하여야 합니다: ${big.name}`;
    return '';
  }

  async function submit() {
    if (sending) return;
    const trimmed = body.trim();
    const validationError = validate(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSending(true);
    setError('');
    setProgress(files.length > 0 ? 0 : null);
    try {
      await onSend({ body: trimmed, files, onProgress: setProgress });
      setBody('');
      setFiles([]);
      setFileInputKey((key) => key + 1);
    } catch (err) {
      setError(err.displayMessage || '메시지를 보내지 못했습니다.');
    } finally {
      setSending(false);
      setProgress(null);
    }
  }

  function handleKeyDown(e) {
    // 한글 조합 중의 Enter는 글자를 확정하는 키라서 전송하지 않는다.
    if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  const remaining = MESSAGE_LIMITS.bodyMax - body.trim().length;

  return (
    <div className="border-t border-gray-200 bg-white px-3 py-3 sm:px-4">
      {error && (
        <div className="mb-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700" role="alert">
          {error}
        </div>
      )}

      {files.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-700"
            >
              <span className="max-w-[12rem] truncate">{file.name}</span>
              <span className="text-gray-400">{formatFileSize(file.size)}</span>
              <button
                type="button"
                onClick={() => removeFile(index)}
                disabled={sending}
                className="text-gray-400 hover:text-red-600"
                aria-label={`${file.name} 첨부 취소`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {progress !== null && (
        <div className="mb-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full bg-primary-600 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-0.5 text-[11px] text-gray-500">파일 업로드 중 {progress}%</p>
        </div>
      )}

      <div className="flex items-end gap-2">
        <label
          className={`flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 ${
            sending || files.length >= MESSAGE_LIMITS.filesMax ? 'pointer-events-none opacity-50' : ''
          }`}
          title="파일 첨부 (최대 5개, 개당 10MB)"
        >
          <PaperclipIcon className="h-4 w-4 shrink-0" />
          <span className="sr-only">파일 첨부</span>
          <input
            key={fileInputKey}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            onChange={handleFileChange}
            className="hidden"
            disabled={sending}
          />
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          rows={Math.min(5, Math.max(1, body.split('\n').length))}
          placeholder="메시지를 입력해 주세요"
          className="block min-h-[2.5rem] flex-1 resize-none rounded-lg border-gray-300 text-sm shadow-sm focus:border-primary-500 focus:ring-primary-500"
          disabled={sending}
          aria-label="메시지 입력"
        />
        <Button onClick={submit} loading={sending} className="h-10 shrink-0">
          전송
        </Button>
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-gray-400">
        <span className="hidden sm:inline">Enter 전송 · Shift+Enter 줄바꿈 · 파일 최대 5개(개당 10MB)</span>
        {remaining < 500 && (
          <span className={`ml-auto ${remaining < 0 ? 'text-red-600' : ''}`}>{remaining.toLocaleString()}자 남음</span>
        )}
      </div>
    </div>
  );
}
