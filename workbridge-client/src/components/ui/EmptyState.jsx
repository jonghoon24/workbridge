import { InboxIcon, AlertCircleIcon } from '@/components/ui/Icons';

// 빈 목록·오류·권한 없음 화면 공통. 문구는 호출하는 쪽이 그대로 넘긴다.
export default function EmptyState({ title, description, icon: Icon, tone = 'default', action, className = '' }) {
  const IconComp = Icon || (tone === 'error' ? AlertCircleIcon : InboxIcon);
  const iconWrap = tone === 'error' ? 'bg-red-50 text-red-500' : 'bg-gray-100 text-gray-400';
  return (
    <div className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white px-6 py-14 text-center ${className}`}>
      <div className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full ${iconWrap}`}>
        <IconComp className="h-6 w-6" />
      </div>
      {title && <p className="text-base font-semibold text-gray-900">{title}</p>}
      {description && <p className="mt-1.5 max-w-sm text-sm text-gray-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
