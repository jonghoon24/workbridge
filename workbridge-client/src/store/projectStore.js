'use client';

import { create } from 'zustand';

const useProjectStore = create((set) => ({
  filters: {
    search: '',
    category: '',
    minBudget: '',
    maxBudget: '',
    skills: '',
    sort: 'latest',
  },
  page: 1,

  setFilters: (filters) => set((state) => ({
    filters: { ...state.filters, ...filters },
    page: 1,
  })),

  setPage: (page) => set({ page }),

  resetFilters: () => set({
    filters: { search: '', category: '', minBudget: '', maxBudget: '', skills: '', sort: 'latest' },
    page: 1,
  }),
}));

export default useProjectStore;
