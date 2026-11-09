'use client';

import { useMemo, useState } from 'react';
import api from '@/lib/api';
import Button from '@/components/ui/Button';
import { formatKRW, kstToday, toKstDateInput } from '@/lib/format';
import { toUserMessage, translateServerMessage } from '@/lib/errorMessages';
import { MILESTONE_LIMITS } from '@/constants/milestones';

let rowKey = 0;
function nextKey() {
  rowKey += 1;
  return `row-${rowKey}`;
}

function toRows(milestones = []) {
  return milestones.map((milestone) => ({
    key: nextKey(),
    title: milestone.title || '',
    description: milestone.description || '',
    amount: String(milestone.amount ?? ''),
    dueDate: toKstDateInput(milestone.dueDate),
  }));
}

const FIELD_LABELS = {
  title: '제목',
  description: '설명',
  amount: '금액',
  dueDate: '기한',
};

// 서버 검증 메시지 `milestones.2.amount: …`를 "3번 마일스톤 금액: …"으로 바꿔 보여 준다.
function describeMilestoneField(message) {
  const match = /^milestones\.(\d+)\.(\w+): (.*)$/.exec(message || '');
  if (!match) return null;
  const [, index, field, rest] = match;
  const label = `${Number(index) + 1}번 마일스톤 ${FIELD_LABELS[field] || ''}`.trim();
  return `${label}: ${translateServerMessage(rest) || '입력한 내용을 다시 확인해 주세요.'}`;
}

