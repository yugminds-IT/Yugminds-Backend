import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class ProfileService {
  constructor(private readonly db: DatabaseService) {}

  async get(userId: number) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const { password: _, profile: profileRow, ...userRest } = user;
    const profile = {
      ...userRest,
      id: String(user.id),
      full_name: profileRow?.fullName ?? undefined,
      email: user.email,
      role: user.role,
      email_notifications: profileRow?.emailNotifications ?? true,
      assignment_reminders: profileRow?.assignmentReminders ?? true,
      grade_notifications: profileRow?.gradeNotifications ?? true,
      course_updates: profileRow?.courseUpdates ?? true,
      // Student dashboard's greeting subtitle reads
      // profile.students[0].schools[0].name / .grade / .section — this was
      // always undefined (the frontend expected a relation this endpoint
      // never populated), so the subtitle silently rendered as a lone " • "
      // for every student. Only fetched for role: student to avoid an
      // unnecessary query for every other role.
      ...(user.role === 'student'
        ? { students: await this.getStudentSchoolInfo(userId) }
        : {}),
    };
    return { profile };
  }

  private async getStudentSchoolInfo(studentId: number) {
    const membership = await this.db.studentSchool.findFirst({
      where: { studentId, isActive: true },
      include: { school: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    if (!membership) return [];
    return [
      {
        grade: membership.grade ?? undefined,
        section: membership.section ?? undefined,
        schools: [{ name: membership.school.name }],
      },
    ];
  }

  async update(userId: number, body: Record<string, unknown>) {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    // Email is intentionally immutable here — the "Email Address" field is
    // shown as locked/read-only in every settings UI (teacher/admin/
    // school-admin) with the label "Email is fixed and cannot be changed."
    // Any `body.email` is silently ignored rather than honored, so that
    // claim is actually true instead of just a UI-only restriction a direct
    // API call could bypass.

    const profilePatch: Record<string, unknown> = {};
    // Blank/whitespace-only is treated as "no change requested," not as an
    // instruction to clear the name — matches AdminProfileService.update()'s
    // handling of the same field.
    const fullName =
      typeof body.full_name === 'string' && body.full_name.trim()
        ? body.full_name.trim()
        : undefined;
    if (fullName !== undefined) profilePatch.fullName = fullName;

    const asBool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    const emailNotifications =
      asBool(body.email_notifications) ??
      asBool(body.emailNotifications) ??
      undefined;
    const assignmentReminders =
      asBool(body.assignment_reminders) ??
      asBool(body.assignmentReminders) ??
      undefined;
    const gradeNotifications =
      asBool(body.grade_notifications) ??
      asBool(body.gradeNotifications) ??
      undefined;
    const courseUpdates =
      asBool(body.course_updates) ?? asBool(body.courseUpdates) ?? undefined;

    if (typeof emailNotifications === 'boolean')
      profilePatch.emailNotifications = emailNotifications;
    if (typeof assignmentReminders === 'boolean')
      profilePatch.assignmentReminders = assignmentReminders;
    if (typeof gradeNotifications === 'boolean')
      profilePatch.gradeNotifications = gradeNotifications;
    if (typeof courseUpdates === 'boolean')
      profilePatch.courseUpdates = courseUpdates;

    const updated = await this.db.user.update({
      where: { id: userId },
      data: {
        profile:
          Object.keys(profilePatch).length > 0
            ? {
                upsert: {
                  create: profilePatch as never,
                  update: profilePatch as never,
                },
              }
            : undefined,
      } as never,
      include: { profile: true },
    });

    const { password: _, profile: profileRow, ...userRest } = updated;
    return {
      profile: {
        ...userRest,
        id: String(updated.id),
        full_name: profileRow?.fullName ?? undefined,
        email: updated.email,
        role: updated.role,
        email_notifications: profileRow?.emailNotifications ?? true,
        assignment_reminders: profileRow?.assignmentReminders ?? true,
        grade_notifications: profileRow?.gradeNotifications ?? true,
        course_updates: profileRow?.courseUpdates ?? true,
      },
    };
  }
}
