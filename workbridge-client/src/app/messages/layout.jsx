import MessagesShell from '@/components/messages/MessagesShell';

export const metadata = { title: '메시지' };

// 대화방 목록과 스레드의 틀은 클라이언트 컴포넌트(MessagesShell)다. 이 레이아웃은 탭 제목만 정한다.
export default function MessagesLayout({ children }) {
  return <MessagesShell>{children}</MessagesShell>;
}
