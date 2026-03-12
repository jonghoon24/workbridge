import Card from '@/components/ui/Card';
import SignupForm from '@/components/auth/SignupForm';

export default function SignupPage() {
  return (
    <div className="min-h-screen flex items-center justify-center py-12 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">회원가입</h1>
          <p className="text-gray-600 mt-2">WorkBridge 계정을 만드세요</p>
        </div>
        <Card className="p-8">
          <SignupForm />
        </Card>
      </div>
    </div>
  );
}
