'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { forgetUploads, isRejectedUpload, uploadAttachments } from '@/lib/attachments';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { formatDateTime } from '@/lib/format';
import { CONTRACT_STATUS_LABELS } from '@/constants/milestones';
import usePolling from './usePolling';
import MessageBubble from './MessageBubble';
import MessageComposer from './MessageComposer';
import { ChevronLeftIcon } from '@/components/ui/Icons';
import {
  MESSAGE_LIMITS,
  THREAD_POLL_MS,
  formatDayDivider,
  isReadByCounterpart,
  isSameKstDay,
  mergeMessages,
  messageErrorText,
  notifyMessagesChanged,
} from './messageUtils';

const NEAR_BOTTOM_PX = 80;
const NEAR_TOP_PX = 40;
/** `after` 폴링에서 hasMore가 이어질 때 한 번에 따라잡는 최대 횟수. */
const MAX_CATCH_UP_PAGES = 5;

// 대화 스레드. 처음에 최신 30개를 불러오고, 위로 스크롤하면
// `before`로 이전 메시지를, 탭이 보이는 동안 5초마다 `after`로 새 메시지를 가져온다. 상대 메시지가
// 화면에 보이면 `POST /read`를 부르고 헤더 배지에 알린다. 읽기만으로는 서버가 읽음 처리하지 않는다.
export default function MessageThread({ conversationId }) {
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [deletingId, setDeletingId] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const scrollRef = useRef(null);
  const messagesRef = useRef([]);
  const stickToBottom = useRef(true);
  const restoreFrom = useRef(null);
  const polling = useRef(false);
  const reading = useRef(false);

  const base = `/api/conversations/${conversationId}`;

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const markRead = useCallback(async () => {
    if (reading.current || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    reading.current = true;
    try {
      const { data } = await api.post(`${base}/read`);
      setConversation((prev) => (prev ? { ...prev, myLastReadAt: data.lastReadAt, unreadCount: data.unreadCount } : prev));
      notifyMessagesChanged();
    } catch {
      // 다음 폴링에서 다시 시도한다.
    } finally {
      reading.current = false;
    }
  }, [base]);

  useEffect(() => {
    let ignored = false;
    setLoading(true);
    setError('');
    setMessages([]);
    stickToBottom.current = true;

    Promise.all([
      api.get(base),
      api.get(`${base}/messages`, { params: { limit: MESSAGE_LIMITS.pageSize } }),
    ])
      .then(([detail, page]) => {
        if (ignored) return;
        setConversation(detail.data.conversation);
        setMessages(page.data.messages || []);
        setHasOlder(Boolean(page.data.hasMore));
        if (detail.data.conversation.unreadCount > 0) markRead();
      })
      .catch((err) => {
        if (!ignored) setError(messageErrorText(err, '대화방을 불러오지 못했습니다.'));
      })
      .finally(() => {
        if (!ignored) setLoading(false);
      });

    return () => {
      ignored = true;
    };
  }, [base, markRead]);

  const counterpartId = conversation?.counterpart?.id;
  const isMine = useCallback(
    (message) => message.kind === 'TEXT' && Boolean(message.sender) && message.sender.id !== counterpartId,
    [counterpartId],
  );

  async function poll() {
    if (polling.current || loading || error) return;
    polling.current = true;
    try {
      const detail = await api.get(base);
      setConversation(detail.data.conversation);

      let cursor = messagesRef.current[messagesRef.current.length - 1];
      let fresh = [];
      for (let i = 0; i < MAX_CATCH_UP_PAGES; i += 1) {
        const params = cursor ? { after: cursor.id, limit: 100 } : { limit: MESSAGE_LIMITS.pageSize };
        const { data } = await api.get(`${base}/messages`, { params });
        fresh = fresh.concat(data.messages || []);
        if (!cursor || !data.hasMore || data.messages.length === 0) break;
        cursor = data.messages[data.messages.length - 1];
      }

      if (fresh.length > 0) setMessages((prev) => mergeMessages(prev, fresh));
      const counterpartWrote = fresh.some((m) => m.kind === 'TEXT' && m.sender?.id === detail.data.conversation.counterpart?.id);
      if (counterpartWrote || detail.data.conversation.unreadCount > 0) markRead();
    } catch (err) {
      const status = err.response?.status;
      if (status === 404 || status === 403) setError(messageErrorText(err, '대화방을 불러오지 못했습니다.'));
    } finally {
      polling.current = false;
    }
  }

  usePolling(poll, THREAD_POLL_MS, { enabled: !loading && !error });
  // 삭제 가능 시간(5분)이 지나면 삭제 버튼이 사라지도록 시계를 갱신한다.
  usePolling(() => setNow(Date.now()), 15000);

  // 이전 메시지를 앞에 붙였으면 보던 위치를 유지하고, 아니면 바닥에 붙어 있을 때만 맨 아래로 내린다.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (restoreFrom.current) {
      const { height, top } = restoreFrom.current;
      el.scrollTop = el.scrollHeight - height + top;
      restoreFrom.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const loadOlder = useCallback(async () => {
    const first = messagesRef.current[0];
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const { data } = await api.get(`${base}/messages`, {
        params: { before: first.id, limit: MESSAGE_LIMITS.pageSize },
      });
      const el = scrollRef.current;
      if (el) restoreFrom.current = { height: el.scrollHeight, top: el.scrollTop };
      setMessages((prev) => mergeMessages(prev, data.messages || []));
      setHasOlder(Boolean(data.hasMore));
    } catch (err) {
      setActionError(messageErrorText(err, '이전 메시지를 불러오지 못했습니다.'));
    } finally {
      setLoadingOlder(false);
    }
  }, [base, loadingOlder]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (el.scrollTop < NEAR_TOP_PX && hasOlder && !loadingOlder) loadOlder();
  }

  // 파일은 저장소로 먼저 올리고(lib/attachments.js), 메시지에는 업로드 id만 보낸다.
  async function handleSend({ body, files, onProgress }) {
    try {
      const uploadIds = files.length > 0 ? await uploadAttachments(base, files, onProgress) : [];
      if (files.length > 0) onProgress(null);
      const response = await api.post(`${base}/messages`, { body, uploadIds });
      forgetUploads(files);
      stickToBottom.current = true;
      setMessages((prev) => mergeMessages(prev, [response.data.message]));
      setActionError('');
      notifyMessagesChanged();
    } catch (err) {
      // 업로드 단계의 오류는 이미 화면용 문구를 갖고 있다.
      if (err.displayMessage) throw err;
      // 업로드가 만료됐거나 저장된 파일이 거부되면 다음 시도에서 새로 올린다.
      if (isRejectedUpload(err)) forgetUploads(files);
      if (err.response?.status === 409) {
        // 그사이 대화가 닫혔거나 상대가 탈퇴했다. 입력창을 이유로 바꾼다.
        api.get(base).then(({ data }) => setConversation(data.conversation)).catch(() => {});
      }
      const wrapped = new Error('send failed');
      wrapped.displayMessage = messageErrorText(err, '메시지를 보내지 못했습니다.');
      throw wrapped;
    }
  }

  async function handleDelete(message) {
    if (!confirm('이 메시지를 삭제하시겠습니까? 상대방 화면에서도 "삭제된 메시지입니다"로 바뀝니다.')) return;
    setDeletingId(message.id);
    setActionError('');
    try {
      const { data } = await api.delete(`${base}/messages/${message.id}`);
      setMessages((prev) => mergeMessages(prev, [data.message]));
      notifyMessagesChanged();
    } catch (err) {
      setActionError(messageErrorText(err, '메시지를 삭제하지 못했습니다.'));
    } finally {
      setDeletingId('');
    }
  }

  if (loading) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-gray-500">대화를 불러오는 중...</div>;
  }
  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-red-600">{error}</p>
        <Link href="/messages" className="text-sm text-primary-600 hover:text-primary-700">대화 목록으로</Link>
      </div>
    );
  }
  if (!conversation) return null;

  const contractStatus = conversation.contract?.status;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
        <Link href="/messages" className="-ml-2 inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 md:hidden" aria-label="대화 목록으로">
          <ChevronLeftIcon className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-semibold text-gray-900">{conversation.counterpart?.name}</h2>
            <span className="text-xs text-gray-500">{conversation.myRole === 'CLIENT' ? '프리랜서' : '의뢰인'}</span>
          </div>
          <Link
            href={`/contracts/${conversation.contractId}`}
            className="block truncate text-xs text-primary-600 hover:text-primary-700"
          >
            {conversation.project?.title} · 계약 보기
          </Link>
        </div>
        <Badge variant={contractStatus}>{CONTRACT_STATUS_LABELS[contractStatus] || contractStatus}</Badge>
      </div>

      {conversation.canSend && conversation.closesAt && (
        <div className="border-b border-yellow-100 bg-yellow-50 px-4 py-2 text-xs text-yellow-800">
          계약이 {contractStatus === 'CANCELLED' ? '철회되어' : '완료되어'} {formatDateTime(conversation.closesAt)}까지만 메시지를 보낼 수 있습니다.
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-gray-50 px-3 py-4 sm:px-4"
        aria-live="polite"
      >
        {hasOlder && (
          <div className="flex justify-center pb-2">
            <Button variant="ghost" size="sm" onClick={loadOlder} loading={loadingOlder}>
              이전 메시지 더 보기
            </Button>
          </div>
        )}
        {messages.length === 0 && (
          <p className="py-10 text-center text-sm text-gray-400">
            {conversation.canSend ? '아직 메시지가 없습니다. 첫 메시지를 보내 보세요.' : '주고받은 메시지가 없습니다.'}
          </p>
        )}
        {messages.map((message, index) => {
          const previous = messages[index - 1];
          const newDay = !previous || !isSameKstDay(previous.createdAt, message.createdAt);
          const mine = isMine(message);
          return (
            <div key={message.id}>
              {newDay && (
                <div className="my-3 flex items-center gap-3 text-[11px] text-gray-400">
                  <span className="h-px flex-1 bg-gray-200" />
                  {formatDayDivider(message.createdAt)}
                  <span className="h-px flex-1 bg-gray-200" />
                </div>
              )}
              <MessageBubble
                message={message}
                mine={mine}
                readByCounterpart={mine ? isReadByCounterpart(message, conversation.counterpartLastReadAt) : null}
                now={now}
                deleting={deletingId === message.id}
                onDelete={handleDelete}
              />
            </div>
          );
        })}
      </div>

      {actionError && (
        <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700" role="alert">
          {actionError}
        </div>
      )}

      <MessageComposer
        canSend={conversation.canSend}
        closedReason={conversation.closedReason}
        contractStatus={contractStatus}
        onSend={handleSend}
      />
    </div>
  );
}
