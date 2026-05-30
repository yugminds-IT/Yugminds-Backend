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

export function list<T>(items: T[], total?: number): ApiResponse<T[]> {
  const count = total ?? items.length;
  return { data: items, meta: { total: count } };
}
