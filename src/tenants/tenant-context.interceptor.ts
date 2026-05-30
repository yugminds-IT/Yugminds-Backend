import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tenantContext } from './tenant-context';
import { CurrentUserPayload } from '../auth/decorators/current-user.decorator';

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const user = req.user as CurrentUserPayload | undefined;

    // Only enforce tenant context for authenticated requests.
    if (!user) {
      return next.handle();
    }

    const isGlobalUser = user.isSuperAdmin || user.role === 'admin';

    // Global users can authenticate without a tenant; they should bypass tenant enforcement.
    if (isGlobalUser) {
      return tenantContext.runSuperAdmin(() => next.handle());
    }

    if (!user.tenantId) {
      throw new UnauthorizedException('tenantId missing');
    }

    // Validate against tenant extracted by TenantMiddleware (subdomain/header).
    const expectedTenantId = req.tenantIdExpected as string | undefined;
    if (expectedTenantId && expectedTenantId !== user.tenantId) {
      throw new UnauthorizedException('tenant mismatch');
    }

    return tenantContext.run(user.tenantId, () => next.handle());
  }
}
