'use client';

import { useParams } from 'next/navigation';
import MessageThread from '@/components/messages/MessageThread';

export default function ConversationPage() {
  const { conversationId } = useParams();
  // 대화방을 옮기면 입력 중이던 내용과 스크롤 상태를 새로 시작한다.
  return <MessageThread key={conversationId} conversationId={conversationId} />;
}
