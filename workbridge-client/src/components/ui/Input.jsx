'use client';

// 입력 칸 테두리. 오류일 때와 아닐 때 중 한쪽 색만 붙인다 — 둘 다 붙이면 @tailwindcss/forms의
// type별 스타일과 겹쳐 회색이 이기는 경우가 있다. textarea·select도 이 함수를 쓴다.
export function fieldBorder(error) {
  return error
    ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
    : 'border-gray-300 focus:border-primary-500 focus:ring-primary-500';
}

export default function Input({
  label,
  error,
  helpText,
  required = false,
  className = '',
  id,
  ...props
}) {
  const inputId = id || label?.toLowerCase().replace(/\s/g, '-');

  return (
    <div className={className}>
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 mb-1.5">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={`block w-full rounded-lg shadow-sm text-sm h-10 ${fieldBorder(error)} ${
          props.disabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''
        }`}
        {...props}
      />
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      {helpText && !error && <p className="mt-1 text-sm text-gray-500">{helpText}</p>}
    </div>
  );
}
