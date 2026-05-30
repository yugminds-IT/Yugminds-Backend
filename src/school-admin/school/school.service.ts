import { Injectable, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class SchoolAdminSchoolService {
  constructor(private readonly db: DatabaseService) {}

  async get(user: { id: number; tenantId?: string }) {
    const sa = await this.db.schoolAdmin.findFirst({
      where: { userId: user.id },
      include: { school: true },
    });
    if (!sa?.school) {
      throw new ForbiddenException('School admin must be assigned to a school');
    }
    const school = sa.school;
    const grades = await this.db.grade.findMany({
      where: { schoolId: school.id },
      include: { sections: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    const gradesOffered = grades.map((g) => g.name);
    const sectionNames = [
      ...new Set(grades.flatMap((g) => (g.sections ?? []).map((s) => s.name))),
    ].sort();
    const numberOfSections = sectionNames.length > 0 ? sectionNames.length : 3;
    return {
      school: {
        id: school.id,
        name: school.name,
        school_code: school.schoolCode,
        grades_offered: gradesOffered,
        sections_offered: sectionNames,
        number_of_sections: numberOfSections,
        is_active: school.isActive,
        created_at: school.createdAt,
        updated_at: school.updatedAt,
      },
    };
  }
}
