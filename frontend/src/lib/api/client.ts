/**
 * Browser API client. All calls go through the Next.js BFF at
 * `/api/backend/v1/...`, which attaches the httpOnly access token.
 *
 *   api.get<UserResponse>("/auth/me")
 *   api.post<Org>("/organizations", { body: { name, slug } })
 *   api.get<Page<T>>(`/organizations/${orgId}/activity`, { query: { page: 2 } })
 *
 * Paths are relative to the backend's `/api/v1` prefix.
 */
import { CSRF_COOKIE, CSRF_HEADER } from "@/lib/auth/constants";
import { ApiError, parseApiError } from "@/lib/api/errors";

export const BFF_PREFIX = "/api/backend/v1";

export type QueryPrimitive = string | number | boolean | null | undefined;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];
export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  query?: QueryParams;
  /** JSON body (serialized with JSON.stringify). */
  body?: unknown;
  /** Multipart body; content-type (with boundary) is set by the browser. */
  formData?: FormData;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Do not trigger the global "session expired" handler on 401. */
  skipAuthRedirect?: boolean;
}

type UnauthorizedHandler = (error: ApiError) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Registers the handler invoked on 401 responses (installed by the app shell). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export function buildQueryString(query: QueryParams | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null || item === "") continue;
      params.append(key, String(item));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function apiUrl(path: string, query?: QueryParams): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${BFF_PREFIX}${normalized}${buildQueryString(query)}`;
}

export function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const part of document.cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

let csrfBootstrap: Promise<void> | null = null;

/** Returns the double-submit token, fetching a cookie first if it is missing. */
export async function getCsrfToken(): Promise<string | undefined> {
  const existing = readCookie(CSRF_COOKIE);
  if (existing) return existing;
  csrfBootstrap ??= fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      csrfBootstrap = null;
    });
  await csrfBootstrap;
  return readCookie(CSRF_COOKIE);
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return null;
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text) return null;
  if (type.includes("json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** Low-level request against any same-origin URL, returning the raw Response on success. */
export async function rawRequest(method: string, url: string, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("accept", headers.get("accept") ?? "application/json");
  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  if (method !== "GET" && method !== "HEAD") {
    const token = await getCsrfToken();
    if (token) headers.set(CSRF_HEADER, token);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError({ status: 0, code: "network_error", message: "Network error. Check your connection and try again." });
  }

  if (!response.ok) {
    const error = parseApiError(response.status, await readBody(response), response.headers.get("x-request-id"));
    if (error.status === 401 && !options.skipAuthRedirect) unauthorizedHandler?.(error);
    throw error;
  }
  return response;
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const response = await rawRequest(method, apiUrl(path, options.query), options);
  return (await readBody(response)) as T;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, "body" | "formData">) => request<T>("GET", path, options),
  post: <T>(path: string, options?: RequestOptions) => request<T>("POST", path, options),
  put: <T>(path: string, options?: RequestOptions) => request<T>("PUT", path, options),
  patch: <T>(path: string, options?: RequestOptions) => request<T>("PATCH", path, options),
  delete: <T>(path: string, options?: RequestOptions) => request<T>("DELETE", path, options),
};

/** Calls a BFF auth endpoint (`/api/auth/...`) with the same error handling. */
export async function authRequest<T>(
  method: "GET" | "POST",
  endpoint: "login" | "register" | "logout" | "session" | "change-password",
  options: RequestOptions = {},
): Promise<T> {
  const response = await rawRequest(method, `/api/auth/${endpoint}`, { skipAuthRedirect: true, ...options });
  return (await readBody(response)) as T;
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the plain filename parameter
    }
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(header);
  return plain ? plain[2].trim() : null;
}

/**
 * Downloads a binary response (exports, statements, reports) and saves it.
 * The filename falls back to the server's Content-Disposition.
 */
export async function downloadFile(path: string, filename?: string, options: Omit<RequestOptions, "body"> = {}): Promise<void> {
  const response = await rawRequest("GET", apiUrl(path, options.query), { ...options, headers: { accept: "*/*", ...options.headers } });
  const blob = await response.blob();
  const name = filename ?? filenameFromDisposition(response.headers.get("content-disposition")) ?? "download";
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export { filenameFromDisposition };
