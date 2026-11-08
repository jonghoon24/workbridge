'use client';

// 안 읽은 메시지 수 배지. 0이면 그리지 않는다. 99를 넘으면 99+.
// variant: primary(목록 안) / alert(헤더 아이콘 위의 빨간 배지)
export default function UnreadBadge({ count, className = '', variant = 'primary' }) {
  if (!count || count <= 0) return null;
  const color = variant === 'alert' ? 'bg-red-500' : 'bg-primary-600';
  return (
    <span
      className={`inline-flex min-w-[1.25rem] h-5 items-center justify-center rounded-full ${color} px-1.5 text-[11px] font-semibold leading-none text-white ${className}`}
      aria-label={`안 읽은 메시지 ${count}개`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
