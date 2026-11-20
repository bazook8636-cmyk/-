import { uploadToFirebaseStorageIfAvailable } from './firebase';

const TOKEN_KEY = 'bazooka_session_token';

export function getStoredToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setStoredToken(token: string) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...options, headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };

  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export async function uploadMediaFile(file: File): Promise<{ url: string; fileName: string; fileSize: number }> {
  // Prefer Firebase Storage when signed in via Firebase Auth; otherwise use server upload storage
  const fbUrl = await uploadToFirebaseStorageIfAvailable(file);
  if (fbUrl) {
    return { url: fbUrl, fileName: file.name, fileSize: file.size };
  }

  const form = new FormData();
  form.append('file', file);
  return apiFetch<{ url: string; fileName: string; fileSize: number }>('/api/upload', {
    method: 'POST',
    body: form,
  });
}
