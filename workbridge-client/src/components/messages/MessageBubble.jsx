'use client';

import { formatFileSize } from '@/lib/format';
import { MESSAGE_LIMITS, formatMessageTime } from './messageUtils';
import { PaperclipIcon } from '@/components/ui/Icons';

function AttachmentList({ attachments, mine }) {
  if (!attachments?.length) return null;
  return (
    <ul className="mt-1.5 space-y-1">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          <a
            href={attachment.url}
            target="_blank"
            rel="noopener noreferrer"
            download={attachment.fileName}
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
              mine
                ? 'border-primary-400 bg-primary-500 text-white hover:bg-primary-400'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            <PaperclipIcon className="h-4 w-4 shrink-0" />
            <span className="truncate font-medium">{attachment.fileName}</span>
            <span className={`shrink-0 ${mine ? 'text-primary-100' : 'text-gray-400'}`}>{formatFileSize(attachment.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

// 시스템 메시지는 가운데 회색 띠로, 내 메시지는 오른쪽, 상대 메시지는 왼쪽에 그린다.
// 삭제된 메시지(MG4 tombstone)는 내용 없이 "삭제된 메시지입니다"만 보인다.
export default function MessageBubble({ message, mine, readByCounterpart, now, deleting, onDelete }) {
  if (message.kind === 'SYSTEM') {
    return (
      <div className="flex justify-center py-1" data-kind="system">
        <div className="max-w-[90%] rounded-lg bg-gray-100 px-4 py-2 text-center text-xs text-gray-600">
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
          <p className="mt-0.5 text-[10px] text-gray-400">{formatMessageTime(message.createdAt)}</p>
        </div>
      </div>
    );
  }

  const deletable = mine
    && !message.deleted
    && now - new Date(message.createdAt).getTime() < MESSAGE_LIMITS.deleteWindowMs;

  return (
    <div className={`group flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[80%] items-end gap-1.5 ${mine ? 'flex-row-reverse' : ''}`}>
        <div
          className={`rounded-2xl px-3.5 py-2 text-sm ${
            message.deleted
              ? 'border border-dashed border-gray-300 bg-white italic text-gray-400'
              : mine
                ? 'bg-primary-600 text-white'
                : 'bg-white border border-gray-200 text-gray-900'
          }`}
        >
          {message.deleted ? (
            <p>삭제된 메시지입니다</p>
          ) : (
            <>
              {message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}
              <AttachmentList attachments={message.attachments} mine={mine} />
            </>
          )}
        </div>
        <div className={`flex shrink-0 flex-col pb-0.5 text-[10px] text-gray-400 ${mine ? 'items-end' : 'items-start'}`}>
          {deletable && (
            <button
              type="button"
              onClick={() => onDelete?.(message)}
              disabled={deleting}
              className="mb-0.5 text-gray-300 hover:text-red-600 focus:text-red-600 group-hover:text-gray-500 disabled:opacity-50"
            >
              {deleting ? '삭제 중' : '삭제'}
            </button>
          )}
          {mine && !message.deleted && (
            <span className={readByCounterpart ? 'text-gray-400' : 'font-semibold text-primary-600'}>
              {readByCounterpart ? '읽음' : '1'}
            </span>
          )}
          <span>{formatMessageTime(message.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}
