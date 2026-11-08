// 페이지 전체 로딩 표시. 기존 문구('로딩 중...')를 그대로 보여주고 스피너를 곁들인다.
export default function PageLoader({ label = '로딩 중...', className = '' }) {
  return (
    <div className={`flex min-h-[50vh] flex-col items-center justify-center gap-3 px-4 py-16 text-sm text-gray-500 ${className}`} role="status">
      <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-gray-200 border-t-primary-600" aria-hidden="true" />
      {label}
    </div>
  );
}
