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
    };
    return { profile };
  }

  async update(userId: number, body: Record<string, unknown>) {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const nextEmail =
      typeof body.email === 'string' ? body.email.trim() : undefined;

    const profilePatch: Record<string, unknown> = {};
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
        ...(nextEmail ? { email: nextEmail } : {}),
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
