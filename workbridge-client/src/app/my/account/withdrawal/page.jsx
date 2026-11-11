'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import authApi from '@/lib/authApi';
import useAuthStore from '@/store/authStore';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import EmptyState from '@/components/ui/EmptyState';
import Input from '@/components/ui/Input';
import PageLoader from '@/components/ui/PageLoader';
import { AlertCircleIcon, GoogleIcon } from '@/components/ui/Icons';
import { toUserMessage } from '@/lib/errorMessages';

// 탈퇴를 막는 항목(GET /api/users/me/withdrawal의 blockers)마다 보여 줄 문장과 갈 곳.
const BLOCKER_LINES = [
  {
    key: 'unfinishedContracts',
    text: (n) => `진행 중이거나 서명 전인 계약이 ${n}건 있습니다.`,
    help: '계약이 끝나야 탈퇴할 수 있습니다. 서명 전 계약을 취소하려면 고객센터로 문의해 주세요.',
    href: '/my/contracts',
    linkText: '내 계약 보기',
  },
  {
    key: 'unsettledEarnings',
    text: (n) => `아직 정산되지 않은 금액이 ${n}건 있습니다.`,
    help: '승인된 금액은 매주 정산되어 지급됩니다.',
    href: '/settlements',
    linkText: '정산 보기',
  },
  {
    key: 'unpaidSettlements',
    text: (n) => `지급되지 않은 정산이 ${n}건 있습니다.`,
    help: '지급이 끝나야 탈퇴할 수 있습니다. 지급 실패나 지연이 계속되면 고객센터로 문의해 주세요.',
    href: '/settlements',
    linkText: '정산 보기',
  },
  {
    key: 'heldSettlements',
    text: (n) => `지급 계좌가 없어 보류된 정산이 ${n}건 있습니다.`,
    help: '지급 계좌를 등록하면 다음 지급일에 지급됩니다.',
    href: '/settlements/account',
    linkText: '지급 계좌 등록',
  },
];

// Google 재인증이 탈퇴 화면으로 돌려보낼 때의 `?reauthError=<코드>` 문구(docs/domain/accounts.md "Google 재인증").
// `unavailable`은 서버가 Google 로그인 시각을 반드시 요구하도록 설정됐을 때만 온다.
const REAUTH_ERRORS = {
  cancelled: 'Google 확인을 취소했습니다. 탈퇴하려면 다시 확인해 주세요.',
  stale: 'Google에 로그인한 지 오래되어 본인 확인에 쓸 수 없습니다. 이 브라우저에서 Google 계정을 로그아웃한 뒤 다시 확인해 주세요. Google에서 로그아웃하면 이 브라우저의 모든 Google 계정이 함께 로그아웃됩니다.',
  account_mismatch: '이 계정에 연결된 Google 계정으로 로그인해 주세요.',
  unavailable: '지금은 Google로 본인을 확인할 수 없습니다. 고객센터로 문의해 주세요.',
  failed: 'Google 확인에 실패했습니다. 다시 시도해 주세요.',
};

// 재인증 증명(JWT)의 사용자 id. 서명은 확인하지 않는다 — 다른 계정으로 확인한 것을 바로 알려 주는 표시용이고,
// 실제 검사는 서버가 탈퇴할 때 한다.
function proofSubject(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).sub ?? null;
  } catch {
    return null;
  }
}

// 돌아온 주소에서 재인증 결과(`#reauthToken=` 또는 `?reauthError=`)를 꺼내고 주소에서 지운다. 증명이 기록이나
// 공유된 주소에 남지 않게 하고, 새로고침해도 같은 오류가 다시 뜨지 않게 한다.
function takeReauthResult() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('reauthToken');
  const code = new URLSearchParams(window.location.search).get('reauthError');
  if (token || code) window.history.replaceState(null, '', window.location.pathname);
  return { token, code };
}

// 탈퇴 전에 읽게 하는 안내. 서버가 실제로 하는 일과 같아야 한다(docs/domain/accounts.md "회원 탈퇴").
function notices(role) {
  return [
    '탈퇴하면 프로필, 포트폴리오, 경력, 지급 계좌, 북마크, 알림이 바로 삭제되며 복구할 수 없습니다.',
    role === 'CLIENT'
      ? '계약이 없는 내 프로젝트는 삭제되고, 대기 중인 지원은 모집 마감으로 처리됩니다.'
      : '결과가 나지 않은 지원은 취소됩니다.',
    '작성한 리뷰와 주고받은 메시지는 삭제되지 않으며 ‘탈퇴한 회원’으로 표시됩니다.',
    '계약·결제·정산 기록은 관련 법령(전자상거래법)에 따라 5년간 보관한 뒤 파기합니다.',
    '같은 이메일로 다시 가입할 수 있지만 이전 계정의 활동 내역은 이어지지 않습니다.',
  ];
}

