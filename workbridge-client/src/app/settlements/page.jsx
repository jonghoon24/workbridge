'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import SettlementSummaryCard from '@/components/settlements/SettlementSummaryCard';
import SettlementTable from '@/components/settlements/SettlementTable';
import { SETTLEMENT_STATUS_LABELS } from '@/constants/milestones';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';
import { LockIcon } from '@/components/ui/Icons';

const PAGE_SIZE = 20;

export default function SettlementsPage() {
  const [forbidden, setForbidden] = useState(false);
  const [summary, setSummary] = useState(null);
  const [settlements, setSettlements] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: PAGE_SIZE, totalPages: 0 });
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    const currentUser = useAuthStore.getState().user;
    if (currentUser && currentUser.role !== 'FREELANCER') {
      setForbidden(true);
      return;
    }
    api.get('/api/settlements/summary')
      .then(({ data }) => setSummary(data))
      .catch((err) => {
        if (err.response?.status === 403) setForbidden(true);
        else setError(err.response?.data?.error?.message || '정산 요약을 불러오지 못했습니다');
      });
  }, []);

  useEffect(() => {
    const currentUser = useAuthStore.getState().user;
    if (currentUser && currentUser.role !== 'FREELANCER') {
      setLoading(false);
      return undefined;
    }

    let ignored = false;
    setLoading(true);
    const params = { page, limit: PAGE_SIZE };
    if (status) params.status = status;

    api.get('/api/settlements', { params })
      .then(({ data }) => {
        if (ignored) return;
        setSettlements(data.settlements || []);
        setMeta(data.meta || { total: 0, page, limit: PAGE_SIZE, totalPages: 0 });
      })
      .catch((err) => {
        if (ignored) return;
        if (err.response?.status === 403) setForbidden(true);
        else setError(err.response?.data?.error?.message || '정산 내역을 불러오지 못했습니다');
      })
      .finally(() => {
        if (!ignored) setLoading(false);
      });

    return () => {
      ignored = true;
    };
  }, [status, page]);

  if (forbidden) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
        <EmptyState icon={LockIcon} title="정산은 프리랜서 회원만 이용할 수 있습니다." />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900">정산</h1>
          <p className="text-gray-600 mt-1">승인된 마일스톤 대금은 수수료를 뺀 뒤 매주 지급됩니다</p>
        </div>
        <Link href="/settlements/account">
          <Button variant="secondary">지급 계좌 관리</Button>
        </Link>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-6">
          {error}
        </div>
      )}

      {summary && !summary.hasPayoutAccount && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between p-4 bg-yellow-50 border border-yellow-200 rounded-lg mb-6">
          <p className="text-sm text-yellow-800">
            지급 계좌가 등록되지 않았습니다. 계좌가 없으면 지급일에 정산이 보류됩니다.
          </p>
          <Link href="/settlements/account" className="text-sm font-medium text-yellow-900 hover:underline whitespace-nowrap">
            계좌 등록하기 →
          </Link>
        </div>
      )}

      <div className="mb-6">
        <SettlementSummaryCard summary={summary} />
      </div>

      <Card className="p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <h2 className="font-semibold text-gray-900">정산 내역</h2>
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm"
          >
            <option value="">전체 상태</option>
            {Object.entries(SETTLEMENT_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {loading ? (
          <PageLoader className="min-h-0" />
        ) : (
          <SettlementTable settlements={settlements} />
        )}

        {meta.totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 mt-6">
            <Button variant="secondary" size="sm" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
              이전
            </Button>
            <span className="text-sm text-gray-600">{meta.page} / {meta.totalPages}</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= meta.totalPages || loading}
              onClick={() => setPage(page + 1)}
            >
              다음
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
