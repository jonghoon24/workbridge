'use client';

import { useState } from 'react';
import { formatFileSize } from '@/lib/format';
import { PaperclipIcon } from '@/components/ui/Icons';
import AttachmentLink from '@/components/ui/AttachmentLink';

// 메시지 첨부와 마일스톤 결과물 첨부(OpenAPI `Attachment`: url, fileName, mimeType, size)를 그린다.
// 이미지(`image/*`)는 썸네일로, 나머지는 파일 이름과 크기가 있는 링크로 보여 준다.
//
// url은 응답에 온 값을 그대로 쓴다. 공개 버킷 주소든 수명이 짧은 서명 URL(15분)이든 형식을 해석하거나
// 쿼리를 붙이지 않는다(#22). 썸네일을 못 불러오면(만료된 서명 URL, url이 null인 서명 실패, 브라우저가
// 못 그리는 HEIC 등) 파일 링크로 돌아간다. 파일 링크는 downloadPath(attachment)가 있으면 누를 때마다
// 백엔드에서 새 다운로드 URL을 받아 원래 이름으로 내려받는다(AttachmentLink).

const TONES = {
  // 흰 배경(상대 메시지, 제출 이력)
  default: {
    file: 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
    size: 'text-gray-400',
    caption: 'text-gray-500',
    frame: 'border-gray-200 bg-gray-100',
    error: 'text-red-600',
  },
  // 파란 말풍선(내 메시지)
  inverted: {
    file: 'border-primary-400 bg-primary-500 text-white hover:bg-primary-400',
    size: 'text-primary-100',
    caption: 'text-primary-100',
    frame: 'border-primary-400 bg-primary-500',
    error: 'text-primary-100',
  },
};

export function isImageAttachment(attachment) {
  return typeof attachment?.mimeType === 'string' && attachment.mimeType.toLowerCase().startsWith('image/');
}

function FileLink({ attachment, tone, downloadPath }) {
  const className = `flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${tone.file}`;
  const content = (
    <>
      <PaperclipIcon className="h-4 w-4 shrink-0" />
      <span className="truncate font-medium">{attachment.fileName}</span>
      <span className={`shrink-0 ${tone.size}`}>{formatFileSize(attachment.size)}</span>
    </>
  );
  if (downloadPath) {
    return (
      <AttachmentLink attachment={attachment} downloadPath={downloadPath(attachment)} className={className} errorClassName={tone.error}>
        {content}
      </AttachmentLink>
    );
  }
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      download={attachment.fileName}
      className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${tone.file}`}
    >
      <PaperclipIcon className="h-4 w-4 shrink-0" />
      <span className="truncate font-medium">{attachment.fileName}</span>
      <span className={`shrink-0 ${tone.size}`}>{formatFileSize(attachment.size)}</span>
    </a>
  );
}

// 썸네일 칸의 크기를 고정한다. 이미지가 늦게 불러와져도 높이가 바뀌지 않아야 대화창의
// "맨 아래에 붙어 있기" 스크롤이 어긋나지 않는다.
function ImageThumb({ attachment, tone, single, onError }) {
  return (
    <figure className={single ? 'w-64 max-w-full' : 'w-32'}>
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${attachment.fileName} 원본 보기`}
        className={`block overflow-hidden rounded-lg border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${tone.frame} ${
          single ? 'h-44' : 'h-32'
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- 저장소 URL(서명 URL 포함)은 next/image 최적화 대상이 아니다 */}
        <img
          src={attachment.url}
          alt={attachment.fileName}
          loading="lazy"
          decoding="async"
          onError={onError}
          className="h-full w-full object-cover transition-opacity hover:opacity-90"
        />
      </a>
      <figcaption className={`mt-1 flex gap-1.5 text-[11px] ${tone.caption}`}>
        <span className="truncate">{attachment.fileName}</span>
        <span className="shrink-0">{formatFileSize(attachment.size)}</span>
      </figcaption>
    </figure>
  );
}

export default function AttachmentList({ attachments, downloadPath, tone: toneName = 'default', className = '' }) {
  // 불러오지 못한 이미지의 id. 그 첨부는 파일 링크로 보여 준다.
  const [broken, setBroken] = useState(() => new Set());
  if (!attachments?.length) return null;

  const tone = TONES[toneName] || TONES.default;
  const images = attachments.filter((a) => isImageAttachment(a) && a.url && !broken.has(a.id));
  const files = attachments.filter((a) => !images.includes(a));

  function markBroken(id) {
    setBroken((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }

  return (
    <div className={`space-y-1.5 ${className}`}>
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {images.map((attachment) => (
            <li key={attachment.id} className="min-w-0 max-w-full">
              <ImageThumb
                attachment={attachment}
                tone={tone}
                single={images.length === 1}
                onError={() => markBroken(attachment.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((attachment) => (
            <li key={attachment.id}>
              <FileLink attachment={attachment} tone={tone} downloadPath={downloadPath} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
