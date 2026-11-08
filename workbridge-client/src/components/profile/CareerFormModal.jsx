'use client';

import { useState } from 'react';
import api from '@/lib/api';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { currentKstMonth, describeProfileError, EMPLOYMENT_TYPES } from './profileFormat';

const EMPTY = { company: '', position: '', employmentType: 'FULL_TIME', startDate: '', endDate: '', current: false, description: '' };

function toForm(career) {
  if (!career) return EMPTY;
  return {
    company: career.company,
    position: career.position,
    employmentType: career.employmentType,
    startDate: career.startDate,
    endDate: career.endDate || '',
    current: !career.endDate,
    description: career.description || '',
  };
}

// 경력 추가·수정(BEHAVIOR.md PF13, PF14). JSON으로 보낸다. 재직 중이면 endDate를 null로 보낸다.
// 폼은 첫 렌더부터 career로 채운다(PortfolioItemModal과 같은 이유). 부모가 key로 새로 마운트한다.
export default function CareerFormModal({ isOpen, career, onClose, onSaved }) {
  const [form, setForm] = useState(() => toForm(career));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function validate() {
    if (!form.company.trim()) return '회사명을 입력해주세요.';
    if (!form.position.trim()) return '직책을 입력해주세요.';
    if (!form.startDate) return '시작 월을 선택해주세요.';
    if (!form.current && !form.endDate) return '종료 월을 선택하거나 재직 중을 체크해주세요.';
    if (!form.current && form.endDate < form.startDate) return '종료 월은 시작 월보다 빠를 수 없습니다.';
    return '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    const body = {
      company: form.company.trim(),
      position: form.position.trim(),
      employmentType: form.employmentType,
      startDate: form.startDate,
      endDate: form.current ? null : form.endDate,
      description: form.description.trim(),
    };

    setSaving(true);
    setError('');
    try {
      const { data } = career
        ? await api.patch(`/api/users/me/careers/${career.id}`, body)
        : await api.post('/api/users/me/careers', body);
      onSaved(data.career);
    } catch (err) {
      setError(describeProfileError(err, '경력을 저장하지 못했습니다'));
    } finally {
      setSaving(false);
    }
  }

  const maxMonth = currentKstMonth();

  return (
    <Modal isOpen={isOpen} onClose={saving ? () => {} : onClose} title={career ? '경력 수정' : '경력 추가'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

        <Input
          id="career-company"
          label="회사명"
          required
          maxLength={100}
          value={form.company}
          onChange={(e) => setForm({ ...form, company: e.target.value })}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            id="career-position"
            label="직책"
            required
            maxLength={100}
            value={form.position}
            onChange={(e) => setForm({ ...form, position: e.target.value })}
            placeholder="예: 백엔드 개발자"
          />
          <div>
            <label htmlFor="career-employmentType" className="block text-sm font-medium text-gray-700 mb-1">
              고용 형태<span className="text-red-500 ml-1">*</span>
            </label>
            <select
              id="career-employmentType"
              value={form.employmentType}
              onChange={(e) => setForm({ ...form, employmentType: e.target.value })}
              className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
            >
              {EMPLOYMENT_TYPES.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            id="career-startDate"
            label="시작 월"
            required
            type="month"
            max={maxMonth}
            value={form.startDate}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })}
          />
          <Input
            id="career-endDate"
            label="종료 월"
            type="month"
            max={maxMonth}
            min={form.startDate || undefined}
            disabled={form.current}
            value={form.current ? '' : form.endDate}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={form.current}
            onChange={(e) => setForm({ ...form, current: e.target.checked })}
            className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
          />
          현재 재직 중
        </label>
        <div>
          <label htmlFor="career-description" className="block text-sm font-medium text-gray-700 mb-1">주요 업무</label>
          <textarea
            id="career-description"
            rows={3}
            maxLength={2000}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>취소</Button>
          <Button type="submit" loading={saving}>{career ? '저장' : '추가'}</Button>
        </div>
      </form>
    </Modal>
  );
}
