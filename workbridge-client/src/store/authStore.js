'use client';

import { create } from 'zustand';

// 액세스 토큰은 localStorage 한 곳에만 둔다. 요청 인터셉터(`lib/api.js`, `lib/authApi.js`)가 거기서
// 읽고, 갱신 인터셉터가 거기에 쓴다. 스토어에는 사용자 정보만 둔다 — 토큰 사본을 두면 갱신 뒤에
// 낡은 토큰이 남아 다시 써질 수 있다(#99).
const useAuthStore = create((set) => ({
  user: null,

  // 로그인·가입·역할 선택·OAuth처럼 토큰이 새로 생길 때
  setAuth: (user, accessToken) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('user', JSON.stringify(user));
    }
    set({ user });
  },

  // 프로필 저장처럼 사용자 정보만 바뀔 때. 토큰은 건드리지 않는다.
  setUser: (user) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('user', JSON.stringify(user));
    }
    set({ user });
  },

  clearAuth: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
    }
    set({ user: null });
  },

  initAuth: () => {
    if (typeof window !== 'undefined') {
      const accessToken = localStorage.getItem('accessToken');
      const userStr = localStorage.getItem('user');
      if (accessToken && userStr) {
        try {
          const user = JSON.parse(userStr);
          set({ user });
        } catch {
          localStorage.removeItem('accessToken');
          localStorage.removeItem('user');
        }
      }
    }
  },
}));

export default useAuthStore;
