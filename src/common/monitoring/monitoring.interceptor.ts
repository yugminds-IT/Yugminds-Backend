import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MonitoringService } from './monitoring.service';

function sanitizePath(path: string): string {
  // Strip query string
  const base = (path || '').split('?')[0] || '/';
  // Collapse IDs (numbers/uuids) to reduce cardinality
  return base
    .replace(/\b\d+\b/g, ':id')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      ':uuid',
    );
}

// The monitoring dashboard's own "Auto-Refresh" polls this exact endpoint
// every few seconds — tracking it would create a self-referential feedback
// loop where watching your API traffic inflates the very traffic you're
// watching. Excluded by sanitized path, not raw path, so query strings don't
// let it slip through.
const EXCLUDED_ENDPOINTS = new Set(['/admin/monitoring-dashboard']);

@Injectable()
export class MonitoringInterceptor implements NestInterceptor {
  constructor(private readonly monitoring: MonitoringService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<any>();
    const res = http.getResponse<any>();

    const method = String(req?.method || 'GET');
    const url = String(req?.originalUrl || req?.url || '/');
    const endpoint = sanitizePath(url);
    const userId = req?.user?.id != null ? String(req.user.id) : undefined;

    if (EXCLUDED_ENDPOINTS.has(endpoint)) {
      return next.handle();
    }

    const start = Date.now();
    let errorMessage: string | undefined;

    // Record on the response's 'finish' event, not inside tap()/catchError().
    // NestJS's exception filters (which set the real HTTP status code for
    // thrown errors) — and the response handler that calls res.status() for
    // @HttpCode()-annotated success responses — both run AFTER the
    // interceptor chain resolves. Reading res.statusCode from tap/catchError
    // therefore always saw Node's default (200), regardless of what was
    // actually sent to the client: every thrown error (401/403/404/500/...)
    // was silently recorded as a 200 success. 'finish' fires once the
    // response has genuinely been sent, so res.statusCode is final and
    // correct for both success and error paths.
    res.on('finish', () => {
      this.monitoring.record({
        endpoint,
        method,
        duration: Date.now() - start,
        statusCode: Number(res.statusCode) || 200,
        timestamp: Date.now(),
        userId,
        error: errorMessage,
      });
    });

    return next.handle().pipe(
      catchError((err: any) => {
        errorMessage = err?.message ? String(err.message) : 'Error';
        return throwError(() => err);
      }),
    );
  }
}
