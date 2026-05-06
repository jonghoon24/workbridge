import axios from 'axios';

const authApi = axios.create({
  baseURL: '',
  withCredentials: true,
  timeout: 30000,
});

authApi.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const accessToken = localStorage.getItem('accessToken');
    if (accessToken) {
      config.headers.Authorization = `Bearer ${accessToken}`;
    }
  }
  return config;
});

export default authApi;
