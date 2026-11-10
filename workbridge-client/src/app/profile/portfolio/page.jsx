'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import PortfolioGrid from '@/components/profile/PortfolioGrid';
import PortfolioItemModal from '@/components/profile/PortfolioItemModal';
import { describeProfileError } from '@/components/profile/profileFormat';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';
import { LockIcon } from '@/components/ui/Icons';

const MAX_ITEMS = 20;

// 포트폴리오 관리. 목록은 공개 GET을 내 id로 읽는다.
export default function PortfolioManagePage() {
  const [me, setMe] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState({ open: false, item: null });

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get('/api/users/me')
      .then(async ({ data }) => {
        setMe(data);
        if (data.role !== 'FREELANCER') return;
        const { data: list } = await api.get(`/api/users/${data.id}/portfolio`);
        setItems(list.items);
      })
      .catch((err) => setError(describeProfileError(err, '포트폴리오를 불러오지 못했습니다.')))
      .finally(() => setLoading(false));
  }, []);

  async function reload() {
    const { data } = await api.get(`/api/users/${me.id}/portfolio`);
    setItems(data.items);
  }

  // 위/아래 버튼: 화면을 먼저 바꾸고 서버 순서로 맞춘다. 실패하면 서버 상태를 다시 읽는다.
  async function handleMove(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
    setBusy(true);
    setError('');
    try {
      const { data } = await api.put('/api/users/me/portfolio/order', { ids: next.map((item) => item.id) });
      setItems(data.items);
    } catch (err) {
      setError(describeProfileError(err, '순서를 저장하지 못했습니다.'));
      await reload().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(item) {
    if (!confirm(`'${item.title}' 포트폴리오를 삭제하시겠습니까? 삭제하면 되돌릴 수 없습니다.`)) return;
    setBusy(true);
    setError('');
    try {
      await api.delete(`/api/users/me/portfolio/${item.id}`);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch (err) {
      setError(describeProfileError(err, '포트폴리오를 삭제하지 못했습니다.'));
      await reload().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function handleSaved() {
    setModal({ open: false, item: null });
    await reload().catch(() => setError('목록을 새로 불러오지 못했습니다.'));
  }

  if (loading) return <PageLoader />;

  if (me && me.role !== 'FREELANCER') {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
        <EmptyState icon={LockIcon} title="포트폴리오는 프리랜서 회원만 등록할 수 있습니다." />
      </div>
    );
  }

  const full = items.length >= MAX_ITEMS;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <nav className="text-sm text-gray-500 mb-4">
        <Link href="/profile" className="hover:text-gray-700">내 프로필</Link>
        <span className="mx-2">/</span>
        <span>포트폴리오</span>
      </nav>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900">포트폴리오 관리</h1>
          <p className="text-gray-600 mt-1 text-sm">
            {items.length} / {MAX_ITEMS}개 · 순서는 공개 프로필과 추천 미리보기에 그대로 보입니다
          </p>
        </div>
        <div className="flex gap-2">
          {me && (
            <Link href={`/users/${me.id}`}>
              <Button variant="secondary">공개 프로필 보기</Button>
            </Link>
          )}
          <Button onClick={() => setModal({ open: true, item: null })} disabled={full || busy}>
            포트폴리오 추가
          </Button>
        </div>
      </div>

      {full && (
        <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 text-sm mb-4">
          포트폴리오는 최대 {MAX_ITEMS}개까지 등록할 수 있습니다. 새로 추가하려면 하나를 삭제해 주세요.
        </div>
      )}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-4">{error}</div>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="아직 등록한 포트폴리오가 없습니다."
          description="대표 작업을 3개 이상 올리면 프로필 완성도가 올라가고 추천에도 반영됩니다."
        />
      ) : (
        <PortfolioGrid
          items={items}
          editable
          busy={busy}
          onMove={handleMove}
          onEdit={(item) => setModal({ open: true, item })}
          onDelete={handleDelete}
        />
      )}

      {modal.open && (
        <PortfolioItemModal
          key={modal.item?.id ?? 'new'}
          isOpen
          item={modal.item}
          onClose={() => setModal({ open: false, item: null })}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
