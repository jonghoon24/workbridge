'use client';

import { useState } from 'react';
import api from '@/lib/api';
import Button from '@/components/ui/Button';
import { formatFileSize } from '@/lib/format';
import { ATTACHMENT_ACCEPT, MILESTONE_LIMITS } from '@/constants/milestones';
import { toUserMessage } from '@/lib/errorMessages';
import { forgetUploads, uploadAttachments } from '@/lib/attachments';
import useLeaveWarning from '@/lib/useLeaveWarning';
import FileButton from '@/components/ui/FileButton';

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// 결과물 제출. 파일은 저장소로 먼저 올리고(lib/attachments.js, 진행률 표시) message, links와
// 업로드 id(uploadIds)를 JSON으로 보낸다. 실패하면 입력과 파일을 그대로 두어 다시 제출할 수 있다.
// 화면 검사는 마일스톤 한도를 미리 알려주는 용도이고, 파일 형식은 서버가 판단한다.
export default function SubmissionForm({ milestoneId, isResubmission = false, onSubmitted }) {
  const [message, setMessage] = useState('');
  const [links, setLinks] = useState(['']);
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  useLeaveWarning(progress !== null);

  function updateLink(index, value) {
    setLinks((prev) => prev.map((link, i) => (i === index ? value : link)));
  }

  function addLink() {
    setLinks((prev) => (prev.length >= MILESTONE_LIMITS.linksMax ? prev : [...prev, '']));
  }

  function removeLink(index) {
    setLinks((prev) => (prev.length === 1 ? [''] : prev.filter((_, i) => i !== index)));
  }

  function handleFileChange(e) {
    const selected = Array.from(e.target.files || []);
    setFiles((prev) => [...prev, ...selected].slice(0, MILESTONE_LIMITS.filesMax));
    setFileInputKey((key) => key + 1);
  }

  function removeFile(index) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function validate(filledLinks) {
    const trimmed = message.trim();
    if (!trimmed) return '작업 내용을 입력해 주세요.';
    if (trimmed.length > MILESTONE_LIMITS.messageMax) {
      return `작업 내용은 ${MILESTONE_LIMITS.messageMax.toLocaleString()}자 이하로 입력해 주세요.`;
    }
    if (filledLinks.length > MILESTONE_LIMITS.linksMax) {
      return `링크는 최대 ${MILESTONE_LIMITS.linksMax}개까지 첨부할 수 있습니다.`;
    }
    const badLink = filledLinks.find((link) => link.length > MILESTONE_LIMITS.linkMax || !isHttpUrl(link));
    if (badLink) return `링크는 http:// 또는 https://로 시작하는 주소여야 합니다: ${badLink}`;
    if (files.length > MILESTONE_LIMITS.filesMax) {
      return `파일은 최대 ${MILESTONE_LIMITS.filesMax}개까지 첨부할 수 있습니다.`;
    }
    const bigFile = files.find((file) => file.size > MILESTONE_LIMITS.fileMaxBytes);
    if (bigFile) return `파일은 개당 10MB 이하여야 합니다: ${bigFile.name}`;
    return '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const filledLinks = links.map((link) => link.trim()).filter(Boolean);
    const validationError = validate(filledLinks);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError('');
    const resource = `/api/milestones/${milestoneId}`;
    try {
      let uploadIds = [];
      if (files.length > 0) {
        setProgress(0);
        uploadIds = await uploadAttachments(resource, files, setProgress);
        setProgress(null);
      }

      const { data } = await api.post(`${resource}/submissions`, {
        message: message.trim(),
        links: filledLinks,
        uploadIds,
      });

      forgetUploads(files);
      setMessage('');
      setLinks(['']);
      setFiles([]);
      onSubmitted?.(data);
    } catch (err) {
      if (err.displayMessage) {
        setError(err.displayMessage);
      } else {
        // 업로드가 만료됐거나 저장된 파일이 거부되면 다음 시도에서 새로 올린다.
        if ([400, 413].includes(err.response?.status)) forgetUploads(files);
        if (err.response?.status === 413) {
          setError(toUserMessage(err, '파일이 너무 큽니다. 크기를 줄여 다시 올려 주세요.'));
        } else {
          setError(toUserMessage(err, '결과물을 제출하지 못했습니다.'));
        }
      }
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }

  return (
    // noValidate: 브라우저 기본 검증(url 입력) 말풍선 대신 validate()의 한국어 안내를 보여 준다.
    <form id="submission-form" noValidate onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="submission-message" className="block text-sm font-medium text-gray-700 mb-1">
          작업 내용<span className="text-red-500 ml-1">*</span>
        </label>
        <textarea
          id="submission-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={6}
          className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
          placeholder={isResubmission
            ? '수정 요청 사항을 어떻게 반영했는지 적어 주세요'
            : '이번 마일스톤에서 완료한 작업과 확인 방법을 적어 주세요'}
        />
        <p className="mt-1 text-xs text-gray-400">
          {message.trim().length.toLocaleString()} / {MILESTONE_LIMITS.messageMax.toLocaleString()}자
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          링크 <span className="text-gray-400 font-normal">(최대 {MILESTONE_LIMITS.linksMax}개)</span>
        </label>
        <div className="space-y-2">
          {links.map((link, index) => (
            <div key={index} className="flex gap-2">
              <input
                type="url"
                value={link}
                onChange={(e) => updateLink(index, e.target.value)}
                placeholder="https://github.com/..."
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
              />
              <Button variant="ghost" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => removeLink(index)}>삭제</Button>
            </div>
          ))}
        </div>
        {links.length < MILESTONE_LIMITS.linksMax && (
          <button type="button" onClick={addLink} className="mt-2 text-sm text-primary-600 hover:text-primary-700">
            + 링크 추가
          </button>
        )}
      </div>

      <div>
        <p className="block text-sm font-medium text-gray-700 mb-1">
          첨부 파일 <span className="text-gray-400 font-normal">(최대 {MILESTONE_LIMITS.filesMax}개, 개당 10MB)</span>
        </p>
        <FileButton
          id="submission-files"
          inputKey={fileInputKey}
          label="파일 선택"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={handleFileChange}
          disabled={files.length >= MILESTONE_LIMITS.filesMax}
          fileName={files.length > 0 ? `${files.length}개 선택됨` : ''}
        />
        <p className="mt-1 text-xs text-gray-400">이미지, PDF, ZIP, 텍스트, 오피스 문서, HWP</p>
        {files.length > 0 && (
          <ul className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-200">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="truncate text-gray-700">
                  {file.name}
                  <span className={`ml-2 text-xs ${file.size > MILESTONE_LIMITS.fileMaxBytes ? 'text-red-600' : 'text-gray-400'}`}>
                    {formatFileSize(file.size)}
                  </span>
                </span>
                <button type="button" onClick={() => removeFile(index)} disabled={submitting} className="ml-3 text-xs text-gray-500 hover:text-red-600 disabled:opacity-50">
                  제거
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {progress !== null && (
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full bg-primary-600 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-xs text-gray-500" aria-live="polite">
            파일 업로드 중 {progress}% · 업로드가 끝날 때까지 이 창을 닫지 마세요.
          </p>
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" loading={submitting}>
          {isResubmission ? '다시 제출하기' : '결과물 제출하기'}
        </Button>
      </div>
    </form>
  );
}
