'use client';

const variants = {
  UPCOMING: 'bg-purple-100 text-purple-800',
  OPEN: 'bg-green-100 text-green-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-gray-100 text-gray-800',
  CANCELLED: 'bg-red-100 text-red-800',
  CLOSED: 'bg-yellow-100 text-yellow-800',
  PENDING: 'bg-yellow-100 text-yellow-800',
  ACCEPTED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  default: 'bg-gray-100 text-gray-700',
};

const statusLabels = {
  UPCOMING: '모집예정',
  OPEN: '모집중',
  IN_PROGRESS: '진행중',
  COMPLETED: '완료',
  CANCELLED: '취소',
  CLOSED: '모집마감',
  PENDING: '검토중',
  ACCEPTED: '수락됨',
  REJECTED: '거절됨',
};

export default function Badge({ children, variant = 'default', className = '' }) {
  const colorClass = variants[variant] || variants.default;
  const label = statusLabels[children] || children;

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colorClass} ${className}`}>
      {label}
    </span>
  );
}
