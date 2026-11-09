'use client';

import { formatDateTime, formatFileSize } from '@/lib/format';

function DecisionLabel({ submission }) {
  if (!submission.decision) {
    return <span className="text-xs font-medium text-purple-700 bg-purple-50 rounded px-2 py-0.5">검수 대기</span>;
  }
  if (submission.decision === 'APPROVED') {
    return (
      <span className="text-xs font-medium text-green-700 bg-green-50 rounded px-2 py-0.5">
        {submission.autoDecided ? '자동 승인' : '승인'}
      </span>
    );
  }
  return <span className="text-xs font-medium text-orange-700 bg-orange-50 rounded px-2 py-0.5">수정 요청</span>;
}

// 제출 이력(round 내림차순). 첨부 url은 공개 버킷 주소다(DECISIONS: 첨부 파일).
export default function SubmissionHistory({ submissions = [] }) {
  if (submissions.length === 0) {
    return <p className="text-sm text-gray-500">아직 제출한 결과물이 없습니다.</p>;
  }

  return (
    <ol className="relative border-l border-gray-200 ml-2 space-y-6">
      {submissions.map((submission) => (
        <li key={submission.id} className="ml-5">
          <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-primary-500" />
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-gray-900">{submission.round}차 제출</h3>
            <DecisionLabel submission={submission} />
            <span className="text-xs text-gray-400">{formatDateTime(submission.submittedAt)}</span>
          </div>

          <p className="mt-2 text-sm text-gray-700 whitespace-pre-wrap break-words">{submission.message}</p>

          {submission.links?.length > 0 && (
            <ul className="mt-2 space-y-1">
              {submission.links.map((link) => (
                <li key={link} className="text-sm">
                  <a href={link} target="_blank" rel="noopener noreferrer" className="text-primary-600 hover:text-primary-700 break-all">
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          )}

          {submission.attachments?.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {submission.attachments.map((attachment) => (
                <li key={attachment.id}>
                  <a
                    href={attachment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100"
                  >
                    <span className="max-w-[16rem] truncate">{attachment.fileName}</span>
                    <span className="text-gray-400">{formatFileSize(attachment.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}

          {submission.decision === 'REJECTED' && submission.decisionReason && (
            <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 p-3">
              <p className="text-xs font-medium text-orange-800">
                수정 요청 사항 · {formatDateTime(submission.decidedAt)}
              </p>
              <p className="mt-1 text-sm text-orange-900 whitespace-pre-wrap break-words">{submission.decisionReason}</p>
            </div>
          )}
          {submission.decision === 'APPROVED' && submission.decidedAt && (
            <p className="mt-2 text-xs text-gray-500">
              {submission.autoDecided ? '검수 기한이 지나 자동 승인' : '의뢰인 승인'} · {formatDateTime(submission.decidedAt)}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
