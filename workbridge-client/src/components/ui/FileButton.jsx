'use client';

import { useId } from 'react';
import { buttonClasses } from '@/components/ui/Button';
import { PaperclipIcon } from '@/components/ui/Icons';

// 브라우저 기본 파일 입력(Choose File / No file chosen) 대신 쓰는 버튼. 실제 input은 숨기고
// label이 그 input을 연다. 선택한 파일 이름은 fileName으로 넘기면 버튼 옆에 보여 준다.
export default function FileButton({
  id,
  label = '파일 선택',
  accept,
  multiple = false,
  onChange,
  fileName,
  placeholder = '선택한 파일이 없습니다',
  disabled = false,
  inputKey,
}) {
  const generatedId = useId();
  const inputId = id || generatedId;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <label
        htmlFor={inputId}
        className={`${buttonClasses({ variant: 'secondary', size: 'sm' })} ${disabled ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}
      >
        <PaperclipIcon className="h-4 w-4" />
        {label}
      </label>
      <input
        key={inputKey}
        id={inputId}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={onChange}
        disabled={disabled}
        className="sr-only"
      />
      {fileName !== undefined && (
        <span className={`min-w-0 truncate text-sm ${fileName ? 'text-gray-700' : 'text-gray-400'}`}>
          {fileName || placeholder}
        </span>
      )}
    </div>
  );
}
