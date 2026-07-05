/**
 * EdTech-style API response envelope (Google Classroom / Teachmint style).
 * All successful responses use { data, meta? }. Errors use HTTP status + body.
 */

export interface ApiMeta {
  total: number;
  page?: number;
  limit?: number;
}

export interface ApiResponse<T> {
  data: T;
  meta?: ApiMeta;
}

export function ok<T>(data: T, meta?: ApiMeta): ApiResponse<T> {
  return meta ? { data, meta } : { data };
}
