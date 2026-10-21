'use client';

import { useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { MILESTONE_LIMITS } from '@/constants/milestones';

// 반려 사유는 trim 후 10~2,000자(BEHAVIOR.md MS18).
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
      setError(`반려 사유를 ${MILESTONE_LIMITS.reasonMin}자 이상 입력해주세요.`);
      return;
    }
    if (length > MILESTONE_LIMITS.reasonMax) {
      setError(`반려 사유는 ${MILESTONE_LIMITS.reasonMax.toLocaleString()}자 이하로 입력해주세요.`);
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await onSubmit(reason.trim());
    } catch (err) {
      setError(err.response?.data?.error?.message || '반려 처리에 실패했습니다');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="수정 요청 (반려)">
      <form onSubmit={handleSubmit} className="space-y-4">
        {milestone && (
          <p className="text-sm text-gray-600">
            <span className="font-medium text-gray-900">#{milestone.sequence} {milestone.title}</span>
            의 제출물을 반려하고 프리랜서에게 재제출을 요청합니다. 자동 승인 타이머는 취소됩니다.
          </p>
        )}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}
        <div>
          <label htmlFor="reject-reason" className="block text-sm font-medium text-gray-700 mb-1">
            반려 사유<span className="text-red-500 ml-1">*</span>
          </label>
          <textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={5}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
            placeholder="수정이 필요한 부분을 구체적으로 적어주세요 (10자 이상)"
          />
          <p className={`mt-1 text-xs ${length < MILESTONE_LIMITS.reasonMin ? 'text-gray-400' : 'text-gray-500'}`}>
            {length.toLocaleString()} / {MILESTONE_LIMITS.reasonMax.toLocaleString()}자
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>취소</Button>
          <Button type="submit" variant="danger" loading={submitting}>반려하기</Button>
        </div>
      </form>
    </Modal>
  );
}
