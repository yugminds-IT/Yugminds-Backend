import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { computeCourseProgress } from '../utils/course-progress.util';
import {
  buildCertificateSvg,
  shortCertId,
  svgToJpegBuffer,
} from '../utils/certificate-svg.util';

export type CertificateIssueResult =
  | { issued: true; certificateId: string; alreadyExisted: false }
  | { issued: true; certificateId: string; alreadyExisted: true }
  | { issued: false; reason: 'not_enrolled' | 'not_eligible' };

/**
 * Single source of truth for "is this student eligible for a certificate in
 * this course, and issuing one if so" — used by student self-service
 * (`POST student/certificates/generate`), the auto-issuance hook fired from
 * progress-save handlers, and admin batch-generate. Previously each of
 * those either re-implemented the 80%-completion check inline (self-service)
 * or skipped it entirely (admin batch-generate would certify students who
 * hadn't completed anything).
 */
@Injectable()
export class CertificateService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Recomputes course completion % the same way "My Courses" does — via the shared computeCourseProgress util, not a re-derived formula. */
  async computeProgressPercent(
    studentId: number,
    courseId: string,
  ): Promise<number> {
    const [chapters, contents, progressRows] = await Promise.all([
      this.db.chapter.findMany({
        where: { courseId },
        select: { id: true },
      }),
      this.db.chapterContent.findMany({
        where: { chapter: { courseId } },
        select: { id: true, chapterId: true },
      }),
      this.db.courseProgress.findMany({
        where: { studentId, courseId },
        select: {
          contentId: true,
          chapterId: true,
          progress: true,
          completedAt: true,
          updatedAt: true,
        },
      }),
    ]);
    return computeCourseProgress(chapters, contents, progressRows)
      .progressPercentage;
  }

  /**
   * Issues a certificate for (studentId, courseId) if the student is
   * enrolled and at/above 80% completion, unless one already exists
   * (idempotent — safe to call speculatively, e.g. after every progress
   * save). `actorId` is who triggered it (student themself, an admin, or
   * undefined for the automatic hook) — recorded as `issuedBy`.
   */
  async issueIfEligible(
    studentId: number,
    courseId: string,
    actorId?: number,
  ): Promise<CertificateIssueResult> {
    const existing = await this.db.studentCertificate.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
      select: { id: true },
    });
    if (existing) {
      return { issued: true, certificateId: existing.id, alreadyExisted: true };
    }

    const enrolled = await this.db.studentCourse.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
      select: { studentId: true },
    });
    if (!enrolled) return { issued: false, reason: 'not_enrolled' };

    const progressPercent = await this.computeProgressPercent(studentId, courseId);
    if (progressPercent < 80) return { issued: false, reason: 'not_eligible' };

    const [course, profile, templateSetting] = await Promise.all([
      this.db.course.findUnique({ where: { id: courseId }, select: { title: true } }),
      this.db.profile.findUnique({ where: { userId: studentId }, select: { fullName: true } }),
      this.db.systemSetting.findUnique({ where: { key: 'certificate:template' } }),
    ]);

    const studentName = profile?.fullName || 'Student';
    const courseTitle = course?.title ?? 'Course';
    const issuedAtStr = new Date().toISOString().split('T')[0];
    const certificateName = `${courseTitle} Certificate`;

    const created = await this.db.studentCertificate.create({
      data: {
        studentId,
        courseId,
        certificateName,
        certificateUrl: 'pending',
        issuedBy: actorId ?? null,
        status: 'active',
      },
    });

    const svg = buildCertificateSvg(
      { studentName, courseTitle, issuedAt: issuedAtStr, certificateId: created.id },
      templateSetting?.value ?? null,
    );
    const jpegBuffer = await svgToJpegBuffer(svg);
    const certKey = this.storage.buildKey(`certificates/${studentId}`, `${created.id}.jpg`);
    const certUrl = await this.storage.uploadBuffer(certKey, jpegBuffer, 'image/jpeg');

    await this.db.studentCertificate.update({
      where: { id: created.id },
      data: { certificateUrl: certUrl, certificateKey: certKey },
    });

    await this.notifications
      .sendOne(actorId ?? studentId, studentId, {
        title: `Certificate ready: ${courseTitle}`,
        message: `Your certificate for "${courseTitle}" is ready. Certificate ID: ${shortCertId(created.id)}.`,
        type: 'certificate',
      })
      .catch(() => {
        // Notification failure must never roll back a successfully-issued certificate.
      });

    return { issued: true, certificateId: created.id, alreadyExisted: false };
  }

  /**
   * Real "is the file actually there" check, run only when an admin
   * explicitly asks (not on every list load — HEAD-checking every row on
   * every page view would be slow). Persists the result as `status` so
   * subsequent list reads are fast.
   */
  async verifyObjectsExist(
    ids: string[],
  ): Promise<Array<{ id: string; status: 'active' | 'broken' }>> {
    const certs = await this.db.studentCertificate.findMany({
      where: { id: { in: ids }, status: { not: 'revoked' } },
      select: { id: true, certificateKey: true, certificateUrl: true },
    });

    const results = await Promise.all(
      certs.map(async (c) => {
        const exists = c.certificateKey
          ? await this.storage.objectExists(c.certificateKey)
          : !c.certificateUrl.startsWith('pending');
        return { id: c.id, status: (exists ? 'active' : 'broken') as 'active' | 'broken' };
      }),
    );

    await Promise.all(
      results.map((r) =>
        this.db.studentCertificate.update({
          where: { id: r.id },
          data: { status: r.status },
        }),
      ),
    );

    return results;
  }
}
