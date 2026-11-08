'use client';

export default function Card({ children, className = '', ...props }) {
  return (
    <div className={`bg-white rounded-xl border border-gray-200/80 shadow-card ${className}`} {...props}>
      {children}
    </div>
  );
}
