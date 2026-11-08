'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { BANKS } from '@/constants/banks';
import { formatDateTime } from '@/lib/format';
import { describeServerError } from '@/lib/serverErrors';
import PageLoader from '@/components/ui/PageLoader';
import EmptyState from '@/components/ui/EmptyState';
import { LockIcon } from '@/components/ui/Icons';

const EMPTY_FORM = { bankCode: '', accountNumber: '', holderName: '' };

// 예측 가능한 서버 오류(BEHAVIOR.md PA3, PA5)는 한국어로 바꿔 보여준다. 나머지는 서버 문구 그대로다.
const SERVER_ERROR_MESSAGES = {
  'Account holder must match your name': '예금주가 회원 이름과 같아야 합니다. 본인 명의 계좌만 등록할 수 있습니다.',
  'Payout account cannot be changed while a payout is processing': '지급이 처리되는 중에는 계좌를 바꾸거나 삭제할 수 없습니다. 잠시 후 다시 시도해주세요.',
};

// 지급 계좌(BEHAVIOR.md PA1–PA7). 응답에는 마스킹된 번호만 오므로 변경할 때는 번호를 새로 입력한다.
export default function PayoutAccountPage() {
  const { user } = useAuthStore();
  const [forbidden, setForbidden] = useState(false);
  const [account, setAccount] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    useAuthStore.getState().initAuth();
    const currentUser = useAuthStore.getState().user;
    if (currentUser && currentUser.role !== 'FREELANCER') {
      setForbidden(true);
      setLoading(false);
      return;
    }
    api.get('/api/users/me/payout-account')
      .then(({ data }) => {
        setAccount(data.payoutAccount);
        setEditing(!data.payoutAccount);
        setForm({ ...EMPTY_FORM, holderName: currentUser?.name || '' });
      })
      .catch((err) => {
        if (err.response?.status === 403) setForbidden(true);
        else setError(err.response?.data?.error?.message || '지급 계좌를 불러오지 못했습니다');
      })
      .finally(() => setLoading(false));
  }, []);

  function startEditing() {
    setForm({
      bankCode: account?.bankCode || '',
      accountNumber: '',
      holderName: account?.holderName || useAuthStore.getState().user?.name || '',
    });
    setError('');
    setSuccess('');
    setEditing(true);
  }

  function validate() {
    if (!BANKS.some((bank) => bank.code === form.bankCode)) return '은행을 선택해주세요.';
    const digits = form.accountNumber.replace(/[-\s]/g, '');
    if (!/^\d{10,14}$/.test(digits)) return '계좌번호는 하이픈을 빼고 10~14자리 숫자여야 합니다.';
    if (!form.holderName.trim()) return '예금주를 입력해주세요.';
    return '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data } = await api.put('/api/users/me/payout-account', {
        bankCode: form.bankCode,
        accountNumber: form.accountNumber,
        holderName: form.holderName.trim(),
      });
      setAccount(data.payoutAccount);
      setEditing(false);
      setSuccess(data.rescheduledCount > 0
        ? `지급 계좌를 저장했습니다. 보류된 정산 ${data.rescheduledCount}건이 다음 지급일에 다시 지급됩니다.`
        : '지급 계좌를 저장했습니다.');
    } catch (err) {
      setError(describeServerError(err, '지급 계좌 저장에 실패했습니다', { messages: SERVER_ERROR_MESSAGES }));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm('지급 계좌를 삭제할까요? 계좌가 없으면 지급일에 정산이 보류됩니다.')) return;

    setDeleting(true);
    setError('');
    setSuccess('');
    try {
      await api.delete('/api/users/me/payout-account');
      setAccount(null);
      setForm({ ...EMPTY_FORM, holderName: useAuthStore.getState().user?.name || '' });
      setEditing(true);
      setSuccess('지급 계좌를 삭제했습니다.');
    } catch (err) {
      setError(describeServerError(err, '지급 계좌 삭제에 실패했습니다', { messages: SERVER_ERROR_MESSAGES }));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <PageLoader />;

  if (forbidden) {
    return (
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-12">
        <EmptyState icon={LockIcon} title="지급 계좌는 프리랜서 회원만 등록할 수 있습니다." />
      </div>
    );
  }

  const memberName = user?.name || useAuthStore.getState().user?.name;

  return (
    <div className="max-w-xl mx-auto px-4 sm:px-6 py-8">
      <nav className="text-sm text-gray-500 mb-4">
        <Link href="/settlements" className="hover:text-gray-700">정산</Link>
        <span className="mx-2">/</span>
        <span>지급 계좌</span>
      </nav>
      <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 mb-6">지급 계좌</h1>

      {success && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm mb-4">
          {success}
        </div>
      )}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-4">
          {error}
        </div>
      )}

      {account && !editing && (
        <Card className="p-6">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">은행</dt>
              <dd className="font-medium">{account.bankName}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">계좌번호</dt>
              <dd className="font-medium font-mono">{account.accountNumberMasked}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">예금주</dt>
              <dd className="font-medium">{account.holderName}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">최근 변경</dt>
              <dd className="text-gray-600">{formatDateTime(account.updatedAt)}</dd>
            </div>
          </dl>
          <div className="flex justify-end gap-2 mt-6">
            <Button variant="ghost" onClick={handleDelete} loading={deleting} className="text-red-600">
              삭제
            </Button>
            <Button variant="secondary" onClick={startEditing}>변경</Button>
          </div>
        </Card>
      )}

      {editing && (
        <Card className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="bankCode" className="block text-sm font-medium text-gray-700 mb-1">
                은행<span className="text-red-500 ml-1">*</span>
              </label>
              <select
                id="bankCode"
                value={form.bankCode}
                onChange={(e) => setForm({ ...form, bankCode: e.target.value })}
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
              >
                <option value="">은행 선택</option>
                {BANKS.map((bank) => (
                  <option key={bank.code} value={bank.code}>{bank.name}</option>
                ))}
              </select>
            </div>
            <Input
              id="accountNumber"
              label="계좌번호"
              required
              inputMode="numeric"
              value={form.accountNumber}
              onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
              placeholder="하이픈 없이 입력 (10~14자리)"
              autoComplete="off"
            />
            <Input
              id="holderName"
              label="예금주"
              required
              value={form.holderName}
              onChange={(e) => setForm({ ...form, holderName: e.target.value })}
              helpText={`본인 명의 계좌만 등록할 수 있습니다. 예금주는 회원 이름${memberName ? `(${memberName})` : ''}과 같아야 합니다.`}
            />
            <p className="text-xs text-gray-500">
              지급 처리 중인 정산이 있는 동안에는 계좌를 바꾸거나 삭제할 수 없습니다.
            </p>
            <div className="flex justify-end gap-2">
              {account && (
                <Button variant="secondary" onClick={() => { setEditing(false); setError(''); }} disabled={saving}>
                  취소
                </Button>
              )}
              <Button type="submit" loading={saving}>저장</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
