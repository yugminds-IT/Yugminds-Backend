import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export interface AlertItem {
  id: string;
  label: string;
  count: number;
  href?: string;
  tone: 'red' | 'amber';
}

/**
 * Threshold monitors surfaced into the dashboard's Needs Attention panel.
 * Each check is cheap (a count query) and only produces an item when the
 * threshold is breached, so a healthy system returns [].
 */
@Injectable()
export class AlertsService {
  constructor(private readonly db: DatabaseService) {}

  async evaluate(): Promise<{ alerts: AlertItem[] }> {
    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    const twoDaysAgo = new Date(now - 48 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [failedLogins, failedAdminOps, staleResets, staleContacts] =
      await Promise.all([
        // Spike in failed sign-ins — possible credential stuffing or a broken client.
        this.db.authActivity.count({
          where: {
            action: { contains: 'login' },
            success: false,
            createdAt: { gte: oneHourAgo },
          },
        }),
        // Admin mutations erroring — something in the admin surface is broken.
        this.db.auditLog.count({
          where: { success: false, createdAt: { gte: oneHourAgo } },
        }),
        // Password resets nobody has handled for 2+ days.
        this.db.passwordResetRequest.count({
          where: { status: 'pending', requestedAt: { lte: twoDaysAgo } },
        }),
        // Contact submissions unanswered for a week.
        this.db.contactSubmission.count({
          where: { status: 'new', createdAt: { lte: sevenDaysAgo } },
        }),
      ]);

    const alerts: AlertItem[] = [];

    if (failedLogins >= 10) {
      alerts.push({
        id: 'failed-logins',
        label: `${failedLogins} failed sign-ins in the last hour`,
        count: failedLogins,
        href: '/lms/admin/monitoring',
        tone: failedLogins >= 30 ? 'red' : 'amber',
      });
    }
    if (failedAdminOps >= 10) {
      alerts.push({
        id: 'failed-admin-ops',
        label: `${failedAdminOps} failing admin operations in the last hour`,
        count: failedAdminOps,
        href: '/lms/admin/audit-log',
        tone: 'red',
      });
    }
    if (staleResets > 0) {
      alerts.push({
        id: 'stale-password-resets',
        label: `${staleResets} password reset${staleResets !== 1 ? 's' : ''} waiting 2+ days`,
        count: staleResets,
        href: '/lms/admin/password-reset-requests',
        tone: 'red',
      });
    }
    if (staleContacts > 0) {
      alerts.push({
        id: 'stale-contacts',
        label: `${staleContacts} contact submission${staleContacts !== 1 ? 's' : ''} unanswered 7+ days`,
        count: staleContacts,
        href: '/lms/admin/contact-submissions',
        tone: 'amber',
      });
    }

    return { alerts };
  }
}
