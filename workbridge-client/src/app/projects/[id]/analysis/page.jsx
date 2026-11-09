'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import PageLoader from '@/components/ui/PageLoader';
import { toUserMessage } from '@/lib/errorMessages';

export default function AnalysisPage() {
  const { id } = useParams();
  const user = useAuthStore((state) => state.user);
  const [project, setProject] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [applyingBudget, setApplyingBudget] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get(`/api/projects/${id}`)
      .then(({ data }) => {
        setProject(data);
        if (data.pricingAnalysis) {
          setAnalysis(data.pricingAnalysis);
        }
      })
      .catch((err) => setError(toUserMessage(err, '프로젝트를 불러오지 못했습니다.')))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleAnalyze() {
    setAnalyzing(true);
    setError('');
    setSuccess('');
    try {
      const { data } = await api.post(`/api/projects/${id}/analyze`);
      setAnalysis(data);
      setProject((prev) => (prev ? { ...prev, pricingAnalysis: data } : prev));
    } catch (err) {
      setError(toUserMessage(err, 'AI 분석에 실패했습니다.'));
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleApplySuggestedBudget() {
    if (!analysis?.totalAmount) return;
    if (!confirm(`프로젝트 예산을 ${analysis.totalAmount.toLocaleString()}원으로 변경하시겠습니까?`)) {
      return;
    }

    setApplyingBudget(true);
    setError('');
    setSuccess('');
    try {
      const { data } = await api.patch(`/api/projects/${id}`, { budget: analysis.totalAmount });
      setProject((prev) => (prev ? { ...prev, ...data } : data));
      setSuccess('제안된 예산이 프로젝트 예산에 반영되었습니다.');
    } catch (err) {
      setError(toUserMessage(err, '제안된 예산 반영에 실패했습니다.'));
    } finally {
      setApplyingBudget(false);
    }
  }

  if (loading) return <PageLoader />;

  const applicationCount = project?._count?.applications || 0;
  const hasApplications = applicationCount > 0;
  const isOwner = project?.clientId === user?.id;
  const suggestedBudget = Number(analysis?.totalAmount);
  const currentBudget = Number(project?.budget);
  const hasSuggestedBudget = Number.isFinite(suggestedBudget) && suggestedBudget > 0;
  const isBudgetApplied = hasSuggestedBudget && Math.round(currentBudget) === Math.round(suggestedBudget);
  const canApplySuggestedBudget = isOwner && hasSuggestedBudget && !hasApplications && !isBudgetApplied;
  const budgetApplyMessage = (() => {
    if (!hasSuggestedBudget) return '분석 결과의 총 단가를 확인할 수 없습니다.';
    if (hasApplications) return '지원자가 있는 프로젝트는 예산을 변경할 수 없습니다.';
    if (isBudgetApplied) return '제안된 예산이 현재 프로젝트 예산과 같습니다.';
    return 'AI가 산정한 총 단가를 프로젝트 예산으로 저장할 수 있습니다.';
  })();

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900">AI 단가 분석</h1>
          <p className="text-gray-600 mt-1">{project?.title}</p>
        </div>
        <Button onClick={handleAnalyze} loading={analyzing}>
          {analysis ? '재분석' : 'AI 분석 시작'}
        </Button>
      </div>

      {analyzing && (
        <Card className="p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-[3px] border-gray-200 border-t-primary-600 mx-auto mb-4" />
          <p className="text-gray-600">AI가 분석 중입니다... (10-15초 소요)</p>
        </Card>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 mb-6">
          {error}
        </div>
      )}

      {success && (
        <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-green-700 mb-6">
          {success}
        </div>
      )}

      {analysis && !analyzing && (
        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-semibold text-gray-900">예상 총 단가</h2>
              <span className="text-3xl font-bold text-primary-600">
                {analysis.totalAmount?.toLocaleString()}원
              </span>
            </div>
            {analysis.summary && (
              <p className="text-gray-600 mt-3 text-sm">{analysis.summary}</p>
            )}

            {isOwner && (
              <div className="mt-5 flex flex-col gap-3 border-t border-gray-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    현재 프로젝트 예산: {project?.budget?.toLocaleString()}원
                  </p>
                  <p className="text-sm text-gray-500 mt-1">{budgetApplyMessage}</p>
                </div>
                <Button
                  onClick={handleApplySuggestedBudget}
                  loading={applyingBudget}
                  disabled={!canApplySuggestedBudget}
                  className="w-full sm:w-auto"
                >
                  {isBudgetApplied ? '반영 완료' : '제안된 예산 반영하기'}
                </Button>
              </div>
            )}
          </Card>

          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">단위 기능별 분석</h2>
            <div className="space-y-3">
              {(Array.isArray(analysis.features) ? analysis.features : []).map((feature, i) => (
                <Card key={i} className="p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-gray-900">{feature.name}</h3>
                      <p className="text-sm text-gray-600 mt-1">{feature.description}</p>
                      <p className="text-sm text-gray-500 mt-2">
                        <span className="font-medium">산정 근거:</span> {feature.rationale}
                      </p>
                      {feature.duration && (
                        <p className="text-sm text-gray-500">예상 기간: {feature.duration}</p>
                      )}
                    </div>
                    <div className="sm:ml-4 sm:text-right sm:shrink-0">
                      <p className="font-semibold text-gray-900">
                        {feature.estimatedCost?.toLocaleString()}원
                      </p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          {analysis.marketReference && (
            <Card className="p-6">
              <h2 className="font-semibold text-gray-900 mb-2">시장 참고 정보</h2>
              <p className="text-sm text-gray-600">{analysis.marketReference}</p>
            </Card>
          )}
        </div>
      )}

      {!analysis && !analyzing && (
        <Card className="p-12 text-center">
          <p className="text-gray-500 mb-4">아직 분석이 진행되지 않았습니다</p>
          <p className="text-sm text-gray-400">AI 분석 시작 버튼을 누르면 단가 분석이 시작됩니다</p>
        </Card>
      )}
    </div>
  );
}
