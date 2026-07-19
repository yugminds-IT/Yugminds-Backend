import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { Role } from '@prisma/client';

export interface SearchHit {
  id: string;
  label: string;
  sublabel: string | null;
}

/**
 * Cross-entity search for the admin command palette. Hits the database
 * directly so results cover every record, not just what a client preloaded.
 */
@Injectable()
export class AdminSearchService {
  constructor(private readonly db: DatabaseService) {}

  async find(q: string): Promise<{
    schools: SearchHit[];
    teachers: SearchHit[];
    students: SearchHit[];
    courses: SearchHit[];
  }> {
    const query = q.trim();
    if (query.length < 2) {
      return { schools: [], teachers: [], students: [], courses: [] };
    }
    const contains = { contains: query, mode: 'insensitive' as const };
    const PER_TYPE = 8;

    const userWhere = (role: Role) => ({
      role,
      deletedAt: null,
      isActive: true,
      OR: [
        { email: contains },
        { profile: { is: { fullName: contains } } },
      ],
    });
    const userSelect = {
      id: true,
      email: true,
      profile: { select: { fullName: true } },
    };

    const [schools, teachers, students, courses] = await Promise.all([
      this.db.school.findMany({
        where: {
          deletedAt: null,
          OR: [{ name: contains }, { city: contains }, { schoolCode: contains }],
        },
        select: { id: true, name: true, city: true },
        take: PER_TYPE,
      }),
      this.db.user.findMany({ where: userWhere(Role.teacher), select: userSelect, take: PER_TYPE }),
      this.db.user.findMany({ where: userWhere(Role.student), select: userSelect, take: PER_TYPE }),
      this.db.course.findMany({
        where: { deletedAt: null, title: contains },
        select: { id: true, title: true, isPublished: true },
        take: PER_TYPE,
      }),
    ]);

    const mapUser = (u: (typeof teachers)[number]): SearchHit => ({
      id: String(u.id),
      label: u.profile?.fullName ?? u.email,
      sublabel: u.email,
    });

    return {
      schools: schools.map((s) => ({
        id: s.id,
        label: s.name,
        sublabel: s.city ?? null,
      })),
      teachers: teachers.map(mapUser),
      students: students.map(mapUser),
      courses: courses.map((c) => ({
        id: c.id,
        label: c.title,
        sublabel: c.isPublished ? 'Published' : 'Draft',
      })),
    };
  }
}
