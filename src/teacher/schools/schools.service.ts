import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class TeacherSchoolsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * List schools assigned to this teacher via TeacherSchool (admin assignment).
   * Does not rely on User.tenantId so teachers with tenantId null still see their assigned schools.
   */
  async list(user: { id: number; tenantId?: string }) {
    const teacherSchools = await this.db.teacherSchool.findMany({
      where: { teacherId: user.id },
      include: { school: true },
    });
    const schools = teacherSchools.map((ts) => ({
      id: ts.school.id,
      name: ts.school.name,
      school_code: ts.school.schoolCode ?? undefined,
    }));
    return { schools };
  }
}
