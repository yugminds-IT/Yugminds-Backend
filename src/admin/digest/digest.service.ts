import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../../database/database.service';
import { Role } from '@prisma/client';

/**
 * Weekly platform digest, delivered every Monday 08:00 server time as an
 * in-app notification to every active admin. Also exposed via
 * POST /admin/digest/run for an on-demand preview (see DigestController).
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(private readonly db: DatabaseService) {}

  @Cron('0 8 * * 1')
  async weeklyDigestCron(): Promise<void> {
    try {
      await this.sendWeeklyDigest();
    } catch (err) {
      this.logger.error(`Weekly digest failed: ${(err as Error)?.message}`);
    }
  }

  async buildDigest(): Promise<{ title: string; message: string }> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      newStudents,
      newTeachers,
      newSchools,
      newSubmissions,
      pendingResets,
      pendingLeaves,
      newContacts,
      trashedUsers,
    ] = await Promise.all([
      this.db.user.count({
        where: { role: Role.student, createdAt: { gte: weekAgo }, deletedAt: null },
      }),
      this.db.user.count({
        where: { role: Role.teacher, createdAt: { gte: weekAgo }, deletedAt: null },
      }),
      this.db.school.count({
        where: { createdAt: { gte: weekAgo }, deletedAt: null },
      }),
      this.db.assignmentSubmission.count({
        where: { submittedAt: { gte: weekAgo } },
      }),
      this.db.passwordResetRequest.count({ where: { status: 'pending' } }),
      // TeacherLeave has no enforced FK — exclude rows orphaned by a
      // hard-deleted teacher/school (see AdminDashboardService.getStats()).
      this.db
        .$queryRaw<
          Array<{ count: bigint }>
        >`SELECT COUNT(*)::bigint as count FROM "TeacherLeave" tl JOIN "User" u ON u.id = tl."teacherId" JOIN "School" sc ON sc.id = tl."schoolId" WHERE tl.status = 'pending'`
        .then((rows) => Number(rows[0]?.count ?? 0)),
      this.db.contactSubmission.count({
        where: { status: 'new', createdAt: { gte: weekAgo } },
      }),
      this.db.user.count({ where: { deletedAt: { not: null } } }),
    ]);

    const lines = [
      `This week on Yugminds:`,
      ``,
      `• ${newStudents} new student${newStudents !== 1 ? 's' : ''}, ${newTeachers} new teacher${newTeachers !== 1 ? 's' : ''}, ${newSchools} new school${newSchools !== 1 ? 's' : ''}`,
      `• ${newSubmissions} assignment submission${newSubmissions !== 1 ? 's' : ''}`,
      `• ${newContacts} new contact submission${newContacts !== 1 ? 's' : ''}`,
      ``,
      `Waiting on you:`,
      `• ${pendingResets} pending password reset${pendingResets !== 1 ? 's' : ''}`,
      `• ${pendingLeaves} pending leave request${pendingLeaves !== 1 ? 's' : ''}`,
      ...(trashedUsers > 0
        ? [`• ${trashedUsers} account${trashedUsers !== 1 ? 's' : ''} in Trash`]
        : []),
    ];

    const weekLabel = new Date().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    return {
      title: `Weekly platform digest — ${weekLabel}`,
      message: lines.join('\n'),
    };
  }

  /**
   * Idempotency guard: reachable both from the Monday 08:00 cron and the
   * on-demand `POST /admin/digest/run` button, so without a guard a manual
   * click (or a second server instance running the same cron) produces
   * duplicate "Weekly platform digest" notifications for every admin. A
   * digest is considered "already sent this week" if the last recorded send
   * was within the last 6 days.
   */
  private static readonly DIGEST_LOCK_KEY = 'digest:last_sent_at';
  private static readonly DIGEST_MIN_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000;

  async sendWeeklyDigest(): Promise<{
    recipients: number;
    skipped?: boolean;
  }> {
    const lock = await this.db.systemSetting.findUnique({
      where: { key: DigestService.DIGEST_LOCK_KEY },
    });
    if (lock) {
      const elapsed = Date.now() - new Date(lock.value).getTime();
      if (elapsed < DigestService.DIGEST_MIN_INTERVAL_MS) {
        this.logger.log(
          `Weekly digest skipped — already sent ${Math.round(elapsed / 3_600_000)}h ago`,
        );
        return { recipients: 0, skipped: true };
      }
    }

    const { title, message } = await this.buildDigest();
    const admins = await this.db.user.findMany({
      where: { role: Role.admin, isActive: true },
      select: { id: true },
    });
    if (admins.length === 0) return { recipients: 0 };

    await this.db.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        title,
        message,
        mode: 'system_alert',
        allowReplies: false,
      })),
    });
    await this.db.systemSetting.upsert({
      where: { key: DigestService.DIGEST_LOCK_KEY },
      create: { key: DigestService.DIGEST_LOCK_KEY, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    });
    this.logger.log(`Weekly digest sent to ${admins.length} admin(s)`);
    return { recipients: admins.length };
  }
}