export default function WithdrawalPage() {
  const router = useRouter();
  const [status, setStatus] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [password, setPassword] = useState('');
  // Google 전용 계정이 방금 Google로 다시 로그인했다는 증명. 메모리에만 둔다(새로고침하면 다시 확인).
  const [reauthToken, setReauthToken] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => api.get('/api/users/me/withdrawal')
    .then(({ data }) => setStatus(data)), []);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    const me = useAuthStore.getState().user;
    setRole(me?.role ?? null);

    const { token, code } = takeReauthResult();
    if (code) {
      setError(REAUTH_ERRORS[code] ?? REAUTH_ERRORS.failed);
    } else if (token) {
      if (me && proofSubject(token) !== me.id) setError(REAUTH_ERRORS.account_mismatch);
      else setReauthToken(token);
    }
    load()
      .catch((err) => {
        if (err.response?.status === 401) {
          router.push('/login?redirect=/my/account/withdrawal');
          return;
        }
        setLoadError(toUserMessage(err, '탈퇴 가능 여부를 불러오지 못했습니다.'));
      })
      .finally(() => setLoading(false));
  }, [load, router]);

  async function handleWithdraw(e) {
    e.preventDefault();
    setError('');
    if (!agreed) {
      setError('안내 사항에 동의해 주세요.');
      return;
    }
    if (status.hasPassword && !password) {
      setError('현재 비밀번호를 입력해 주세요.');
      return;
    }
    if (!status.hasPassword && !reauthToken) {
      setError('Google로 다시 로그인해 확인해 주세요.');
      return;
    }
    if (!confirm('정말 탈퇴하시겠습니까? 탈퇴하면 되돌릴 수 없습니다.')) return;

    setSubmitting(true);
    try {
      await api.post(
        '/api/users/me/withdrawal',
        status.hasPassword ? { currentPassword: password } : { reauthToken },
      );
    } catch (err) {
      setSubmitting(false);
      // 만료됐거나 맞지 않는 증명은 다시 쓸 수 없으니 버리고 다시 확인하게 한다.
      if (!status.hasPassword && err.response?.status === 400) setReauthToken(null);
      // 화면을 연 뒤에 상태가 바뀌었으면(새 계약 등) 사유를 다시 보여 준다.
      if (err.response?.status === 409) await load().catch(() => {});
      setError(toUserMessage(err, '탈퇴하지 못했습니다.'));
      return;
    }
    // 서버는 리프레시 쿠키를 건드리지 않으므로 로그아웃으로 지운다.
    try {
      await authApi.post('/api/auth/logout');
    } catch {}
    useAuthStore.getState().clearAuth();
    alert('탈퇴가 완료되었습니다. 그동안 WorkBridge를 이용해 주셔서 감사합니다.');
    router.replace('/');
  }

  if (loading) return <PageLoader />;

  if (loadError) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <EmptyState tone="error" title={loadError} description="잠시 후 새로고침해 주세요." />
      </div>
    );
  }

  const blockers = BLOCKER_LINES.filter(({ key }) => status.blockers[key] > 0);

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <Link href="/my/account" className="text-sm text-gray-500 hover:text-gray-700">
          ← 계정 설정
        </Link>
      </div>
      <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 mb-6">회원 탈퇴</h1>

      <div className="space-y-6">
        {!status.canWithdraw && (
          <Card className="p-6 border-amber-200 bg-amber-50/60">
            <div className="flex items-start gap-3">
              <AlertCircleIcon className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
              <div className="min-w-0">
                <h2 className="font-semibold text-gray-900">지금은 탈퇴할 수 없습니다</h2>
                <ul className="mt-3 space-y-3 text-sm">
                  {blockers.map(({ key, text, help, href, linkText }) => (
                    <li key={key}>
                      <p className="font-medium text-gray-900">{text(status.blockers[key])}</p>
                      <p className="mt-0.5 text-gray-600">
                        {help}{' '}
                        <Link href={href} className="font-medium text-primary-700 hover:text-primary-800">
                          {linkText}
                        </Link>
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>
        )}

        <Card className="p-6">
          <h2 className="text-lg font-semibold text-gray-900">탈퇴하기 전에 확인해 주세요</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-gray-700">
            {notices(role).map((line) => <li key={line}>{line}</li>)}
          </ul>

          {error && (
            <div className="mt-5 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
          )}

          <form onSubmit={handleWithdraw} noValidate className="mt-5 space-y-4">
            {!status.hasPassword && (
              <GoogleReauth confirmed={Boolean(reauthToken)} disabled={!status.canWithdraw} />
            )}
            <label className="flex items-start gap-2 text-sm text-gray-800">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                disabled={!status.canWithdraw}
              />
              안내 사항을 모두 확인했으며 탈퇴에 동의합니다.
            </label>
            {status.hasPassword && (
              <Input
                id="withdrawalPassword"
                label="현재 비밀번호"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={!status.canWithdraw}
              />
            )}
            <div className="flex justify-end">
              <Button type="submit" variant="danger" loading={submitting} disabled={!status.canWithdraw}>
                회원 탈퇴
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}

// Google로만 가입한 계정의 본인 확인. 확인은 Google을 다녀오는 페이지 이동이라, 탈퇴 동의보다 먼저 둔다.
function GoogleReauth({ confirmed, disabled }) {
  function handleReauth() {
    window.location.href = '/api/auth/google/reauth?purpose=withdrawal';
  }

  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <p className="text-sm font-medium text-gray-900">Google 계정 확인</p>
      <p className="mt-1 text-sm text-gray-600">
        Google로 가입한 계정은 탈퇴하기 전에 Google 로그인을 한 번 더 확인합니다.
      </p>
      {confirmed ? (
        <p className="mt-3 text-sm text-green-700">
          Google 계정을 확인했습니다. 몇 분 안에 탈퇴를 마치지 않으면 다시 확인해야 합니다.
        </p>
      ) : (
        <button
          type="button"
          onClick={handleReauth}
          disabled={disabled}
          className="mt-3 w-full h-11 flex items-center justify-center gap-3 px-4 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <GoogleIcon />
          Google로 다시 로그인
        </button>
      )}
    </div>
  );
}
