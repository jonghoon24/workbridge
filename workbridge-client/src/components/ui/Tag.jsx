// 기술 스택 같은 키워드 태그. 상태가 아니라 속성이라 색을 빼고 회색으로 통일한다(일치한 스킬만 강조).
export default function Tag({ children, tone = 'default', size = 'sm', className = '' }) {
  const tones = {
    default: 'bg-gray-100 text-gray-700',
    match: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/15',
    muted: 'bg-gray-50 text-gray-400',
    primary: 'bg-primary-50 text-primary-700',
  };
  const sizes = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-2.5 py-1 text-sm',
  };
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-md font-medium ${tones[tone] || tones.default} ${sizes[size]} ${className}`}>
      {children}
    </span>
  );
}
