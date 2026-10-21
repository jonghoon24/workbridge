// 금액·날짜 표시 헬퍼. 마일스톤 기한과 정산 주기는 서버가 KST(UTC+9 고정)로 계산하므로
// 화면도 브라우저 시간대와 상관없이 Asia/Seoul로 보여준다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TIME_ZONE = 'Asia/Seoul';

export function formatKRW(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return `${Math.round(Number(value)).toLocaleString('ko-KR')}원`;
}

export function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('ko-KR', { timeZone: TIME_ZONE });
}

export function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ko-KR', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// "2일 3시간", "5시간 12분", "12분". 이미 지난 시각이면 null.
export function formatRemaining(target, now = Date.now()) {
  if (!target) return null;
  const diff = new Date(target).getTime() - now;
  if (diff <= 0) return null;

  const minutes = Math.floor(diff / 60000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;

  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  if (hours > 0) return mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;
  return `${Math.max(mins, 1)}분`;
}

// 서버의 기한(해당 KST 날짜의 23:59:59.999)을 <input type="date">용 YYYY-MM-DD로 바꾼다.
export function toKstDateInput(value) {
  if (!value) return '';
  return new Date(new Date(value).getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function kstToday() {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
