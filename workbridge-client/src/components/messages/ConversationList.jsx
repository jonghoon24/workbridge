'use client';

import Link from 'next/link';
import Badge from '@/components/ui/Badge';
import { CONTRACT_STATUS_LABELS } from '@/constants/milestones';
import UnreadBadge from './UnreadBadge';
import { formatListTime, previewText } from './messageUtils';
import { MessageIcon } from '@/components/ui/Icons';

// 대화방 목록(BEHAVIOR.md MG11). 정렬은 서버 순서(마지막 메시지 최신순) 그대로다.
export default function ConversationList({ conversations, activeId, loading, error }) {
  if (loading) {
    return <div className="p-6 text-center text-sm text-gray-500">대화방을 불러오는 중...</div>;
  }
  if (error) {
    return <div className="m-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>;
  }
  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-gray-100 text-gray-400">
          <MessageIcon className="h-5 w-5" />
        </div>
        <p className="text-sm font-semibold text-gray-900">아직 대화방이 없습니다.</p>
        <p className="mt-1 text-xs leading-5 text-gray-500">지원이 수락되어 계약이 만들어지면 상대방과의 대화방이 열립니다.</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-gray-100">
      {conversations.map((conversation) => {
        const active = conversation.id === activeId;
        const unread = conversation.unreadCount || 0;
        const last = conversation.lastMessage;
        return (
          <li key={conversation.id}>
            <Link
              href={`/messages/${conversation.id}`}
              className={`block px-4 py-3 transition-colors ${active ? 'bg-primary-50' : 'hover:bg-gray-50'}`}
              aria-current={active ? 'page' : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`truncate text-sm ${unread > 0 ? 'font-semibold text-gray-900' : 'font-medium text-gray-800'}`}>
                  {conversation.counterpart?.name || '알 수 없는 사용자'}
                  <span className="ml-1.5 text-xs font-normal text-gray-500">
                    {conversation.myRole === 'CLIENT' ? '프리랜서' : '의뢰인'}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-gray-400">
                  {formatListTime(conversation.lastMessageAt || conversation.createdAt)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className="truncate text-xs text-gray-500">{conversation.project?.title}</span>
                <Badge variant={conversation.contract?.status} className="shrink-0 !px-1.5 !py-0 text-[10px]">
                  {CONTRACT_STATUS_LABELS[conversation.contract?.status] || conversation.contract?.status}
                </Badge>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <p className={`truncate text-sm ${unread > 0 ? 'text-gray-900' : 'text-gray-500'} ${last?.deleted ? 'italic' : ''}`}>
                  {last?.kind === 'SYSTEM' && <span className="mr-1 text-xs text-gray-400">[알림]</span>}
                  {previewText(last)}
                </p>
                <UnreadBadge count={unread} className="shrink-0" />
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
