import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';

export const metadata = {
  title: '페이지를 찾을 수 없습니다 - WorkBridge',
};

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-24 text-center sm:py-32">
      <p className="text-sm font-semibold text-primary-600">404</p>
      <h1 className="mt-3 text-2xl font-bold text-gray-900 sm:text-3xl">페이지를 찾을 수 없습니다</h1>
      <p className="mt-3 text-gray-500">
        주소가 바뀌었거나 삭제된 페이지일 수 있어요. 입력한 주소를 다시 확인해주세요.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link href="/" className={buttonClasses({ variant: 'primary', size: 'lg' })}>
          홈으로 가기
        </Link>
        <Link href="/projects" className={buttonClasses({ variant: 'secondary', size: 'lg' })}>
          프로젝트 둘러보기
        </Link>
      </div>
    </div>
  );
}
