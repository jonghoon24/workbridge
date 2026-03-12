'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';

export default function AnalysisPage() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    api.get(`/api/projects/${id}`)
      .then(({ data }) => {
        setProject(data);
        if (data.pricingAnalysis) {
          setAnalysis(data.pricingAnalysis);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  async function handleAnalyze() {
    setAnalyzing(true);
    setError('');
    try {
      const { data } = await api.post(`/api/projects/${id}/analyze`);
      setAnalysis(data);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'AI 분석에 실패했습니다');
    } finally {
      setAnalyzing(false);
    }
  }

  if (loading) return <div className="max-w-4xl mx-auto px-4 py-8 text-center">로딩 중...</div>;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI 단가 분석</h1>
          <p className="text-gray-600 mt-1">{project?.title}</p>
        </div>
        <Button onClick={handleAnalyze} loading={analyzing}>
          {analysis ? '재분석' : 'AI 분석 시작'}
        </Button>
      </div>

      {analyzing && (
        <Card className="p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4" />
          <p className="text-gray-600">AI가 분석 중입니다... (10-15초 소요)</p>
        </Card>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 mb-6">
          {error}
        </div>
      )}

      {analysis && !analyzing && (
        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-gray-900">예상 총 단가</h2>
              <span className="text-3xl font-bold text-primary-600">
                {analysis.totalAmount?.toLocaleString()}원
              </span>
            </div>
            {analysis.summary && (
              <p className="text-gray-600 mt-3 text-sm">{analysis.summary}</p>
            )}
          </Card>

          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">단위 기능별 분석</h2>
            <div className="space-y-3">
              {(Array.isArray(analysis.features) ? analysis.features : []).map((feature, i) => (
                <Card key={i} className="p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="font-medium text-gray-900">{feature.name}</h3>
                      <p className="text-sm text-gray-600 mt-1">{feature.description}</p>
                      <p className="text-sm text-gray-500 mt-2">
                        <span className="font-medium">산정 근거:</span> {feature.rationale}
                      </p>
                      {feature.duration && (
                        <p className="text-sm text-gray-500">예상 기간: {feature.duration}</p>
                      )}
                    </div>
                    <div className="ml-4 text-right">
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
          <p className="text-sm text-gray-400">AI 분석 시작 버튼을 클릭하면 단가 분석이 시작됩니다</p>
        </Card>
      )}
    </div>
  );
}
