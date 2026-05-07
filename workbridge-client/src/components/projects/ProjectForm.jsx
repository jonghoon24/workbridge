'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import api from '@/lib/api';

const CATEGORIES = ['웹 개발', '모바일 앱', '디자인', 'AI/ML', '데이터 분석', '마케팅', '기타'];

export default function ProjectForm({ initialData = null }) {
  const router = useRouter();
  const isEditing = !!initialData;
  const hasApplications = isEditing && (initialData?._count?.applications || 0) > 0;

  const [form, setForm] = useState({
    title: initialData?.title || '',
    description: initialData?.description || '',
    category: initialData?.category || '',
    budget: initialData?.budget || '',
    deadline: initialData?.deadline ? new Date(initialData.deadline).toISOString().split('T')[0] : '',
    requiredSkills: initialData?.requiredSkills?.join(', ') || '',
  });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);

  function validate() {
    const errs = {};
    if (!form.title.trim()) errs.title = '프로젝트명을 입력하세요';
    if (!form.description.trim()) errs.description = '프로젝트 설명을 입력하세요';
    if (!form.category) errs.category = '카테고리를 선택하세요';
    if (!hasApplications && (!form.budget || isNaN(form.budget))) errs.budget = '올바른 예산을 입력하세요';
    if (!hasApplications && !form.deadline) errs.deadline = '마감일을 선택하세요';
    return errs;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    setLoading(true);
    try {
      const payload = {
        title: form.title,
        description: form.description,
        category: form.category,
        requiredSkills: form.requiredSkills
          ? form.requiredSkills.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
      };

      if (!hasApplications) {
        payload.budget = parseFloat(form.budget);
        payload.deadline = form.deadline;
      }

      if (isEditing) {
        await api.patch(`/api/projects/${initialData.id}`, payload);
        router.push(`/projects/${initialData.id}`);
      } else {
        const { data } = await api.post('/api/projects', payload);
        router.push(`/projects/${data.id}`);
      }
    } catch (err) {
      setErrors({ submit: err.response?.data?.error?.message || '오류가 발생했습니다' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {errors.submit && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {errors.submit}
        </div>
      )}

      {hasApplications && (
        <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 text-sm">
          지원자가 있는 프로젝트는 예산과 마감일을 변경할 수 없습니다.
        </div>
      )}

      <Input
        label="프로젝트명"
        required
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
        error={errors.title}
        placeholder="프로젝트 제목을 입력하세요"
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          프로젝트 설명 <span className="text-red-500">*</span>
        </label>
        <textarea
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          rows={5}
          className={`block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm ${
            errors.description ? 'border-red-300' : ''
          }`}
          placeholder="프로젝트에 대해 자세히 설명해주세요"
        />
        {errors.description && <p className="mt-1 text-sm text-red-600">{errors.description}</p>}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          카테고리 <span className="text-red-500">*</span>
        </label>
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          className={`block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm ${
            errors.category ? 'border-red-300' : ''
          }`}
        >
          <option value="">카테고리 선택</option>
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
        {errors.category && <p className="mt-1 text-sm text-red-600">{errors.category}</p>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Input
          label="예산 (원)"
          required
          type="number"
          value={form.budget}
          onChange={(e) => setForm({ ...form, budget: e.target.value })}
          error={errors.budget}
          placeholder="예: 1000000"
          disabled={hasApplications}
          helpText={hasApplications ? '지원자가 있어 수정할 수 없습니다' : undefined}
        />

        <Input
          label="마감일"
          required
          type="date"
          value={form.deadline}
          onChange={(e) => setForm({ ...form, deadline: e.target.value })}
          error={errors.deadline}
          min={new Date().toISOString().split('T')[0]}
          disabled={hasApplications}
          helpText={hasApplications ? '지원자가 있어 수정할 수 없습니다' : undefined}
        />
      </div>

      <Input
        label="필요 기술 스택"
        value={form.requiredSkills}
        onChange={(e) => setForm({ ...form, requiredSkills: e.target.value })}
        placeholder="React, Node.js, Python (쉼표로 구분)"
        helpText="쉼표로 구분하여 입력하세요"
      />

      <div className="flex gap-3 justify-end">
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          취소
        </Button>
        <Button type="submit" loading={loading}>
          {isEditing ? '수정하기' : '등록하기'}
        </Button>
      </div>
    </form>
  );
}