// 계약 PENDING 동안 의뢰인이 계획 전체를 교체한다(PUT /api/contracts/:id/milestones).
// 합계는 milestoneSummary.contractAmount와 정확히 같아야 하고, 저장하면 양측 서명이 초기화된다.
export default function MilestonePlanEditor({ contract, onSaved, onCancel }) {
  const contractAmount = contract.milestoneSummary?.contractAmount ?? Math.round(contract.amount || 0);
  const hasSignature = contract.clientSigned || contract.freelancerSigned;
  const [rows, setRows] = useState(() => toRows(contract.milestones));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const today = kstToday();

  const total = useMemo(
    () => rows.reduce((sum, row) => sum + (Number.isFinite(Number(row.amount)) ? Number(row.amount) : 0), 0),
    [rows]
  );
  const difference = contractAmount - total;
  const sumMatches = difference === 0;

  function updateRow(key, field, value) {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
  }

  function addRow() {
    setRows((prev) => {
      if (prev.length >= MILESTONE_LIMITS.maxCount) return prev;
      const last = prev[prev.length - 1];
      return [
        ...prev,
        {
          key: nextKey(),
          title: '',
          description: '',
          amount: difference > 0 ? String(difference) : '',
          dueDate: last?.dueDate && last.dueDate >= today ? last.dueDate : today,
        },
      ];
    });
  }

  function removeRow(key) {
    setRows((prev) => (prev.length <= MILESTONE_LIMITS.minCount ? prev : prev.filter((row) => row.key !== key)));
  }

  function moveRow(index, delta) {
    setRows((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  // 서버 검사(금액 합계 등)를 저장 전에 미리 한다.
  function validate() {
    if (rows.length < MILESTONE_LIMITS.minCount || rows.length > MILESTONE_LIMITS.maxCount) {
      return `마일스톤은 ${MILESTONE_LIMITS.minCount}~${MILESTONE_LIMITS.maxCount}개여야 합니다.`;
    }
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const label = `${i + 1}번 마일스톤`;
      const title = row.title.trim();
      const amount = Number(row.amount);
      if (!title) return `${label}: 제목을 입력해 주세요.`;
      if (title.length > MILESTONE_LIMITS.titleMax) return `${label}: 제목은 ${MILESTONE_LIMITS.titleMax}자 이하여야 합니다.`;
      if (row.description.trim().length > MILESTONE_LIMITS.descriptionMax) {
        return `${label}: 설명은 ${MILESTONE_LIMITS.descriptionMax.toLocaleString()}자 이하여야 합니다.`;
      }
      if (row.amount === '' || !Number.isInteger(amount)) return `${label}: 금액은 원 단위 정수로 입력해 주세요.`;
      if (amount < MILESTONE_LIMITS.minAmount) {
        return `${label}: 금액은 ${formatKRW(MILESTONE_LIMITS.minAmount)} 이상이어야 합니다.`;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate)) return `${label}: 기한을 선택해 주세요.`;
      if (row.dueDate < today) return `${label}: 기한은 오늘 이후여야 합니다.`;
      if (i > 0 && row.dueDate < rows[i - 1].dueDate) {
        return `${label}: 기한은 앞 마일스톤보다 빠를 수 없습니다.`;
      }
    }
    if (!sumMatches) {
      return `마일스톤 금액 합계(${formatKRW(total)})가 계약 금액(${formatKRW(contractAmount)})과 같아야 합니다.`;
    }
    return '';
  }

  async function handleSave() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (hasSignature && !confirm('계획을 저장하면 양측 서명이 모두 초기화되어 다시 서명해야 합니다. 저장하시겠습니까?')) {
      return;
    }

    setSaving(true);
    setError('');
    try {
      const { data } = await api.put(`/api/contracts/${contract.id}/milestones`, {
        milestones: rows.map((row) => ({
          title: row.title.trim(),
          description: row.description.trim(),
          amount: Number(row.amount),
          dueDate: row.dueDate,
        })),
      });
      onSaved?.(data, { signaturesReset: hasSignature });
    } catch (err) {
      setError(describeMilestoneField(err.response?.data?.error?.message) || toUserMessage(err, '마일스톤 계획을 저장하지 못했습니다.'));
    } finally {
      setSaving(false);
    }
  }

  const belowMinimum = contractAmount < MILESTONE_LIMITS.minAmount;

  return (
    <div className="space-y-4">
      {hasSignature && (
        <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 text-sm">
          이미 서명이 있습니다. 계획을 바꾸면 양측 서명이 초기화되고 프리랜서에게 알림이 갑니다.
        </div>
      )}
      {belowMinimum && (
        <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-700 text-sm">
          계약 금액이 마일스톤 최소 금액({formatKRW(MILESTONE_LIMITS.minAmount)})보다 작아 기본 마일스톤 하나로만 진행할 수 있습니다.
        </div>
      )}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={row.key} className="rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-gray-700">{index + 1}번 마일스톤</span>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => moveRow(index, -1)} disabled={index === 0} aria-label="위로">
                  ↑
                </Button>
                <Button variant="ghost" size="sm" onClick={() => moveRow(index, 1)} disabled={index === rows.length - 1} aria-label="아래로">
                  ↓
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(row.key)}
                  disabled={rows.length <= MILESTONE_LIMITS.minCount}
                  className="text-red-600"
                >
                  삭제
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
              <div className="sm:col-span-6">
                <label htmlFor={`${row.key}-title`} className="block text-xs font-medium text-gray-600 mb-1">제목</label>
                <input
                  id={`${row.key}-title`}
                  value={row.title}
                  maxLength={MILESTONE_LIMITS.titleMax}
                  onChange={(e) => updateRow(row.key, 'title', e.target.value)}
                  placeholder="예: 기획 및 디자인 시안"
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                />
              </div>
              <div className="sm:col-span-6">
                <label htmlFor={`${row.key}-description`} className="block text-xs font-medium text-gray-600 mb-1">설명 (선택)</label>
                <textarea
                  id={`${row.key}-description`}
                  value={row.description}
                  rows={2}
                  onChange={(e) => updateRow(row.key, 'description', e.target.value)}
                  placeholder="이 단계에서 전달할 결과물"
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                />
              </div>
              <div className="sm:col-span-3">
                <label htmlFor={`${row.key}-amount`} className="block text-xs font-medium text-gray-600 mb-1">금액 (원)</label>
                <input
                  id={`${row.key}-amount`}
                  type="number"
                  inputMode="numeric"
                  min={MILESTONE_LIMITS.minAmount}
                  step={1}
                  value={row.amount}
                  onChange={(e) => updateRow(row.key, 'amount', e.target.value)}
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                />
              </div>
              <div className="sm:col-span-3">
                <label htmlFor={`${row.key}-due`} className="block text-xs font-medium text-gray-600 mb-1">기한</label>
                <input
                  id={`${row.key}-due`}
                  type="date"
                  min={today}
                  value={row.dueDate}
                  onChange={(e) => updateRow(row.key, 'dueDate', e.target.value)}
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {rows.length < MILESTONE_LIMITS.maxCount && (
        <button type="button" onClick={addRow} className="text-sm font-medium text-primary-600 hover:text-primary-700">
          + 마일스톤 추가 ({rows.length}/{MILESTONE_LIMITS.maxCount})
        </button>
      )}

      <div
        className={`flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between rounded-lg p-3 text-sm ${
          sumMatches ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'
        }`}
      >
        <span>
          합계 {formatKRW(total)} / 계약 금액 {formatKRW(contractAmount)}
        </span>
        <span className="font-medium">
          {sumMatches
            ? '합계 일치'
            : difference > 0
              ? `${formatKRW(difference)} 부족`
              : `${formatKRW(-difference)} 초과`}
        </span>
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={saving}>취소</Button>
        )}
        <Button onClick={handleSave} loading={saving} disabled={belowMinimum}>
          계획 저장
        </Button>
      </div>
    </div>
  );
}
