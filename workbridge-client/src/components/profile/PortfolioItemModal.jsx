'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import CheckboxChips from '@/components/ui/CheckboxChips';
import { normalizeSkillList, SKILL_OPTIONS } from '@/constants/taxonomy';
import ProfileImage from './ProfileImage';
import { currentKstMonth, describeProfileError } from './profileFormat';

const EMPTY = { title: '', description: '', url: '', role: '', skills: [], startedAt: '', endedAt: '' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SKILLS = 10;

function toForm(item) {
  if (!item) return EMPTY;
  return {
    title: item.title || '',
    description: item.description || '',
    url: item.url || '',
    role: item.role || '',
    skills: item.skills || [],
    startedAt: item.startedAt || '',
    endedAt: item.endedAt || '',
  };
}

// 포트폴리오 추가·수정(BEHAVIOR.md PF9, PF10). 이미지가 있을 수 있어 항상 multipart로 보낸다.
// 수정 때는 모든 필드를 보낸다: 빈 값은 서버에서 null로 지워진다. 그래서 폼은 첫 렌더부터 item으로
// 채워져 있어야 한다(effect로 채우면 첫 프레임의 입력이 빈 폼으로 저장되어 항목이 지워진다).
// 부모는 열 때마다 key={item?.id ?? 'new'}로 새로 마운트한다.
export default function PortfolioItemModal({ isOpen, item, onClose, onSaved }) {
  const [form, setForm] = useState(() => toForm(item));
  const [imageFile, setImageFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!imageFile) {
      setPreviewUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(imageFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('이미지 파일만 올릴 수 있습니다.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError('이미지는 5MB 이하만 올릴 수 있습니다.');
      return;
    }
    setError('');
    setImageFile(file);
    setRemoveImage(false);
  }

  function validate() {
    if (!form.title.trim()) return '제목을 입력해주세요.';
    if (form.title.trim().length > 100) return '제목은 100자 이하로 입력해주세요.';
    if (form.url.trim() && !/^https?:\/\//i.test(form.url.trim())) return '링크는 http:// 또는 https://로 시작하는 주소여야 합니다.';
    if (form.skills.length > MAX_SKILLS) return '기술은 최대 10개까지 선택할 수 있습니다.';
    if (form.endedAt && !form.startedAt) return '종료 월을 입력하려면 시작 월도 입력해주세요.';
    if (form.startedAt && form.endedAt && form.endedAt < form.startedAt) return '종료 월은 시작 월보다 빠를 수 없습니다.';
    return '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    const formData = new FormData();
    formData.append('title', form.title.trim());
    for (const key of ['description', 'url', 'role', 'startedAt', 'endedAt']) {
      const value = form[key].trim();
      if (item || value) formData.append(key, value);
    }
    if (form.skills.length > 0) {
      form.skills.forEach((skill) => formData.append('skills', skill));
    } else if (item) {
      formData.append('skills', '');
    }
    if (imageFile) formData.append('image', imageFile);
    else if (item && removeImage) formData.append('removeImage', 'true');

    setSaving(true);
    setError('');
    try {
      const request = item
        ? api.patch(`/api/users/me/portfolio/${item.id}`, formData, { headers: { 'Content-Type': 'multipart/form-data' } })
        : api.post('/api/users/me/portfolio', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      const { data } = await request;
      onSaved(data.item);
    } catch (err) {
      setError(describeProfileError(err, '포트폴리오를 저장하지 못했습니다'));
    } finally {
      setSaving(false);
    }
  }

  const shownImage = previewUrl || (!removeImage ? item?.imageUrl : null);
  const maxMonth = currentKstMonth();

  return (
    <Modal isOpen={isOpen} onClose={saving ? () => {} : onClose} title={item ? '포트폴리오 수정' : '포트폴리오 추가'}>
      <form onSubmit={handleSubmit} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">대표 이미지</label>
          <div className="flex items-center gap-3">
            <ProfileImage src={shownImage} alt={form.title || '포트폴리오'} className="w-28 h-20 rounded border border-gray-200" />
            <div className="flex flex-col gap-1">
              <label className="cursor-pointer text-sm text-primary-600 hover:text-primary-700">
                {shownImage ? '이미지 바꾸기' : '이미지 선택'}
                <input type="file" accept="image/*" onChange={handleFile} className="hidden" />
              </label>
              {imageFile && (
                <button type="button" onClick={() => setImageFile(null)} className="text-left text-xs text-gray-500 hover:text-gray-700">
                  선택 취소
                </button>
              )}
              {item?.imageUrl && !imageFile && !removeImage && (
                <button type="button" onClick={() => setRemoveImage(true)} className="text-left text-xs text-red-600 hover:text-red-700">
                  이미지 삭제
                </button>
              )}
              {removeImage && (
                <button type="button" onClick={() => setRemoveImage(false)} className="text-left text-xs text-gray-500 hover:text-gray-700">
                  삭제 취소
                </button>
              )}
              <p className="text-xs text-gray-400">이미지 파일, 5MB 이하</p>
            </div>
          </div>
        </div>

        <Input
          id="portfolio-title"
          label="제목"
          required
          maxLength={100}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="예: 쇼핑몰 리뉴얼"
        />
        <Input
          id="portfolio-role"
          label="맡은 역할"
          maxLength={100}
          value={form.role}
          onChange={(e) => setForm({ ...form, role: e.target.value })}
          placeholder="예: 프론트엔드 리드"
        />
        <div>
          <label htmlFor="portfolio-description" className="block text-sm font-medium text-gray-700 mb-1">설명</label>
          <textarea
            id="portfolio-description"
            rows={4}
            maxLength={2000}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
            placeholder="무엇을 만들었고 어떤 성과가 있었는지 적어주세요"
          />
        </div>
        <Input
          id="portfolio-url"
          label="링크"
          type="url"
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
          placeholder="https://"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            id="portfolio-startedAt"
            label="시작 월"
            type="month"
            max={maxMonth}
            value={form.startedAt}
            onChange={(e) => setForm({ ...form, startedAt: e.target.value })}
          />
          <Input
            id="portfolio-endedAt"
            label="종료 월"
            type="month"
            max={maxMonth}
            min={form.startedAt || undefined}
            value={form.endedAt}
            onChange={(e) => setForm({ ...form, endedAt: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            사용 기술 <span className="text-xs font-normal text-gray-400">(최대 10개)</span>
          </label>
          <CheckboxChips
            options={SKILL_OPTIONS}
            value={form.skills}
            onChange={(skills) => setForm({ ...form, skills: normalizeSkillList(skills) })}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>취소</Button>
          <Button type="submit" loading={saving}>{item ? '저장' : '추가'}</Button>
        </div>
      </form>
    </Modal>
  );
}
