import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
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

@Injectable()
export class MonitoringInterceptor implements NestInterceptor {
  constructor(private readonly monitoring: MonitoringService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<any>();

    const method = String(req?.method || 'GET');
    const url = String(req?.originalUrl || req?.url || '/');
    const endpoint = sanitizePath(url);
    const userId = req?.user?.id != null ? String(req.user.id) : undefined;

    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const res = http.getResponse<any>();
        const statusCode = Number(res?.statusCode || 200);
        this.monitoring.record({
          endpoint,
          method,
          duration: Date.now() - start,
          statusCode,
          timestamp: Date.now(),
          userId,
        });
      }),
      catchError((err: any) => {
        const res = http.getResponse<any>();
        const statusCode = Number(res?.statusCode || err?.status || 500);
        this.monitoring.record({
          endpoint,
          method,
          duration: Date.now() - start,
          statusCode,
          timestamp: Date.now(),
          userId,
          error: (err?.message ? String(err.message) : undefined) ?? 'Error',
        });
        return throwError(() => err);
      }),
    );
  }
}
