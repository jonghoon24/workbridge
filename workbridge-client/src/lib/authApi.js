import axios from 'axios';

// Login, signup, select-role and logout only; every other backend call goes through `api.js`.
// `api.js` answers a 401 by refreshing the token (`/api/auth/refresh`) and retrying the request
// once, and sends the page to `/login` when the refresh fails. A wrong password is also a 401, so
// a login sent through `api.js` would try a refresh and reload the page, wiping the error message.
// This instance therefore attaches the token and has no refresh interceptor.

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
