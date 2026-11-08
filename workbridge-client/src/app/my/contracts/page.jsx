'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { formatDate, formatKRW } from '@/lib/format';
import { CONTRACT_STATUS_LABELS } from '@/constants/milestones';
import UnreadBadge from '@/components/messages/UnreadBadge';
import EmptyState from '@/components/ui/EmptyState';
import { FileTextIcon } from '@/components/ui/Icons';
import PageLoader from '@/components/ui/PageLoader';

const TABS = [
  { value: '', label: '전체' },
  { value: 'PENDING', label: '서명 대기' },
  { value: 'ACTIVE', label: '진행 중' },
  { value: 'COMPLETED', label: '완료' },
];

const PAGE_SIZE = 10;

export default function MyContractsPage() {
  const router = useRouter();
  const [openingChat, setOpeningChat] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [contracts, setContracts] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: PAGE_SIZE, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
  }, []);

  useEffect(() => {
    let ignored = false;
    setLoading(true);
    setError('');

    const params = { page, limit: PAGE_SIZE };
    if (status) params.status = status;

    api.get('/api/contracts', { params })
      .then(({ data }) => {
        if (ignored) return;
        setContracts(data.contracts || []);
        setMeta(data.meta || { total: 0, page, limit: PAGE_SIZE, totalPages: 0 });
      })
      .catch((err) => {
        if (!ignored) setError(err.response?.data?.error?.message || '계약 목록을 불러오지 못했습니다');
      })
      .finally(() => {
        if (!ignored) setLoading(false);
      });

    return () => {
      ignored = true;
    };
  }, [status, page]);

  // 목록에는 대화방 id가 없으므로(MG19는 수만 준다) 계약의 대화방을 찾아서 연다(MG18).
  async function openConversation(contractId) {
    setOpeningChat(contractId);
    try {
      const { data } = await api.get(`/api/contracts/${contractId}/conversation`);
      router.push(`/messages/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error?.message === 'Conversation not found'
        ? '이 계약에는 대화방이 없습니다.'
        : '대화방을 열지 못했습니다.');
      setOpeningChat('');
    }
  }

  function changeTab(value) {
    setStatus(value);
    setPage(1);
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">내 계약</h1>
        <p className="text-gray-600 mt-1">계약별 마일스톤 진행 상황을 확인하세요</p>
      </div>

      <div className="flex gap-1 border-b border-gray-200 mb-6 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.value || 'all'}
            type="button"
            onClick={() => changeTab(tab.value)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${
              status === tab.value
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-6">
          {error}
        </div>
      )}

      {loading ? (
        <PageLoader className="min-h-[30vh]" />
      ) : !error && contracts.length === 0 ? (
        <EmptyState icon={FileTextIcon} title={status ? '해당 상태의 계약이 없습니다' : '아직 계약이 없습니다'} />
      ) : (
        <div className="space-y-4">
          {contracts.map((contract) => {
            const summary = contract.milestoneSummary || {};
            const contractAmount = summary.contractAmount ?? Math.round(contract.amount || 0);
            const percent = contractAmount > 0
              ? Math.min(100, Math.round(((summary.approvedAmount || 0) / contractAmount) * 100))
              : 0;

            return (
              <Card key={contract.id} className="p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <Link
                        href={`/contracts/${contract.id}`}
                        className="font-semibold text-gray-900 hover:text-primary-600"
                      >
                        {contract.project?.title}
                      </Link>
                      <Badge variant={contract.status}>
                        {CONTRACT_STATUS_LABELS[contract.status] || contract.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-gray-500">
                      {contract.myRole === 'CLIENT' ? '프리랜서' : '의뢰인'} {contract.counterpart?.name || '-'}
                      {' · '}
                      {formatDate(contract.startDate)} ~ {formatDate(contract.endDate)}
                    </p>
                    {contract.status === 'PENDING' && (
                      <p className="text-xs text-gray-500 mt-1">
                        의뢰인 서명 {contract.clientSigned ? '완료' : '대기'} · 프리랜서 서명 {contract.freelancerSigned ? '완료' : '대기'}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 sm:flex-col sm:items-end">
                    <p className="font-semibold text-gray-900 sm:text-right">{formatKRW(contractAmount)}</p>
                    <button
                      type="button"
                      onClick={() => openConversation(contract.id)}
                      disabled={openingChat === contract.id}
                      className="inline-flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 disabled:opacity-50"
                    >
                      {contract.unreadMessageCount > 0 ? '새 메시지' : '대화'}
                      <UnreadBadge count={contract.unreadMessageCount} />
                    </button>
                  </div>
                </div>

                <div className="mt-4">
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>
                      마일스톤 승인 {summary.approvedCount || 0}/{summary.count || 0}
                    </span>
                    <span>{formatKRW(summary.approvedAmount || 0)} ({percent}%)</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full bg-primary-600" style={{ width: `${percent}%` }} />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {meta.totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-8">
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
    </div>
  );
}
