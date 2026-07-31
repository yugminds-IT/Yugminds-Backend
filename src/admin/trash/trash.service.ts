import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Role } from '@prisma/client';
import { AdminSchoolsService } from '../schools/schools.service';

export type TrashEntityType = 'students' | 'teachers' | 'schools' | 'courses';

@Injectable()
export class TrashService {
  constructor(
    private readonly db: DatabaseService,
    private readonly schoolsService: AdminSchoolsService,
  ) {}

  async list() {
    const [users, schools, courses] = await Promise.all([
      this.db.user.findMany({
        where: {
          deletedAt: { not: null },
          role: { in: [Role.student, Role.teacher] },
        },
        select: {
          id: true,
          email: true,
          role: true,
          deletedAt: true,
          profile: { select: { fullName: true } },
          tenant: { select: { name: true } },
        },
        orderBy: { deletedAt: 'desc' },
        take: 500,
      }),
      this.db.school.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, name: true, deletedAt: true },
        orderBy: { deletedAt: 'desc' },
        take: 200,
      }),
      this.db.course.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, title: true, deletedAt: true },
        orderBy: { deletedAt: 'desc' },
        take: 200,
      }),
    ]);

    const mapUser = (u: (typeof users)[number]) => ({
      id: String(u.id),
      name: u.profile?.fullName ?? u.email,
      detail: `${u.email}${u.tenant?.name ? ` · ${u.tenant.name}` : ''}`,
      deleted_at: u.deletedAt,
    });

    return {
      students: users.filter((u) => u.role === Role.student).map(mapUser),
      teachers: users.filter((u) => u.role === Role.teacher).map(mapUser),
      schools: schools.map((s) => ({
        id: s.id,
        name: s.name,
        detail: 'School (users are restored with it)',
        deleted_at: s.deletedAt,
      })),
      courses: courses.map((c) => ({
        id: c.id,
        name: c.title,
        detail: 'Course (restored unpublished)',
        deleted_at: c.deletedAt,
      })),
    };
  }

  async restore(entityType: TrashEntityType, id: string) {
    switch (entityType) {
      case 'students':
      case 'teachers': {
        const userId = parseInt(id, 10);
        const user = await this.db.user.findFirst({
          where: { id: userId, deletedAt: { not: null } },
        });
        if (!user) throw new NotFoundException('Trashed user not found');
        await this.db.user.update({
          where: { id: userId },
          data: { deletedAt: null, isActive: true },
        });
        return { success: true };
      }
      case 'schools': {
        const school = await this.db.school.findFirst({
          where: { id, deletedAt: { not: null } },
        });
        if (!school) throw new NotFoundException('Trashed school not found');
        await this.db.school.update({
          where: { id },
          data: { deletedAt: null, isActive: true },
        });
        // Restore the users that were trashed with the school.
        await this.db.user.updateMany({
          where: { tenantId: id, deletedAt: { not: null } },
          data: { deletedAt: null, isActive: true },
        });
        return { success: true };
      }
      case 'courses': {
        const course = await this.db.course.findFirst({
          where: { id, deletedAt: { not: null } },
        });
        if (!course) throw new NotFoundException('Trashed course not found');
        // Restored unpublished on purpose — admin re-publishes deliberately.
        await this.db.course.update({
          where: { id },
          data: { deletedAt: null },
        });
        return { success: true };
      }
      default:
        throw new BadRequestException(`Unknown entity type: ${String(entityType)}`);
    }
  }

  /** Permanent, irreversible delete of an already-trashed record. */
  async purge(entityType: TrashEntityType, id: string) {
    switch (entityType) {
      case 'students':
      case 'teachers': {
        const userId = parseInt(id, 10);
        const user = await this.db.user.findFirst({
          where: { id: userId, deletedAt: { not: null } },
        });
        if (!user) throw new NotFoundException('Trashed user not found');
        // TeacherReport.teacherId has no FK relation to User (a report must
        // survive a teacher being soft-deleted so history stays visible), so
        // a hard delete here would otherwise leave orphaned report rows that
        // can never resolve a teacher name again ("Unknown" in the admin UI).
        await this.db.teacherReport.deleteMany({ where: { teacherId: userId } });
        // Same gap for TeacherLeave — its teacherId relation isn't enforced
        // at the DB level either, so it would otherwise survive as a
        // permanently-orphaned "pending" leave request no admin can ever
        // resolve (inflates the dashboard's pending-leaves count forever).
        await this.db.teacherLeave.deleteMany({ where: { teacherId: userId } });
        await this.db.user.delete({ where: { id: userId } });
        return { success: true };
      }
      case 'schools': {
        const school = await this.db.school.findFirst({
          where: { id, deletedAt: { not: null } },
        });
        if (!school) throw new NotFoundException('Trashed school not found');
        await this.schoolsService.purge(id);
        return { success: true };
      }
      case 'courses': {
        const course = await this.db.course.findFirst({
          where: { id, deletedAt: { not: null } },
        });
        if (!course) throw new NotFoundException('Trashed course not found');
        // StudentCourse/CourseProgress have bare courseId columns with no
        // enforced FK to Course (no @relation in schema.prisma, unlike
        // Chapter/Assignment/CourseAccess which cascade automatically) —
        // without this cleanup, purging a course leaves every enrollment
        // and progress row for it permanently orphaned, inflating "Total
        // Courses"-style counts and student course lists forever.
        await this.db.studentCourse.deleteMany({ where: { courseId: id } });
        await this.db.courseProgress.deleteMany({ where: { courseId: id } });
        await this.db.course.delete({ where: { id } });
        return { success: true };
      }
      default:
        throw new BadRequestException(`Unknown entity type: ${String(entityType)}`);
    }
  }
}
