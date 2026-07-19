import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Prisma } from '@prisma/client';

export interface AuditEntry {
  actorId?: number | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  method: string;
  path: string;
  entityType?: string | null;
  entityId?: string | null;
  payload?: Prisma.InputJsonValue | null;
  statusCode?: number | null;
  success?: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditQuery {
  page?: string;
  limit?: string;
  actorEmail?: string;
  entityType?: string;
  method?: string;
  search?: string;
  from?: string;
  to?: string;
}

const SENSITIVE_KEYS = /pass(word)?|token|secret|authorization|otp/i;

/** Recursively strip password/token-like fields from a request body before persisting. */
export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizePayload(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : sanitizePayload(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) {
    return value.slice(0, 2000) + '…[truncated]';
  }
  return value;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Fire-and-forget write: audit logging must never break the request it observes. */
  record(entry: AuditEntry): void {
    this.db.auditLog
      .create({
        data: {
          actorId: entry.actorId ?? null,
          actorEmail: entry.actorEmail ?? null,
          actorRole: entry.actorRole ?? null,
          method: entry.method,
          path: entry.path,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          payload: (entry.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          statusCode: entry.statusCode ?? null,
          success: entry.success ?? true,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
        },
      })
      .catch((err: unknown) => {
        this.logger.warn(`Failed to write audit log: ${(err as Error)?.message}`);
      });
  }

  async list(query: AuditQuery) {
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit ?? '50', 10) || 50));

    const where: Prisma.AuditLogWhereInput = {};
    if (query.actorEmail) {
      where.actorEmail = { contains: query.actorEmail, mode: 'insensitive' };
    }
    if (query.entityType) where.entityType = query.entityType;
    if (query.method) where.method = query.method.toUpperCase();
    if (query.search) {
      where.OR = [
        { path: { contains: query.search, mode: 'insensitive' } },
        { actorEmail: { contains: query.search, mode: 'insensitive' } },
        { entityId: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }

    const [total, logs] = await Promise.all([
      this.db.auditLog.count({ where }),
      this.db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          actor: { select: { email: true, profile: { select: { fullName: true } } } },
        },
      }),
    ]);

    return {
      logs: logs.map((l) => ({
        id: l.id,
        actorId: l.actorId,
        actorEmail: l.actorEmail ?? l.actor?.email ?? null,
        actorName: l.actor?.profile?.fullName ?? null,
        actorRole: l.actorRole,
        method: l.method,
        path: l.path,
        entityType: l.entityType,
        entityId: l.entityId,
        payload: l.payload,
        statusCode: l.statusCode,
        success: l.success,
        ipAddress: l.ipAddress,
        createdAt: l.createdAt,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** Distinct entity types seen so the UI filter dropdown reflects real data. */
  async entityTypes(): Promise<string[]> {
    const rows = await this.db.auditLog.findMany({
      where: { entityType: { not: null } },
      distinct: ['entityType'],
      select: { entityType: true },
      orderBy: { entityType: 'asc' },
    });
    return rows.map((r) => r.entityType!).filter(Boolean);
  }
}
