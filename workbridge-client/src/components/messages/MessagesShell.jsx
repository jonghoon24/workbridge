'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelectedLayoutSegment } from 'next/navigation';
import api from '@/lib/api';
import useAuthStore from '@/store/authStore';
import useDebounce from '@/lib/useDebounce';
import Button from '@/components/ui/Button';
import { CloseIcon, SearchIcon } from '@/components/ui/Icons';
import ConversationList from '@/components/messages/ConversationList';
import usePolling from '@/components/messages/usePolling';
import { LIST_POLL_MS, MESSAGES_CHANGED_EVENT, messageErrorText } from '@/components/messages/messageUtils';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
// 서버의 검색어 상한(workbridge-server/src/schemas/conversations.ts MAX_CONVERSATION_SEARCH_LENGTH)
const MAX_SEARCH_LENGTH = 100;

// /messages와 /messages/[conversationId]가 함께 쓰는 틀. 왼쪽 대화방 목록은 페이지를 옮겨도 유지되고
// 폴링으로 갱신된다. 모바일에서는 목록과 스레드 중 하나만 보인다.
// 검색어(프로젝트 제목, 상대방 이름)는 서버가 거른다(`q`). 목록이 페이지로 나뉘기 때문이다.
export default function MessagesShell({ children }) {
  const activeId = useSelectedLayoutSegment();
  const [conversations, setConversations] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 0 });
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  // 결과가 어떤 검색어의 것인지. 입력 중인 값이 아니라 이 값으로 빈 결과 문구와 강조를 그린다.
  const [resultQuery, setResultQuery] = useState('');
  const debouncedQuery = useDebounce(query.trim(), SEARCH_DEBOUNCE_MS);
  const pagesRef = useRef(1);
  const queryRef = useRef('');
  // 진행 중인 불러오기. 폴링과 새 메시지 이벤트는 진행 중이면 건너뛰고, 검색어가 바뀌면 취소하고 다시 부른다.
  // 그래야 늦게 도착한 이전 검색어의 응답이 새 결과를 덮지 않는다.
  const inFlightRef = useRef(null);

  const load = useCallback(async ({ restart = false } = {}) => {
    if (inFlightRef.current) {
      if (!restart) return;
      inFlightRef.current.abort();
    }
    const controller = new AbortController();
    inFlightRef.current = controller;
    const q = queryRef.current;
    try {
      const collected = [];
      let lastMeta = { total: 0, totalPages: 0 };
      for (let page = 1; page <= pagesRef.current; page += 1) {
        const { data } = await api.get('/api/conversations', {
          params: { page, limit: PAGE_SIZE, ...(q ? { q } : {}) },
          signal: controller.signal,
        });
        collected.push(...(data.conversations || []));
        lastMeta = data.meta || lastMeta;
        if (page >= lastMeta.totalPages) break;
      }
      if (controller.signal.aborted) return;
      setConversations(collected);
      setMeta(lastMeta);
      setResultQuery(q);
      setError('');
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(messageErrorText(err, '대화방 목록을 불러오지 못했습니다.'));
    } finally {
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
        setLoading(false);
        setSearching(false);
      }
    }
  }, []);

  useEffect(() => {
    useAuthStore.getState().initAuth();
    load();
    const reload = () => load();
    window.addEventListener(MESSAGES_CHANGED_EVENT, reload);
    return () => {
      window.removeEventListener(MESSAGES_CHANGED_EVENT, reload);
      // 비워 두어야 다시 마운트될 때(개발 모드의 StrictMode 이중 실행 포함) 첫 불러오기가 건너뛰어지지 않는다.
      inFlightRef.current?.abort();
      inFlightRef.current = null;
    };
  }, [load]);

  // 검색어가 (디바운스 뒤) 바뀌면 첫 페이지부터 다시 불러온다.
  useEffect(() => {
    if (debouncedQuery === queryRef.current) return;
    queryRef.current = debouncedQuery;
    pagesRef.current = 1;
    setPages(1);
    setSearching(true);
    load({ restart: true });
  }, [debouncedQuery, load]);

  usePolling(() => load(), LIST_POLL_MS);

  function loadMore() {
    pagesRef.current += 1;
    setPages(pagesRef.current);
    load({ restart: true });
  }

  function clearQuery() {
    setQuery('');
  }

  return (
    <div className="mx-auto max-w-6xl sm:px-6 sm:py-6 lg:px-8">
      <div className="flex h-[calc(100dvh-4rem)] overflow-hidden bg-white sm:h-[calc(100dvh-7rem)] sm:rounded-xl sm:border sm:border-gray-200/80 sm:shadow-card">
        <aside
          className={`${activeId ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-gray-200 md:w-80`}
          aria-label="대화방 목록"
        >
          <div className="border-b border-gray-200 px-4 pb-3 pt-3">
            <div className="flex items-center justify-between">
              <h1 className="text-lg font-bold text-gray-900">메시지</h1>
              {!loading && (resultQuery ? (
                <span className="text-xs text-gray-500" aria-live="polite">검색 결과 {meta.total}개</span>
              ) : (
                meta.total > 0 && <span className="text-xs text-gray-500">{meta.total}개 대화방</span>
              ))}
            </div>
            <div className="relative mt-2.5" role="search">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query) {
                    e.preventDefault();
                    clearQuery();
                  }
                }}
                maxLength={MAX_SEARCH_LENGTH}
                placeholder="프로젝트명, 상대방 이름 검색"
                aria-label="대화방 검색"
                className="block h-9 w-full rounded-lg border-gray-300 bg-gray-50 pl-9 pr-9 text-sm placeholder:text-gray-400 focus:border-primary-500 focus:bg-white focus:ring-primary-500 [&::-webkit-search-cancel-button]:hidden"
              />
              {searching ? (
                <svg className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : query && (
                <button
                  type="button"
                  onClick={clearQuery}
                  className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                  aria-label="검색어 지우기"
                >
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={searching}>
            <ConversationList
              conversations={conversations}
              activeId={activeId}
              loading={loading}
              error={error}
              searchQuery={resultQuery}
              onClearSearch={clearQuery}
            />
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
