// apiClient.js
'use strict';

(function () {
  const API_BASE = '/api';
  const DEFAULT_TIMEOUT = 15000;
  const MAX_RETRIES = 3;
  const RETRY_STATUS = [429, 502, 503, 504]; // Added 429 for rate limiting

  const authState = {
    getUser() {
      try {
        const raw = sessionStorage.getItem('ersUser');
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    },
    getCookie(name) {
      try {
        const cookies = document.cookie.split(';').reduce((acc, pair) => {
          const [key, ...valueParts] = pair.split('=');
          if (!key || valueParts.length === 0) return acc;
          acc[key.trim()] = decodeURIComponent(valueParts.join('=').trim());
          return acc;
        }, {});
        return cookies[name] || null;
      } catch (_) {
        return null;
      }
    },
    getToken() {
      try {
        return sessionStorage.getItem('ersToken') || this.getCookie('token');
      } catch (_) {
        return this.getCookie('token');
      }
    },
    setToken(token) {
      if (!token) return;
      try {
        sessionStorage.setItem('ersToken', token);
      } catch (_) {
        // ignore storage failures
      }
    },
    setUser(user, token) {
      if (!user) return;
      try {
        sessionStorage.setItem('ersUser', JSON.stringify(user));
        if (token) sessionStorage.setItem('ersToken', token);
      } catch (_) {
        // ignore storage failures
      }
    },
    clear() {
      sessionStorage.removeItem('ersUser');
      sessionStorage.removeItem('ersToken');
      localStorage.removeItem(OFFLINE_QUEUE_KEY);
    },
  };

  const OFFLINE_QUEUE_KEY = 'ersOfflineQueue';
  const MAX_OFFLINE_QUEUE = 50;

  const getOfflineQueue = () => {
    try {
      return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
    } catch (_) {
      return [];
    }
  };

  const setOfflineQueue = (queue) => {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  };

  const enqueueOfflineRequest = (url, options) => {
    const queue = getOfflineQueue();
    if (queue.length >= MAX_OFFLINE_QUEUE) {
      queue.shift();
    }
    queue.push({ url, options, createdAt: new Date().toISOString() });
    setOfflineQueue(queue);
  };

  const sendQueuedRequest = async (item) => {
    const controller = new AbortController();
    const timeout = item.options.timeout || DEFAULT_TIMEOUT;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(item.url, {
        ...item.options,
        credentials: 'include',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const result = await parseResponse(response);
      if (response.status === 401 || response.status === 403) {
        handleUnauthorized();
      }
      if (!response.ok) {
        const error = new Error(result.message || response.statusText);
        error.status = response.status;
        throw error;
      }
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  };

  const processOfflineQueue = async () => {
    if (!navigator.onLine) return;

    const queue = getOfflineQueue();
    if (!queue.length) return;

    const remaining = [];
    for (const item of queue) {
      try {
        await sendQueuedRequest(item);
      } catch (error) {
        remaining.push(item);
      }
    }

    setOfflineQueue(remaining);
  };

  window.addEventListener('online', processOfflineQueue);
  window.addEventListener('load', processOfflineQueue);

  const buildUrl = (input) => {
    if (typeof input !== 'string') return input;
    if (input.startsWith('http://') || input.startsWith('https://')) {
      return input;
    }
    if (input.startsWith('/api')) {
      return input;
    }
    if (input.startsWith('/')) {
      return `/api${input}`;
    }
    return `${API_BASE}/${input}`;
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const parseResponse = async (response) => {
    const text = await response.text();
    if (!text) return { success: false, data: null, message: response.statusText || 'Empty response' };
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error('Invalid JSON response from API');
    }
  };

  const handleUnauthorized = () => {
    authState.clear();
    window.location.href = '/';
  };

  const apiFetch = async (input, init = {}) => {
    const url = buildUrl(input);

    const method = (init.method || 'GET').toUpperCase();
    const safeOfflineQueue = !url.includes('/dispatch/request') && !url.includes('/api/auth/login') && !url.includes('/api/auth/register') && !url.includes('/api/auth/refresh');
    const shouldQueueOffline = !navigator.onLine && method !== 'GET' && safeOfflineQueue;

    if (!navigator.onLine && method !== 'GET' && !safeOfflineQueue) {
      throw new Error('This action cannot be performed while offline. Please reconnect and try again.');
    }

    if (shouldQueueOffline) {
      const headers = new Headers(init.headers || {});
      if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      const body = init.body instanceof FormData ? null : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      enqueueOfflineRequest(url, {
        method,
        headers: Object.fromEntries(headers.entries()),
        body,
        timeout: init.timeout || DEFAULT_TIMEOUT,
      });

      return {
        success: false,
        queued: true,
        message: 'Offline: request queued and will send automatically when network reconnects',
      };
    }

    const controller = new AbortController();
    const timeout = init.timeout || DEFAULT_TIMEOUT;
    const combinedSignal = init.signal || controller.signal;

    if (!init.signal) {
      setTimeout(() => controller.abort(), timeout);
    }

    const headers = new Headers(init.headers || {});
    headers.set('Accept', 'application/json');
    const token = authState.getToken();
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const options = {
      ...init,
      headers,
      credentials: 'include',
      signal: combinedSignal,
    };

    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      try {
        const response = await fetch(url, options);
        const result = await parseResponse(response);

        if (response.status === 401 || response.status === 403) {
          handleUnauthorized();
          throw new Error(result.message || 'Authentication required');
        }

        if (!response.ok) {
          const message = result.message || `Request failed with status ${response.status}`;
          const error = new Error(message);
          error.status = response.status;
          error.response = result;
          throw error;
        }

        return result;
      } catch (error) {
        if (error.name === 'AbortError') {
          const abortError = new Error('Request cancelled or timed out');
          abortError.name = error.name;
          abortError.status = error.status || 0;
          throw abortError;
        }

        const status = error.status || 0;
        if (attempt < MAX_RETRIES && (RETRY_STATUS.includes(status) || status === 0)) {
          attempt += 1;
          // Exponential backoff with jitter to prevent thundering herd
          const baseDelay = 200 * 2 ** attempt;
          const jitter = Math.random() * 0.1 * baseDelay; // 10% jitter
          await delay(baseDelay + jitter);
          continue;
        }

        throw error;
      }
    }
  };

  window.apiClient = {
    authState,
    fetch: apiFetch,
    request: apiFetch,
    get: (url, options = {}) => apiFetch(url, { ...options, method: 'GET' }),
    post: (url, body, options = {}) => apiFetch(url, { ...options, method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body) }),
    put: (url, body, options = {}) => apiFetch(url, { ...options, method: 'PUT', body: body instanceof FormData ? body : JSON.stringify(body) }),
    patch: (url, body, options = {}) => apiFetch(url, { ...options, method: 'PATCH', body: body instanceof FormData ? body : JSON.stringify(body) }),
    delete: (url, options = {}) => apiFetch(url, { ...options, method: 'DELETE' }),
  };
})();
