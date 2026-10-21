'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import CareerTimeline from '@/components/profile/CareerTimeline';
import CareerFormModal from '@/components/profile/CareerFormModal';
import { describeProfileError, formatCareerSummary } from '@/components/profile/profileFormat';

const MAX_CAREERS = 30;

// 경력 관리(BEHAVIOR.md PF13–PF15, PF17). 총 경력은 겹치는 기간을 한 번만 센 값이다(PF6).
export default function CareersManagePage() {
  const [me, setMe] = useState(null);
  const [careers, setCareers] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState({ open: false, career: null });

  async function load(userId) {
    const { data } = await api.get(`/api/users/${userId}/careers`);
    setCareers(data.careers);
    setSummary(data.careerSummary);
  }

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/users/me')
      .then(async ({ data }) => {
        setMe(data);
        if (data.role === 'FREELANCER') await load(data.id);
      })
      .catch((err) => setError(describeProfileError(err, '경력을 불러오지 못했습니다')))
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(career) {
    if (!confirm(`'${career.company}' 경력을 삭제할까요?`)) return;
    setBusy(true);
    setError('');
    try {
      await api.delete(`/api/users/me/careers/${career.id}`);
      await load(me.id);
    } catch (err) {
      setError(describeProfileError(err, '경력을 삭제하지 못했습니다'));
      await load(me.id).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function handleSaved() {
    setModal({ open: false, career: null });
    await load(me.id).catch(() => setError('목록을 새로 불러오지 못했습니다'));
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-8 text-center">로딩 중...</div>;

  if (me && me.role !== 'FREELANCER') {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center text-gray-600">
        경력은 프리랜서 회원만 등록할 수 있습니다.
      </div>
    );
  }

  const full = careers.length >= MAX_CAREERS;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <nav className="text-sm text-gray-500 mb-4">
        <Link href="/profile" className="hover:text-gray-700">내 프로필</Link>
        <span className="mx-2">/</span>
        <span>경력</span>
      </nav>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">경력 관리</h1>
          <p className="text-gray-600 mt-1 text-sm">
            {formatCareerSummary(summary)} · 겹치는 기간은 한 번만 셉니다
          </p>
        </div>
        <Button onClick={() => setModal({ open: true, career: null })} disabled={full || busy}>
          경력 추가
        </Button>
      </div>

      {full && (
        <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 text-sm mb-4">
          경력은 최대 {MAX_CAREERS}개까지 등록할 수 있습니다.
        </div>
      )}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-4">{error}</div>
      )}

      <Card className="p-6">
        {careers.length === 0 ? (
          <p className="text-center text-gray-500">아직 등록한 경력이 없습니다.</p>
        ) : (
          <CareerTimeline
            careers={careers}
            editable
            busy={busy}
            onEdit={(career) => setModal({ open: true, career })}
            onDelete={handleDelete}
          />
        )}
      </Card>

      <CareerFormModal
        isOpen={modal.open}
        career={modal.career}
        onClose={() => setModal({ open: false, career: null })}
        onSaved={handleSaved}
      />
    </div>
  );
}
