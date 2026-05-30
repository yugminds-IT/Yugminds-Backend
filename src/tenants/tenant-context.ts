import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request tenant context used to enforce multi-tenant isolation in Prisma middleware.
 */
class TenantContext {
  private readonly als = new AsyncLocalStorage<{
    tenantId?: string;
    isSuperAdmin: boolean;
  }>();

  run<T>(tenantId: string, callback: () => T): T {
    return this.als.run({ tenantId, isSuperAdmin: false }, callback);
  }

  runSuperAdmin<T>(callback: () => T): T {
    return this.als.run({ tenantId: undefined, isSuperAdmin: true }, callback);
  }

  getTenantId(): string | undefined {
    return this.als.getStore()?.tenantId;
  }

  getIsSuperAdmin(): boolean {
    return this.als.getStore()?.isSuperAdmin ?? false;
  }
}

export const tenantContext = new TenantContext();
