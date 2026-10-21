'use client';

// 안 읽은 메시지 수 배지. 0이면 그리지 않는다. 99를 넘으면 99+.
export default function UnreadBadge({ count, className = '' }) {
  if (!count || count <= 0) return null;
  return (
    <span
      className={`inline-flex min-w-[1.25rem] h-5 items-center justify-center rounded-full bg-primary-600 px-1.5 text-[11px] font-semibold leading-none text-white ${className}`}
      aria-label={`안 읽은 메시지 ${count}개`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
