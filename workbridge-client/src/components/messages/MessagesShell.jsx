'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelectedLayoutSegment } from 'next/navigation';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import Button from '@/components/ui/Button';
import ConversationList from '@/components/messages/ConversationList';
import usePolling from '@/components/messages/usePolling';
import { LIST_POLL_MS, MESSAGES_CHANGED_EVENT, messageErrorText } from '@/components/messages/messageUtils';

const PAGE_SIZE = 50;

// /messages와 /messages/[conversationId]가 함께 쓰는 틀. 왼쪽 대화방 목록은 페이지를 옮겨도 유지되고
// 폴링으로 갱신된다. 모바일에서는 목록과 스레드 중 하나만 보인다.
export default function MessagesShell({ children }) {
  const activeId = useSelectedLayoutSegment();
  const [conversations, setConversations] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 0 });
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pagesRef = useRef(1);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const collected = [];
      let lastMeta = { total: 0, totalPages: 0 };
      for (let page = 1; page <= pagesRef.current; page += 1) {
        const { data } = await api.get('/api/conversations', { params: { page, limit: PAGE_SIZE } });
        collected.push(...(data.conversations || []));
        lastMeta = data.meta || lastMeta;
        if (page >= lastMeta.totalPages) break;
      }
      setConversations(collected);
      setMeta(lastMeta);
      setError('');
    } catch (err) {
      setError(messageErrorText(err, '대화방 목록을 불러오지 못했습니다.'));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    load();
    window.addEventListener(MESSAGES_CHANGED_EVENT, load);
    return () => window.removeEventListener(MESSAGES_CHANGED_EVENT, load);
  }, [load]);

  usePolling(load, LIST_POLL_MS);

  function loadMore() {
    pagesRef.current += 1;
    setPages(pagesRef.current);
    load();
  }

  return (
    <div className="mx-auto max-w-6xl sm:px-6 sm:py-6 lg:px-8">
      <div className="flex h-[calc(100dvh-4rem)] overflow-hidden bg-white sm:h-[calc(100dvh-7rem)] sm:rounded-xl sm:border sm:border-gray-200/80 sm:shadow-card">
        <aside
          className={`${activeId ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-gray-200 md:w-80`}
          aria-label="대화방 목록"
        >
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
            <h1 className="text-lg font-bold text-gray-900">메시지</h1>
            {meta.total > 0 && <span className="text-xs text-gray-500">{meta.total}개 대화방</span>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ConversationList conversations={conversations} activeId={activeId} loading={loading} error={error} />
            {!loading && pages < meta.totalPages && (
              <div className="flex justify-center p-3">
                <Button variant="ghost" size="sm" onClick={loadMore}>대화방 더 보기</Button>
              </div>
            )}
          </div>
        </aside>
        <section className={`${activeId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          {children}
        </section>
      </div>
    </div>
  );
}
