'use client';

import { create } from 'zustand';

const defaultFilters = {
  search: '',
  category: '',
  minBudget: '',
  maxBudget: '',
  skills: '',
  status: 'OPEN',
  sort: 'latest',
};

const useProjectStore = create((set) => ({
  filters: defaultFilters,
  page: 1,

  setFilters: (filters) => set((state) => ({
    filters: { ...state.filters, ...filters },
    page: 1,
  })),

  setPage: (page) => set({ page }),

  setFiltersAndPage: (filters, page) => set({
    filters: { ...defaultFilters, ...filters },
    page,
  }),

  resetFilters: () => set({
    filters: defaultFilters,
    page: 1,
  }),
}));

export default useProjectStore;
