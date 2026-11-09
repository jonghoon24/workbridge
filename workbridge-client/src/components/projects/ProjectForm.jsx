'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Input, { fieldBorder } from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import CheckboxChips from '@/components/ui/CheckboxChips';
import api from '@/lib/api';
import { normalizeSkillList, PROJECT_CATEGORIES, SKILL_OPTIONS } from '@/constants/taxonomy';
import { toUserMessage } from '@/lib/errorMessages';
import { formatDate, kstToday, toKstDateInput } from '@/lib/format';

const STEPS = [
  { title: '기본 정보', fields: ['title', 'category', 'description'] },
  { title: '모집 조건', fields: ['budget', 'recruitmentStartDate', 'deadline'] },
  { title: '기술/검토', fields: ['requiredSkills'] },
];

const REVIEW_SUBMIT_DELAY_MS = 500;

export default function ProjectForm({ initialData = null }) {
  const router = useRouter();
  const isEditing = !!initialData;
  const hasApplications = isEditing && (initialData?._count?.applications || 0) > 0;
  const lastStep = STEPS.length - 1;
  const today = kstToday();

  const [form, setForm] = useState({
    title: initialData?.title || '',
    description: initialData?.description || '',
    category: initialData?.category || '',
    budget: initialData?.budget || '',
    recruitmentStartDate: initialData?.recruitmentStartDate
      ? toKstDateInput(initialData.recruitmentStartDate)
      : today,
    deadline: initialData?.deadline ? toKstDateInput(initialData.deadline) : '',
    requiredSkills: normalizeSkillList(initialData?.requiredSkills || []),
  });
  const [currentStep, setCurrentStep] = useState(0);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [canSubmitReview, setCanSubmitReview] = useState(false);

  useEffect(() => {
    if (currentStep !== lastStep) {
      setCanSubmitReview(false);
      return undefined;
    }

    setCanSubmitReview(false);
    const timer = window.setTimeout(() => setCanSubmitReview(true), REVIEW_SUBMIT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [currentStep, lastStep]);

  function validate() {
    const errs = {};
    // 금액은 원 단위 정수다(서버도 소수를 400으로 거절한다).
    const budget = Number(form.budget);
    if (!form.title.trim()) errs.title = '프로젝트명을 입력해 주세요';
    if (!form.description.trim()) errs.description = '프로젝트 설명을 입력해 주세요';
    if (!form.category) errs.category = '카테고리를 선택해 주세요';
    if (!hasApplications && (!form.budget || !Number.isSafeInteger(budget) || budget <= 0)) {
      errs.budget = '예산을 1원 이상의 원 단위 정수로 입력해 주세요';
    }
    if (!hasApplications && !form.recruitmentStartDate) {
      errs.recruitmentStartDate = '모집 시작일을 선택해 주세요';
    }
    if (!hasApplications && !form.deadline) errs.deadline = '마감일을 선택해 주세요';
    if (
      !hasApplications
      && form.recruitmentStartDate
      && form.deadline
      && form.recruitmentStartDate > form.deadline
    ) {
      errs.deadline = '마감일은 모집 시작일 이후로 선택해 주세요';
    }
    if (form.requiredSkills.length === 0) errs.requiredSkills = '필요 기술을 하나 이상 선택해 주세요';
    return errs;
  }

  function getFirstInvalidStep(errs) {
    const index = STEPS.findIndex((step) => step.fields.some((field) => errs[field]));
    return index === -1 ? currentStep : index;
  }

  function validateCurrentStep() {
    const allErrors = validate();
    const stepFields = STEPS[currentStep].fields;
    return stepFields.reduce((stepErrors, field) => {
      if (allErrors[field]) stepErrors[field] = allErrors[field];
      return stepErrors;
    }, {});
  }

  function handleNext() {
    const stepErrors = validateCurrentStep();
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      return;
    }

    setErrors({});
    setCurrentStep((step) => Math.min(step + 1, lastStep));
  }

  function handleBack() {
    setErrors({});
    setCurrentStep((step) => Math.max(step - 1, 0));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmitReview) return;

    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      setCurrentStep(getFirstInvalidStep(errs));
      return;
    }

    setLoading(true);
    try {
      const payload = {
        title: form.title,
        description: form.description,
        category: form.category,
        requiredSkills: normalizeSkillList(form.requiredSkills),
      };

      if (!hasApplications) {
        payload.budget = Number(form.budget);
        payload.recruitmentStartDate = form.recruitmentStartDate;
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
      setErrors({ submit: toUserMessage(err, isEditing ? '프로젝트를 수정하지 못했습니다' : '프로젝트를 등록하지 못했습니다') });
    } finally {
      setLoading(false);
    }
  }

  function handleFormSubmit(e) {
    if (currentStep === lastStep) {
      handleSubmit(e);
      return;
    }

    e.preventDefault();
    handleNext();
  }

  const formattedBudget = form.budget ? `${Number(form.budget).toLocaleString()}원` : '-';
  const formattedRecruitmentStartDate = formatDate(form.recruitmentStartDate);
  const formattedDeadline = formatDate(form.deadline);

  return (
    <form onSubmit={handleFormSubmit} className="space-y-6">
      <div className="grid grid-cols-3 gap-2">
        {STEPS.map((step, index) => (
          <button
            key={step.title}
            type="button"
            onClick={() => {
              if (index <= currentStep) {
                setErrors({});
                setCurrentStep(index);
              }
            }}
            disabled={index > currentStep}
            className={`rounded-lg border px-3 py-2 text-left transition-colors ${
              index === currentStep
                ? 'border-primary-500 bg-primary-50 text-primary-700'
                : index < currentStep
                  ? 'border-green-200 bg-green-50 text-green-700'
                  : 'border-gray-200 bg-gray-50 text-gray-500'
            }`}
          >
            <span className="block text-xs font-medium">{index + 1}단계</span>
            <span className="block text-sm font-semibold">{step.title}</span>
          </button>
        ))}
      </div>

      {errors.submit && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {errors.submit}
        </div>
      )}

      {hasApplications && (
        <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 text-sm">
          지원자가 있는 프로젝트는 예산과 모집 일정을 변경할 수 없습니다.
        </div>
      )}

      {currentStep === 0 && (
        <div className="space-y-6">
          <Input
            label="프로젝트명"
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            error={errors.title}
            placeholder="프로젝트 제목을 입력해 주세요"
          />

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              카테고리 <span className="text-red-500">*</span>
            </label>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              aria-invalid={errors.category ? true : undefined}
              className={`block w-full rounded-lg shadow-sm sm:text-sm ${fieldBorder(errors.category)}`}
            >
              <option value="">카테고리 선택</option>
              {PROJECT_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            {errors.category && <p className="mt-1 text-sm text-red-600">{errors.category}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              프로젝트 설명 <span className="text-red-500">*</span>
            </label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={6}
              aria-invalid={errors.description ? true : undefined}
              className={`block w-full rounded-lg shadow-sm sm:text-sm ${fieldBorder(errors.description)}`}
              placeholder="프로젝트에 대해 자세히 설명해 주세요"
            />
            {errors.description && <p className="mt-1 text-sm text-red-600">{errors.description}</p>}
          </div>
        </div>
      )}

      {currentStep === 1 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Input
            label="예산 (원)"
            required
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={form.budget}
            onChange={(e) => setForm({ ...form, budget: e.target.value })}
            error={errors.budget}
            placeholder="예: 1000000"
            disabled={hasApplications}
            helpText={hasApplications ? '지원자가 있어 수정할 수 없습니다' : undefined}
          />

          <Input
            label="모집 시작일"
            required
            type="date"
            value={form.recruitmentStartDate}
            onChange={(e) => setForm({ ...form, recruitmentStartDate: e.target.value })}
            error={errors.recruitmentStartDate}
            min={today}
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
            min={form.recruitmentStartDate || today}
            disabled={hasApplications}
            helpText={hasApplications ? '지원자가 있어 수정할 수 없습니다' : undefined}
          />
        </div>
      )}

      {currentStep === 2 && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              필요 기술 스택 <span className="text-red-500">*</span>
            </label>
            <CheckboxChips
              options={SKILL_OPTIONS}
              value={form.requiredSkills}
              onChange={(requiredSkills) => setForm({ ...form, requiredSkills: normalizeSkillList(requiredSkills) })}
            />
            {errors.requiredSkills && <p className="mt-2 text-sm text-red-600">{errors.requiredSkills}</p>}
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">등록 정보</h3>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-gray-500">프로젝트명</dt>
                <dd className="font-medium text-gray-900 break-words">{form.title || '-'}</dd>
              </div>
              <div>
                <dt className="text-gray-500">카테고리</dt>
                <dd className="font-medium text-gray-900">{form.category || '-'}</dd>
              </div>
              <div>
                <dt className="text-gray-500">예산</dt>
                <dd className="font-medium text-gray-900">{formattedBudget}</dd>
              </div>
              <div>
                <dt className="text-gray-500">모집 시작일</dt>
                <dd className="font-medium text-gray-900">{formattedRecruitmentStartDate}</dd>
              </div>
              <div>
                <dt className="text-gray-500">마감일</dt>
                <dd className="font-medium text-gray-900">{formattedDeadline}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-gray-500">필요 기술</dt>
                <dd className="font-medium text-gray-900">
                  {form.requiredSkills.length > 0 ? form.requiredSkills.join(', ') : '-'}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-gray-500">설명</dt>
                <dd className="font-medium text-gray-900 whitespace-pre-wrap break-words">{form.description || '-'}</dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          취소
        </Button>
        <div className="flex gap-3 justify-end [&>*]:flex-1 sm:[&>*]:flex-none">
          {currentStep > 0 && (
            <Button type="button" variant="secondary" onClick={handleBack}>
              이전
            </Button>
          )}
          {currentStep < lastStep ? (
            <Button type="button" onClick={handleNext}>
              다음
            </Button>
          ) : (
            <Button type="submit" loading={loading} disabled={!canSubmitReview}>
              {isEditing ? '수정하기' : '등록하기'}
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
