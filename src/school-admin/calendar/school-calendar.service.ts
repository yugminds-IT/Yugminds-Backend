import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class SchoolCalendarService {
  constructor(private readonly db: DatabaseService) {}

  private async resolveSchoolId(userId: number): Promise<string> {
    const sa = await this.db.schoolAdmin.findFirst({
      where: { userId },
      select: { schoolId: true },
    });
    if (!sa?.schoolId)
      throw new ForbiddenException('No school assigned to your account');
    return sa.schoolId;
  }

  async list(
    userId: number,
    params?: { year?: string; month?: string; academicYear?: string },
  ) {
    const schoolId = await this.resolveSchoolId(userId);

    let dateFilter: { gte?: Date; lte?: Date } | undefined;

    if (params?.year && params?.month) {
      const y = parseInt(params.year);
      const m = parseInt(params.month);
      dateFilter = {
        gte: new Date(Date.UTC(y, m - 1, 1)),
        lte: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)),
      };
    } else if (params?.year) {
      const y = parseInt(params.year);
      dateFilter = {
        gte: new Date(Date.UTC(y, 0, 1)),
        lte: new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999)),
      };
    }

    const where: Record<string, unknown> = { schoolId, isActive: true };
    if (dateFilter) where.date = dateFilter;
    if (params?.academicYear) where.academicYear = params.academicYear;

    const entries = await this.db.schoolCalendar.findMany({
      where,
      orderBy: { date: 'asc' },
    });

    return {
      calendar: entries.map((e) => ({
        id: e.id,
        school_id: e.schoolId,
        date: e.date.toISOString().split('T')[0],
        end_date: e.endDate ? e.endDate.toISOString().split('T')[0] : null,
        name: e.name,
        type: e.type,
        academic_year: e.academicYear,
        description: e.description ?? null,
        created_at: e.createdAt.toISOString(),
      })),
    };
  }

  async create(
    userId: number,
    body: {
      date: string;
      end_date?: string;
      name: string;
      type: string;
      academic_year?: string;
      description?: string;
    },
  ) {
    const schoolId = await this.resolveSchoolId(userId);

    const validTypes = ['Holiday', 'Break', 'HalfDay', 'CompensatoryWork'];
    if (!validTypes.includes(body.type)) {
      throw new BadRequestException(
        `type must be one of: ${validTypes.join(', ')}`,
      );
    }

    if (!body.date) throw new BadRequestException('date is required');
    if (!body.name?.trim()) throw new BadRequestException('name is required');

    const date = new Date(body.date + 'T00:00:00.000Z');
    const endDate = body.end_date
      ? new Date(body.end_date + 'T00:00:00.000Z')
      : null;

    if (endDate && endDate < date) {
      throw new BadRequestException('end_date must be on or after date');
    }

    const entry = await this.db.schoolCalendar.create({
      data: {
        schoolId,
        date,
        endDate,
        name: body.name.trim(),
        type: body.type,
        academicYear: body.academic_year ?? '2024-25',
        description: body.description?.trim() ?? null,
      },
    });

    return {
      entry: {
        id: entry.id,
        school_id: entry.schoolId,
        date: entry.date.toISOString().split('T')[0],
        end_date: entry.endDate
          ? entry.endDate.toISOString().split('T')[0]
          : null,
        name: entry.name,
        type: entry.type,
        academic_year: entry.academicYear,
        description: entry.description ?? null,
        created_at: entry.createdAt.toISOString(),
      },
    };
  }

  async update(
    userId: number,
    id: string,
    body: {
      date?: string;
      end_date?: string | null;
      name?: string;
      type?: string;
      academic_year?: string;
      description?: string | null;
    },
  ) {
    const schoolId = await this.resolveSchoolId(userId);

    const existing = await this.db.schoolCalendar.findFirst({
      where: { id, schoolId },
    });
    if (!existing) throw new NotFoundException('Calendar entry not found');

    if (body.type) {
      const validTypes = ['Holiday', 'Break', 'HalfDay', 'CompensatoryWork'];
      if (!validTypes.includes(body.type)) {
        throw new BadRequestException(
          `type must be one of: ${validTypes.join(', ')}`,
        );
      }
    }

    const date = body.date ? new Date(body.date + 'T00:00:00.000Z') : undefined;
    const endDate =
      body.end_date === null
        ? null
        : body.end_date
          ? new Date(body.end_date + 'T00:00:00.000Z')
          : undefined;

    const updated = await this.db.schoolCalendar.update({
      where: { id },
      data: {
        ...(date && { date }),
        ...(endDate !== undefined && { endDate }),
        ...(body.name?.trim() && { name: body.name.trim() }),
        ...(body.type && { type: body.type }),
        ...(body.academic_year && { academicYear: body.academic_year }),
        ...(body.description !== undefined && {
          description: body.description?.trim() ?? null,
        }),
      },
    });

    return {
      entry: {
        id: updated.id,
        school_id: updated.schoolId,
        date: updated.date.toISOString().split('T')[0],
        end_date: updated.endDate
          ? updated.endDate.toISOString().split('T')[0]
          : null,
        name: updated.name,
        type: updated.type,
        academic_year: updated.academicYear,
        description: updated.description ?? null,
      },
    };
  }

  async remove(userId: number, id: string) {
    const schoolId = await this.resolveSchoolId(userId);
    const existing = await this.db.schoolCalendar.findFirst({
      where: { id, schoolId },
    });
    if (!existing) throw new NotFoundException('Calendar entry not found');

    await this.db.schoolCalendar.update({
      where: { id },
      data: { isActive: false },
    });

    return { success: true };
  }

  // Used by attendance service: returns all holiday/break dates for a school+month
  async getHolidayDatesForMonth(
    schoolId: string,
    year: number,
    month: number,
  ): Promise<{ date: string; type: string }[]> {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

    const entries = await this.db.schoolCalendar.findMany({
      where: {
        schoolId,
        isActive: true,
        type: { in: ['Holiday', 'Break', 'HalfDay'] },
        date: { lte: end },
        OR: [
          { endDate: null, date: { gte: start } },
          { endDate: { gte: start } },
        ],
      },
    });

    const dates: { date: string; type: string }[] = [];
    for (const entry of entries) {
      const rangeEnd = entry.endDate ?? entry.date;
      const cur = new Date(entry.date);
      while (cur <= rangeEnd && cur <= end) {
        if (cur >= start) {
          dates.push({
            date: cur.toISOString().split('T')[0],
            type: entry.type,
          });
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }

    return dates;
  }

  // Returns compensatory working dates (weekend days that are working days)
  async getCompensatoryDatesForMonth(
    schoolId: string,
    year: number,
    month: number,
  ): Promise<string[]> {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

    const entries = await this.db.schoolCalendar.findMany({
      where: {
        schoolId,
        isActive: true,
        type: 'CompensatoryWork',
        date: { gte: start, lte: end },
      },
    });

    const dates: string[] = [];
    for (const entry of entries) {
      const rangeEnd = entry.endDate ?? entry.date;
      const cur = new Date(entry.date);
      while (cur <= rangeEnd && cur <= end) {
        if (cur >= start) {
          dates.push(cur.toISOString().split('T')[0]);
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }

    return dates;
  }
}
