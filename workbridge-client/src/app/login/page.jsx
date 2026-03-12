import { Suspense } from 'react';
import Card from '@/components/ui/Card';
import LoginForm from '@/components/auth/LoginForm';

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center py-12 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">로그인</h1>
          <p className="text-gray-600 mt-2">WorkBridge에 로그인하세요</p>
        </div>
        <Card className="p-8">
          <Suspense fallback={<div>로딩 중...</div>}>
            <LoginForm />
          </Suspense>
        </Card>
      </div>
    </div>
  );
}
