// 페이지가 클라이언트 컴포넌트라 metadata를 내보낼 수 없어서 탭 제목을 여기서 정한다.
// 중첩 레이아웃이 문자열 title을 정하면 상위의 '%s | WorkBridge' 템플릿이 손자 경로까지 내려가지 않으므로
// 경로마다 전체 제목을 적는다.
export const metadata = { title: { absolute: '내 프로필 | WorkBridge' } };

export default function Layout({ children }) {
  return children;
}
