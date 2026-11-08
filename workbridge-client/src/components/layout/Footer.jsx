import Link from 'next/link';
import BrandMark from '@/components/ui/BrandMark';
import { ShieldCheckIcon, SparklesIcon, StarIcon } from '@/components/ui/Icons';

const PROMISES = [
  { icon: ShieldCheckIcon, text: '마일스톤 안전결제' },
  { icon: SparklesIcon, text: 'AI 단가 분석' },
  { icon: StarIcon, text: '상호 리뷰' },
];

export default function Footer() {
  return (
    <footer className="mt-auto border-t border-gray-200 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <Link href="/" className="inline-flex items-center gap-2 text-base font-bold tracking-tight text-gray-900">
              <BrandMark className="h-6 w-6" />
              <span>WorkBridge</span>
            </Link>
            <p className="mt-3 text-sm leading-6 text-gray-500">
              의뢰인과 프리랜서를 연결하는 프리랜서 매칭 플랫폼
            </p>
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
            {PROMISES.map(({ icon: Icon, text }) => (
              <li key={text} className="inline-flex items-center gap-1.5">
                <Icon className="h-4 w-4 text-gray-400" />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-8 border-t border-gray-100 pt-6 text-xs text-gray-400">
          © 2026 WorkBridge. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
