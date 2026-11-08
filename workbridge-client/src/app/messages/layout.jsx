import MessagesShell from '@/components/messages/MessagesShell';

// 중첩 레이아웃이 문자열 title을 정하면 상위의 '%s | WorkBridge' 템플릿이 손자 경로까지 내려가지 않으므로
// 경로마다 전체 제목을 적는다.
export const metadata = { title: { absolute: '메시지 | WorkBridge' } };

// 대화방 목록과 스레드의 틀은 클라이언트 컴포넌트(MessagesShell)다. 이 레이아웃은 탭 제목만 정한다.
export default function MessagesLayout({ children }) {
  return <MessagesShell>{children}</MessagesShell>;
}
