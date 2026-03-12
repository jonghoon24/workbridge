'use client';

import { create } from 'zustand';

const useAuthStore = create((set) => ({
  user: null,
  accessToken: null,

  setAuth: (user, accessToken) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('user', JSON.stringify(user));
    }
    set({ user, accessToken });
  },

  clearAuth: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('user');
    }
    set({ user: null, accessToken: null });
  },

  initAuth: () => {
    if (typeof window !== 'undefined') {
      const accessToken = localStorage.getItem('accessToken');
      const userStr = localStorage.getItem('user');
      if (accessToken && userStr) {
        try {
          const user = JSON.parse(userStr);
          set({ user, accessToken });
        } catch {
          localStorage.removeItem('accessToken');
          localStorage.removeItem('user');
        }
      }
    }
  },
}));

export default useAuthStore;
