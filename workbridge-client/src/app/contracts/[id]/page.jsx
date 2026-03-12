'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';

export default function ContractPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user } = useAuthStore();
  const [contract, setContract] = useState(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get(`/api/contracts/${id}`)
      .then(({ data }) => setContract(data))
      .catch(() => router.push('/'))
      .finally(() => setLoading(false));
  }, [id, router]);

  async function handleSign() {
    setSigning(true);
    try {
      const { data } = await api.post(`/api/contracts/${id}/sign`);
      setContract(data);
      if (data.status === 'ACTIVE') {
        alert('계약이 체결되었습니다!');
      }
    } catch (err) {
      alert(err.response?.data?.error?.message || '서명에 실패했습니다');
    } finally {
      setSigning(false);
    }
  }

  async function handleCompleteContract() {
    try {
      await api.patch(`/api/projects/${contract.projectId}/status`, { status: 'COMPLETED' });
      await api.patch(`/api/contracts/${id}`, { status: 'COMPLETED' });
      const { data } = await api.get(`/api/contracts/${id}`);
      setContract(data);
      alert('프로젝트가 완료되었습니다!');
    } catch (err) {
      alert(err.response?.data?.error?.message || '처리에 실패했습니다');
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-8 text-center">로딩 중...</div>;
  if (!contract) return null;

  const currentUser = useAuthStore.getState().user;
  const isClient = currentUser?.id === contract.clientId;
  const isFreelancer = currentUser?.id === contract.freelancerId;
  const hasSigned = isClient ? contract.clientSigned : contract.freelancerSigned;
  const canSign = (isClient || isFreelancer) && !hasSigned;
  const canPay = isClient && contract.status === 'ACTIVE' && !contract.payment;
  const canComplete = isClient && contract.status === 'ACTIVE' && contract.payment?.status === 'COMPLETED';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">계약서</h1>
        <Badge variant={contract.status}>{
          contract.status === 'PENDING' ? '서명 대기' :
          contract.status === 'ACTIVE' ? '계약 진행 중' : '완료'
        }</Badge>
      </div>

      <div className="space-y-4">
        <Card className="p-6">
          <h2 className="font-semibold text-gray-900 mb-4">계약 정보</h2>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-gray-500">프로젝트</dt>
              <dd className="font-medium mt-1">
                <Link href={`/projects/${contract.projectId}`} className="text-primary-600 hover:text-primary-700">
                  {contract.project?.title}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">계약 금액</dt>
              <dd className="font-medium mt-1">{contract.amount?.toLocaleString()}원</dd>
            </div>
            <div>
              <dt className="text-gray-500">의뢰인</dt>
              <dd className="font-medium mt-1">{contract.client?.name}</dd>
            </div>
            <div>
              <dt className="text-gray-500">프리랜서</dt>
              <dd className="font-medium mt-1">{contract.freelancer?.name}</dd>
            </div>
            <div>
              <dt className="text-gray-500">시작일</dt>
              <dd className="font-medium mt-1">{new Date(contract.startDate).toLocaleDateString('ko-KR')}</dd>
            </div>
            <div>
              <dt className="text-gray-500">종료일</dt>
              <dd className="font-medium mt-1">{new Date(contract.endDate).toLocaleDateString('ko-KR')}</dd>
            </div>
          </dl>
        </Card>

        <Card className="p-6">
          <h2 className="font-semibold text-gray-900 mb-4">서명 현황</h2>
          <div className="flex gap-6">
            <div className={`flex items-center gap-2 ${contract.clientSigned ? 'text-green-600' : 'text-gray-400'}`}>
              <span>{contract.clientSigned ? '✓' : '○'}</span>
              <span className="text-sm font-medium">의뢰인 서명 {contract.clientSigned ? '완료' : '대기'}</span>
            </div>
            <div className={`flex items-center gap-2 ${contract.freelancerSigned ? 'text-green-600' : 'text-gray-400'}`}>
              <span>{contract.freelancerSigned ? '✓' : '○'}</span>
              <span className="text-sm font-medium">프리랜서 서명 {contract.freelancerSigned ? '완료' : '대기'}</span>
            </div>
          </div>
        </Card>

        {contract.payment && (
          <Card className="p-6">
            <h2 className="font-semibold text-gray-900 mb-2">결제 현황</h2>
            <div className="flex items-center gap-3">
              <Badge variant={contract.payment.status}>{contract.payment.status}</Badge>
              <span className="font-medium">{contract.payment.amount?.toLocaleString()}원</span>
            </div>
          </Card>
        )}

        <div className="flex gap-3 justify-end">
          {canSign && (
            <Button onClick={handleSign} loading={signing}>
              계약서 서명하기
            </Button>
          )}
          {canPay && (
            <Link href={`/payments/${contract.id}`}>
              <Button>결제하기</Button>
            </Link>
          )}
          {canComplete && (
            <Button onClick={handleCompleteContract} variant="secondary">
              프로젝트 완료 처리
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
