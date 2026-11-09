'use client';

import { useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { fieldBorder } from '@/components/ui/Input';
import { MILESTONE_LIMITS } from '@/constants/milestones';
import { toUserMessage } from '@/lib/errorMessages';

// 수정 요청(서버 용어: reject) 사항은 trim 후 10~2,000자.
export default function RejectModal({ isOpen, milestone, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setError('');
    }
  }, [isOpen]);

  const length = reason.trim().length;

  async function handleSubmit(e) {
    e.preventDefault();
    if (length < MILESTONE_LIMITS.reasonMin) {
      setError(`수정 요청 사항을 ${MILESTONE_LIMITS.reasonMin}자 이상 입력해 주세요.`);
      return;
    }
    if (length > MILESTONE_LIMITS.reasonMax) {
      setError(`수정 요청 사항은 ${MILESTONE_LIMITS.reasonMax.toLocaleString()}자 이하로 입력해 주세요.`);
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await onSubmit(reason.trim());
    } catch (err) {
      setError(toUserMessage(err, '수정 요청을 보내지 못했습니다'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="수정 요청하기">
      <form onSubmit={handleSubmit} className="space-y-4">
        {milestone && (
          <p className="text-sm text-gray-600">
            <span className="font-medium text-gray-900">#{milestone.sequence} {milestone.title}</span>
            의 결과물에 수정을 요청합니다. 프리랜서가 다시 제출할 때까지 자동 승인은 멈춥니다.
          </p>
        )}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}
        <div>
          <label htmlFor="reject-reason" className="block text-sm font-medium text-gray-700 mb-1">
            수정 요청 사항<span className="text-red-500 ml-1">*</span>
          </label>
          <textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={5}
            className={`block w-full rounded-lg shadow-sm text-sm ${fieldBorder(error)}`}
            placeholder="수정이 필요한 부분을 구체적으로 적어 주세요 (10자 이상)"
          />
          <p className={`mt-1 text-xs ${length < MILESTONE_LIMITS.reasonMin ? 'text-gray-400' : 'text-gray-500'}`}>
            {length.toLocaleString()} / {MILESTONE_LIMITS.reasonMax.toLocaleString()}자
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>취소</Button>
          <Button type="submit" loading={submitting}>수정 요청 보내기</Button>
        </div>
      </form>
    </Modal>
  );
}
