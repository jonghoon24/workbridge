import { Suspense } from 'react';
import Card from '@/components/ui/Card';
import BrandMark from '@/components/ui/BrandMark';
import LoginForm from '@/components/auth/LoginForm';

export default function LoginPage() {
  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center py-12 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <BrandMark className="mx-auto mb-5 h-11 w-11 rounded-xl" />
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">로그인</h1>
          <p className="text-gray-500 mt-2">WorkBridge에 로그인하세요</p>
        </div>
        <Card className="p-6 sm:p-8">
          <Suspense fallback={<div>로딩 중...</div>}>
            <LoginForm />
          </Suspense>
        </Card>
      </div>
    </div>
  );
}
