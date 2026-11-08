// 로고 마크(W 모양 선). 장식용이라 옆의 'WorkBridge' 글자가 링크 이름이 된다.
export default function BrandMark({ className = 'h-7 w-7' }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-lg bg-primary-600 text-white shadow-sm ${className}`}
    >
      <svg viewBox="0 0 24 24" className="h-[62%] w-[62%]" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7l4 10 5-8 5 8 4-10" />
      </svg>
    </span>
  );
}
