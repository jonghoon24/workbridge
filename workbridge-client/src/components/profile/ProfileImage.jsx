'use client';

// 저장소 공개 URL은 호스트가 환경마다 달라(next.config의 remotePatterns 밖일 수 있다) next/image 대신
// 일반 img를 쓴다. 이미지가 없으면 제목 첫 글자를 보여준다.
export default function ProfileImage({ src, alt, className = '', fallback }) {
  if (!src) {
    return (
      <div className={`flex items-center justify-center bg-gray-100 text-gray-400 ${className}`}>
        {fallback ?? <span className="text-2xl font-semibold">{alt?.[0]?.toUpperCase() || '?'}</span>}
      </div>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={`object-cover ${className}`} />;
}
