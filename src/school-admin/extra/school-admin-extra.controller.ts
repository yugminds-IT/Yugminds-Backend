import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  ForbiddenException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { DatabaseService } from '../../database/database.service';
import { PasswordResetRequestService } from '../../common/password-reset-request/password-reset-request.service';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { ResourceIdParamDto } from './dto/resource-id-param.dto';
import { DataImportDto } from './dto/data-import.dto';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { EnrollmentService } from '../../common/enrollment/enrollment.service';

interface PlaceholderResponse {
  endpoint: string;
  method: string;
  message: string;
}

function currentAcademicYear(): string {
  const now = new Date();
  const year = now.getFullYear();
  // Academic year starts in June; before June = previous year's cohort
  const start = now.getMonth() < 5 ? year - 1 : year;
  return `${start}-${String(start + 1).slice(-2)}`;
}

@SkipThrottle()
@Controller('school-admin')
@UseGuards(RolesGuard)
@Roles(Role.school_admin)
export class SchoolAdminExtraController {
  constructor(
    private readonly db: DatabaseService,
    private readonly passwordResetRequestService: PasswordResetRequestService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly enrollmentService: EnrollmentService,
  ) {}

  private buildResponse(endpoint: string, method: string): PlaceholderResponse {
    return {
      endpoint,
      method,
      message:
        'This endpoint is implemented as a placeholder. Replace with real business logic as needed.',
    };
  }

  /** Resolve school ID for the current school admin. */
  private async getSchoolId(userId: number): Promise<string | null> {
    const sa = await this.db.schoolAdmin.findFirst({
      where: { userId },
      select: { schoolId: true },
    });
    return sa?.schoolId ?? null;
  }

  // School & profile: GET school / GET stats handled by dedicated controllers.
  // PUT school / PUT profile remain optional placeholders.

  @SkipThrottle()
  @Get('profile')
  async getProfile(@CurrentUser() user: { id: number }) {
    const found = await this.db.user.findUnique({
      where: { id: user.id },
      include: { profile: true },
    });
    if (!found) throw new BadRequestException('User not found');
    // Strip both `password` (sensitive) and the Prisma `profile` relation
    // (it would shadow the flattened `full_name`/`phone` and collide with
    // any client code that treats `data.profile` as the user object).
    const {
      password: _password,
      profile: _profile,
      ...rest
    } = found as {
      password?: string;
      profile?: unknown;
      [key: string]: unknown;
    };
    return {
      ...rest,
      full_name: found.profile?.fullName ?? null,
      phone: found.profile?.phone ?? null,
    };
  }

  @Patch('profile')
  async patchProfile(
    @CurrentUser() user: { id: number },
    @Body() body: { full_name?: string; phone?: string },
  ) {
    const fullName =
      body?.full_name != null ? String(body.full_name).trim() : undefined;
    const phone = body?.phone != null ? String(body.phone).trim() : undefined;

    if (fullName !== undefined || phone !== undefined) {
      await this.db.profile.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          fullName: fullName ?? null,
          phone: phone ?? null,
        },
        update: {
          ...(fullName !== undefined && { fullName: fullName || null }),
          ...(phone !== undefined && { phone: phone || null }),
        },
      });
    }

    return { success: true };
  }

  // Rooms – full CRUD (school-scoped)

  @Get('rooms')
  async listRooms(@CurrentUser() user: { id: number }) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) return { rooms: [] };
    const rooms = await this.db.room.findMany({
      where: { schoolId },
      orderBy: { name: 'asc' },
    });
    return {
      rooms: rooms.map((r) => ({
        id: r.id,
        room_number: r.roomNumber ?? r.name,
        room_name: r.roomName ?? null,
        capacity: r.capacity ?? null,
        location: r.location ?? null,
        facilities: Array.isArray(r.facilities) ? r.facilities : [],
        school_id: r.schoolId,
        is_active: (r as { isActive?: boolean }).isActive !== false,
      })),
    };
  }

  @Get('rooms/:id')
  async getRoom(
    @CurrentUser() user: { id: number },
    @Param() params: ResourceIdParamDto,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const room = await this.db.room.findFirst({
      where: { id: params.id, schoolId },
    });
    if (!room) throw new BadRequestException('Room not found');
    return {
      room: {
        id: room.id,
        room_number: room.roomNumber ?? room.name,
        room_name: room.roomName ?? null,
        capacity: room.capacity ?? null,
        location: room.location ?? null,
        facilities: Array.isArray(room.facilities) ? room.facilities : [],
        school_id: room.schoolId,
        is_active: (room as { isActive?: boolean }).isActive !== false,
      },
    };
  }

  @Post('rooms')
  async createRoom(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      room_number?: string;
      room_name?: string;
      capacity?: number | string;
      location?: string;
      facilities?: string[];
      is_active?: boolean;
    },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const roomNumber = String(body?.room_number ?? '').trim();
    if (!roomNumber) throw new BadRequestException('room_number is required');
    const room = await this.db.room.create({
      data: {
        schoolId,
        name: roomNumber, // keep legacy field in sync
        roomNumber,
        roomName:
          body?.room_name != null ? String(body.room_name).trim() : null,
        capacity:
          body?.capacity != null && String(body.capacity).trim() !== ''
            ? Number(body.capacity)
            : null,
        location: body?.location != null ? String(body.location).trim() : null,
        facilities: Array.isArray(body?.facilities)
          ? body.facilities.map((s) => String(s).trim()).filter(Boolean)
          : [],
        isActive: typeof body?.is_active === 'boolean' ? body.is_active : true,
      },
    });
    return {
      room: {
        id: room.id,
        room_number: room.roomNumber ?? room.name,
        room_name: room.roomName ?? null,
        capacity: room.capacity ?? null,
        location: room.location ?? null,
        facilities: Array.isArray(room.facilities) ? room.facilities : [],
        school_id: room.schoolId,
        is_active: (room as { isActive?: boolean }).isActive !== false,
      },
    };
  }

  @Patch('rooms/:id')
  async updateRoom(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
    @Body()
    body: {
      room_number?: string;
      room_name?: string;
      capacity?: number | string | null;
      location?: string | null;
      facilities?: string[] | null;
      is_active?: boolean;
    },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const room = await this.db.room.findFirst({
      where: { id, schoolId },
    });
    if (!room) throw new BadRequestException('Room not found');
    const roomNumber =
      body?.room_number !== undefined
        ? String(body.room_number ?? '').trim()
        : undefined;
    if (roomNumber !== undefined && !roomNumber)
      throw new BadRequestException('room_number cannot be empty');
    const updated = await this.db.room.update({
      where: { id },
      data: {
        ...(roomNumber !== undefined && { roomNumber, name: roomNumber }),
        ...(body?.room_name !== undefined && {
          roomName:
            body.room_name == null ? null : String(body.room_name).trim(),
        }),
        ...(body?.capacity !== undefined && {
          capacity:
            body.capacity == null || String(body.capacity).trim() === ''
              ? null
              : Number(body.capacity),
        }),
        ...(body?.location !== undefined && {
          location: body.location == null ? null : String(body.location).trim(),
        }),
        ...(body?.facilities !== undefined && {
          facilities:
            body.facilities == null
              ? []
              : body.facilities.map((s) => String(s).trim()).filter(Boolean),
        }),
        ...(typeof body?.is_active === 'boolean'
          ? { isActive: body.is_active }
          : {}),
      },
    });
    return {
      room: {
        id: updated.id,
        room_number: updated.roomNumber ?? updated.name,
        room_name: updated.roomName ?? null,
        capacity: updated.capacity ?? null,
        location: updated.location ?? null,
        facilities: Array.isArray(updated.facilities) ? updated.facilities : [],
        school_id: updated.schoolId,
        is_active: (updated as { isActive?: boolean }).isActive !== false,
      },
    };
  }

  @Delete('rooms/:id')
  async deleteRoom(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const room = await this.db.room.findFirst({ where: { id, schoolId } });
    if (!room) throw new BadRequestException('Room not found');
    await this.db.room.delete({ where: { id } });
    return { success: true };
  }

  // Periods – full CRUD (school-scoped)

  @Get('periods')
  async listPeriods(@CurrentUser() user: { id: number }) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) return { periods: [] };
    const periods = await this.db.period.findMany({
      where: { schoolId },
      orderBy: { periodNumber: 'asc' },
    });
    return {
      periods: periods.map((p) => ({
        id: p.id,
        period_number: p.periodNumber,
        start_time: p.startTime,
        end_time: p.endTime,
        school_id: p.schoolId,
        is_active: (p as { isActive?: boolean }).isActive !== false,
      })),
    };
  }

  @Get('periods/:id')
  async getPeriod(
    @CurrentUser() user: { id: number },
    @Param() params: ResourceIdParamDto,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const period = await this.db.period.findFirst({
      where: { id: params.id, schoolId },
    });
    if (!period) throw new BadRequestException('Period not found');
    return {
      period: {
        id: period.id,
        period_number: period.periodNumber,
        start_time: period.startTime,
        end_time: period.endTime,
        school_id: period.schoolId,
        is_active: (period as { isActive?: boolean }).isActive !== false,
      },
    };
  }

  @Post('periods')
  async createPeriod(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      period_number?: number;
      start_time?: string;
      end_time?: string;
      is_active?: boolean;
    },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const periodNumber =
      body?.period_number != null ? Number(body.period_number) : 0;
    const startTime = String(body?.start_time ?? '').trim();
    const endTime = String(body?.end_time ?? '').trim();
    if (!startTime || !endTime)
      throw new BadRequestException('start_time and end_time are required');
    const period = await this.db.period.create({
      data: {
        schoolId,
        periodNumber,
        startTime,
        endTime,
        isActive: typeof body?.is_active === 'boolean' ? body.is_active : true,
      },
    });
    return {
      period: {
        id: period.id,
        period_number: period.periodNumber,
        start_time: period.startTime,
        end_time: period.endTime,
        school_id: period.schoolId,
        is_active: (period as { isActive?: boolean }).isActive !== false,
      },
    };
  }

  @Patch('periods/:id')
  async updatePeriod(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
    @Body()
    body: {
      period_number?: number;
      start_time?: string;
      end_time?: string;
      is_active?: boolean;
    },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const period = await this.db.period.findFirst({ where: { id, schoolId } });
    if (!period) throw new BadRequestException('Period not found');
    const updated = await this.db.period.update({
      where: { id },
      data: {
        ...(body?.period_number !== undefined && {
          periodNumber: Number(body.period_number),
        }),
        ...(body?.start_time !== undefined && {
          startTime: String(body.start_time).trim(),
        }),
        ...(body?.end_time !== undefined && {
          endTime: String(body.end_time).trim(),
        }),
        ...(typeof body?.is_active === 'boolean'
          ? { isActive: body.is_active }
          : {}),
      },
    });
    return {
      period: {
        id: updated.id,
        period_number: updated.periodNumber,
        start_time: updated.startTime,
        end_time: updated.endTime,
        school_id: updated.schoolId,
        is_active: (updated as { isActive?: boolean }).isActive !== false,
      },
    };
  }

  @Delete('periods/:id')
  async deletePeriod(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const period = await this.db.period.findFirst({ where: { id, schoolId } });
    if (!period) throw new BadRequestException('Period not found');
    await this.db.period.delete({ where: { id } });
    return { success: true };
  }

  // Teachers – list (school-scoped). School admins cannot create teachers.

  @Get('teachers')
  async listTeachers(
    @CurrentUser() user: { id: number },
    @Query('limit') limit?: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) return { teachers: [] };
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100)
      : 50;

    const teacherSchools = await this.db.teacherSchool.findMany({
      where: { schoolId },
      take,
      include: {
        teacher: {
          include: {
            profile: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const teacherIds = teacherSchools.map((ts) => ts.teacherId);
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [attendanceAgg, leavesAgg] = await Promise.all([
      this.db.attendance.groupBy({
        by: ['teacherId', 'status'],
        where: {
          schoolId,
          teacherId: { in: teacherIds },
          date: { gte: since },
        },
        _count: { _all: true },
      }),
      this.db.teacherLeave.groupBy({
        by: ['teacherId', 'status'],
        where: { schoolId, teacherId: { in: teacherIds } },
        _count: { _all: true },
      }),
    ]);

    const attendanceByTeacher: Record<
      number,
      { present: number; total: number }
    > = {};
    for (const row of attendanceAgg ?? []) {
      const t = row.teacherId;
      if (!attendanceByTeacher[t])
        attendanceByTeacher[t] = { present: 0, total: 0 };
      const count = row._count?._all ?? 0;
      attendanceByTeacher[t].total += count;
      if (String(row.status ?? '').toLowerCase() === 'present')
        attendanceByTeacher[t].present += count;
    }

    const leavesByTeacher: Record<number, number> = {};
    for (const row of leavesAgg ?? []) {
      const t = row.teacherId;
      const status = String(row.status ?? '').toLowerCase();
      if (status !== 'approved') continue;
      const count = row._count?._all ?? 0;
      leavesByTeacher[t] = (leavesByTeacher[t] ?? 0) + count;
    }

    return {
      teachers: teacherSchools.map((ts) => {
        const u = ts.teacher;
        const p = u?.profile;
        const att = attendanceByTeacher[ts.teacherId] ?? {
          present: 0,
          total: 0,
        };
        const attendancePercentage =
          att.total > 0 ? Math.round((att.present / att.total) * 100) : 0;
        const expYears = (() => {
          const raw = String(p?.experience ?? '').trim();
          const n = parseInt(raw, 10);
          return Number.isFinite(n) ? n : 0;
        })();
        return {
          id: String(u?.id ?? ts.teacherId),
          teacher_id: `TCH-${String(u?.id ?? ts.teacherId).slice(0, 8)}`,
          full_name: p?.fullName ?? u?.email ?? '',
          email: u?.email ?? '',
          phone: p?.phone ?? '',
          qualification: p?.qualification ?? '',
          experience_years: expYears,
          specialization: p?.specialization ?? '',
          status: u?.isActive === false ? 'Inactive' : 'Active',
          created_at:
            u?.createdAt?.toISOString?.() ?? ts.createdAt.toISOString(),
          attendance_percentage: attendancePercentage,
          leaves_taken: leavesByTeacher[ts.teacherId] ?? 0,
          teacher_schools: [
            {
              grades_assigned: Array.isArray(ts.gradesAssigned)
                ? ts.gradesAssigned
                : [],
              subjects: Array.isArray(ts.subjects) ? ts.subjects : [],
              working_days_per_week: ts.workingDaysPerWeek ?? 5,
              max_students_per_session: 30,
            },
          ],
        };
      }),
    };
  }

  // Students – list + create (school-scoped)

  @Get('students')
  async listStudents(
    @CurrentUser() user: { id: number },
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('q') q?: string,
    @Query('grade') grade?: string,
    @Query('section') section?: string,
    @Query('status') status?: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) return { students: [], page: 1, limit: 0, total: 0 };
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
      : 50;
    const pageNum = page ? Math.max(parseInt(page, 10) || 1, 1) : 1;
    const skip = (pageNum - 1) * take;
    const query = String(q ?? '').trim();
    const gradeFilter = String(grade ?? '').trim();
    const sectionFilter = String(section ?? '').trim();
    const statusFilter = String(status ?? '').trim(); // active|inactive|all

    const studentSchoolWhere: {
      schoolId: string;
      grade?: string;
      section?: string;
      isActive?: boolean;
    } = { schoolId };
    if (gradeFilter && gradeFilter !== 'all')
      studentSchoolWhere.grade = gradeFilter;
    if (sectionFilter && sectionFilter !== 'all')
      studentSchoolWhere.section = sectionFilter;
    if (statusFilter === 'active') studentSchoolWhere.isActive = true;
    if (statusFilter === 'inactive') studentSchoolWhere.isActive = false;

    const where = {
      role: Role.student,
      studentSchools: { some: studentSchoolWhere },
      ...(query
        ? {
            OR: [
              { email: { contains: query, mode: 'insensitive' as const } },
              {
                profile: {
                  is: {
                    fullName: { contains: query, mode: 'insensitive' as const },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const total = await this.db.user.count({ where });
    const users = await this.db.user.findMany({
      where,
      take,
      skip,
      include: {
        profile: true,
        studentSchools: { where: { schoolId }, include: { school: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const students = users.map((u) => {
      const ss = (u.studentSchools ?? []).find((s) => s.schoolId === schoolId);
      const profileId = u.profile?.id ?? null;
      return {
        id: u.id,
        grade: ss?.grade ?? null,
        section: ss?.section ?? null,
        joining_code: ss?.joiningCode ?? null,
        school_id: schoolId,
        school_name: ss?.school?.name ?? null,
        is_active: ss?.isActive ?? true,
        enrolled_at: ss?.createdAt ?? null,
        profile_id: profileId,
        profile: {
          id: profileId,
          email: u.email,
          full_name: u.profile?.fullName ?? '',
          parent_name: u.profile?.parentName ?? null,
          parent_phone: u.profile?.parentPhone ?? null,
          created_at: u.profile?.createdAt ?? null,
        },
      };
    });
    return { students, page: pageNum, limit: take, total };
  }

  @Post('students')
  async createStudents(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      email?: string;
      password?: string;
      full_name?: string;
      parent_name?: string;
      parent_phone?: string;
      grade?: string;
      section?: string;
      joining_code?: string;
    },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const email = String(body?.email ?? '').trim();
    const password = body?.password;
    if (!email || !password)
      throw new BadRequestException('Email and password are required');
    const existing = await this.db.user.findUnique({ where: { email } });
    if (existing) throw new BadRequestException('Email already exists');
    const hash = await bcrypt.hash(password, 10);
    const newUser = await this.db.user.create({
      data: {
        email,
        password: hash,
        role: Role.student,
        tenantId: schoolId,
      },
    });
    const profile = await this.db.profile.upsert({
      where: { userId: newUser.id },
      create: {
        userId: newUser.id,
        fullName: body?.full_name ?? null,
        parentName: body?.parent_name ?? null,
        parentPhone: body?.parent_phone ?? null,
        schoolId,
      },
      update: {
        fullName: body?.full_name ?? null,
        parentName: body?.parent_name ?? null,
        parentPhone: body?.parent_phone ?? null,
      },
    });
    const enrollment = await this.db.studentSchool.create({
      data: {
        studentId: newUser.id,
        schoolId,
        grade: body?.grade ?? null,
        section: body?.section ?? null,
        joiningCode: body?.joining_code ?? null,
        isActive: true,
      },
    });

    // Auto-enroll in courses for the school + grade
    await this.enrollmentService.enrollStudentInRelevantCourses(
      newUser.id,
      schoolId,
      body?.grade ?? null,
    );
    return {
      success: true,
      student: {
        id: newUser.id,
        grade: body?.grade ?? null,
        section: body?.section ?? null,
        joining_code: enrollment.joiningCode ?? null,
        school_id: schoolId,
        is_active: true,
        enrolled_at: enrollment.createdAt,
        profile_id: profile.id,
        profile: {
          id: profile.id,
          email: newUser.email,
          full_name: profile.fullName ?? '',
          parent_name: profile.parentName ?? null,
          parent_phone: profile.parentPhone ?? null,
          created_at: profile.createdAt,
        },
      },
    };
  }

  @Post('students/bulk-import')
  async bulkImportStudents(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      students?: Array<{
        email?: string;
        password?: string;
        full_name?: string;
        parent_name?: string;
        parent_phone?: string;
        grade?: string;
        section?: string;
        joining_code?: string;
        is_active?: boolean;
      }>;
      dry_run?: boolean;
    },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');

    const rows = Array.isArray(body?.students) ? body.students : [];
    if (rows.length === 0)
      throw new BadRequestException('No students provided');
    if (rows.length > 500)
      throw new BadRequestException(
        'Bulk import limit is 500 students per request',
      );

    const dryRun = Boolean(body?.dry_run);

    const genPassword = () => {
      const buf = randomBytes(9).toString('base64').replace(/[+/=]/g, '');
      return `Ym${buf}A1!`;
    };

    const results: Array<{
      index: number;
      email: string | null;
      success: boolean;
      error?: string;
      student_id?: number;
      generated_password?: string;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] ?? {};
      const email = String(r.email ?? '')
        .trim()
        .toLowerCase();
      const password = String(r.password ?? '').trim();

      if (!email) {
        results.push({
          index: i,
          email: null,
          success: false,
          error: 'Email is required',
        });
        continue;
      }

      const exists = await this.db.user.findUnique({ where: { email } });
      if (exists) {
        results.push({
          index: i,
          email,
          success: false,
          error: 'Email already exists',
        });
        continue;
      }

      const effectivePassword = password || genPassword();
      const hash = await bcrypt.hash(effectivePassword, 10);

      if (dryRun) {
        results.push({
          index: i,
          email,
          success: true,
          generated_password: password ? undefined : effectivePassword,
        });
        continue;
      }

      try {
        const created = await this.db.$transaction(async (tx) => {
          const newUser = await tx.user.create({
            data: {
              email,
              password: hash,
              role: Role.student,
              tenantId: schoolId,
              isActive: typeof r.is_active === 'boolean' ? r.is_active : true,
            },
          });

          // Validate cross-tenant ownership using tx so the newly created user
          // (not yet committed) is visible to the lookup.
          await this.db.assertCrossTenantUserIds(
            [newUser.id],
            schoolId,
            tx as any,
          );

          const profile = await tx.profile.upsert({
            where: { userId: newUser.id },
            create: {
              userId: newUser.id,
              fullName: r.full_name ?? null,
              parentName: r.parent_name ?? null,
              parentPhone: r.parent_phone ?? null,
              schoolId,
            },
            update: {
              fullName: r.full_name ?? null,
              parentName: r.parent_name ?? null,
              parentPhone: r.parent_phone ?? null,
            },
          });

          await tx.studentSchool.create({
            data: {
              studentId: newUser.id,
              schoolId,
              grade: r.grade ?? null,
              section: r.section ?? null,
              joiningCode: r.joining_code ?? null,
              isActive: typeof r.is_active === 'boolean' ? r.is_active : true,
            },
          });

          // Auto-enroll in courses for the school + grade
          await this.enrollmentService.enrollStudentInRelevantCourses(
            newUser.id,
            schoolId,
            r.grade ?? null,
          );

          return { userId: newUser.id, profileId: profile.id };
        });

        results.push({
          index: i,
          email,
          success: true,
          student_id: created.userId,
          generated_password: password ? undefined : effectivePassword,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Failed to create student';
        results.push({ index: i, email, success: false, error: msg });
      }
    }

    const summary = {
      total: results.length,
      success: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      generated_passwords: results.filter(
        (r) => r.success && r.generated_password,
      ).length,
      dry_run: dryRun,
    };

    return { success: true, summary, results };
  }

  @Patch('students/:studentId')
  async updateStudent(
    @CurrentUser() user: { id: number },
    @Param('studentId') studentIdParam: string,
    @Body()
    body: {
      email?: string;
      full_name?: string;
      parent_name?: string;
      parent_phone?: string;
      grade?: string;
      section?: string | null;
      joining_code?: string | null;
      is_active?: boolean;
    },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const studentId = parseInt(String(studentIdParam), 10);
    if (!Number.isFinite(studentId) || studentId <= 0)
      throw new BadRequestException('Invalid student id');

    const existing = await this.db.user.findFirst({
      where: {
        id: studentId,
        role: Role.student,
        studentSchools: { some: { schoolId } },
      },
      include: { profile: true, studentSchools: { where: { schoolId } } },
    });
    if (!existing)
      throw new BadRequestException('Student not found in your school');

    const nextEmail =
      body?.email != null ? String(body.email).trim() : undefined;
    if (nextEmail && nextEmail !== existing.email) {
      const conflict = await this.db.user.findUnique({
        where: { email: nextEmail },
      });
      if (conflict) throw new BadRequestException('Email already exists');
    }

    const enrollment = (existing.studentSchools ?? [])[0];
    if (!enrollment) throw new BadRequestException('Enrollment not found');

    const hasProfilePatch =
      body.full_name !== undefined ||
      body.parent_name !== undefined ||
      body.parent_phone !== undefined;

    const enrollmentPatch: {
      grade?: string | null;
      section?: string | null;
      joiningCode?: string | null;
      isActive?: boolean;
    } = {};
    if (body.grade !== undefined) enrollmentPatch.grade = body.grade;
    if (body.section !== undefined) enrollmentPatch.section = body.section;
    if (body.joining_code !== undefined)
      enrollmentPatch.joiningCode = body.joining_code;
    if (typeof body.is_active === 'boolean')
      enrollmentPatch.isActive = body.is_active;

    const updated = await this.db.$transaction(async (tx) => {
      const u = nextEmail
        ? await tx.user.update({
            where: { id: studentId },
            data: { email: nextEmail },
          })
        : await tx.user.findUniqueOrThrow({ where: { id: studentId } });

      let p = existing.profile;
      if (hasProfilePatch) {
        p = await tx.profile.upsert({
          where: { userId: studentId },
          create: {
            userId: studentId,
            fullName:
              body.full_name !== undefined
                ? (body.full_name ?? null)
                : (existing.profile?.fullName ?? null),
            parentName:
              body.parent_name !== undefined
                ? (body.parent_name ?? null)
                : (existing.profile?.parentName ?? null),
            parentPhone:
              body.parent_phone !== undefined
                ? (body.parent_phone ?? null)
                : (existing.profile?.parentPhone ?? null),
            schoolId,
          },
          update: {
            ...(body.full_name !== undefined && {
              fullName: body.full_name ?? null,
            }),
            ...(body.parent_name !== undefined && {
              parentName: body.parent_name ?? null,
            }),
            ...(body.parent_phone !== undefined && {
              parentPhone: body.parent_phone ?? null,
            }),
          },
        });
      }

      let ss = enrollment;
      if (Object.keys(enrollmentPatch).length > 0) {
        ss = await tx.studentSchool.update({
          where: { id: enrollment.id },
          data: enrollmentPatch,
        });
      }

      return { u, p, ss };
    });

    // If grade changed, auto-enroll in courses for the new grade
    if (body.grade !== undefined && body.grade !== enrollment.grade) {
      await this.enrollmentService.enrollStudentInRelevantCourses(
        studentId,
        schoolId,
        body.grade,
      );
    }

    const prof = updated.p;
    return {
      success: true,
      student: {
        id: updated.u.id,
        profile_id: prof?.id ?? null,
        grade: updated.ss.grade,
        section: updated.ss.section,
        joining_code: updated.ss.joiningCode,
        school_id: schoolId,
        is_active: updated.ss.isActive,
        enrolled_at: updated.ss.createdAt,
        profile: {
          id: prof?.id ?? '',
          email: updated.u.email,
          full_name: prof?.fullName ?? '',
          parent_name: prof?.parentName ?? null,
          parent_phone: prof?.parentPhone ?? null,
          created_at: prof?.createdAt ?? null,
        },
      },
    };
  }

  @Patch('students/:studentId/password')
  async changeStudentPassword(
    @CurrentUser() user: { id: number },
    @Param('studentId') studentIdParam: string,
    @Body() body: { password?: string },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const studentId = parseInt(String(studentIdParam), 10);
    if (!Number.isFinite(studentId) || studentId <= 0)
      throw new BadRequestException('Invalid student id');

    const password = String(body?.password ?? '');
    if (!password) throw new BadRequestException('Password is required');

    const existing = await this.db.user.findFirst({
      where: {
        id: studentId,
        role: Role.student,
        studentSchools: { some: { schoolId } },
      },
      select: { id: true },
    });
    if (!existing)
      throw new BadRequestException('Student not found in your school');

    const hash = await bcrypt.hash(password, 10);
    await this.db.user.update({
      where: { id: studentId },
      data: { password: hash },
    });
    return { success: true };
  }

  @Delete('students/:studentId')
  async deleteStudent(
    @CurrentUser() user: { id: number },
    @Param('studentId') studentIdParam: string,
    @Query('hard') hard?: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const studentId = parseInt(String(studentIdParam), 10);
    if (!Number.isFinite(studentId) || studentId <= 0)
      throw new BadRequestException('Invalid student id');
    const doHard = String(hard ?? 'true') === 'true';

    const existing = await this.db.user.findFirst({
      where: {
        id: studentId,
        role: Role.student,
        studentSchools: { some: { schoolId } },
      },
      include: { studentSchools: { where: { schoolId } } },
    });
    if (!existing)
      throw new BadRequestException('Student not found in your school');

    if (doHard) {
      try {
        await this.db.user.delete({ where: { id: studentId } });
      } catch (err: unknown) {
        // P2025 = record not found (already deleted) — treat as success
        const code = (err as { code?: string })?.code;
        if (code !== 'P2025') throw err;
      }
      return { success: true, deleted: true };
    }

    const enrollment = (existing.studentSchools ?? [])[0];
    if (enrollment) {
      await this.db.studentSchool.update({
        where: { id: enrollment.id },
        data: { isActive: false },
      });
    }
    await this.db.user.update({
      where: { id: studentId },
      data: { isActive: false },
    });
    return { success: true, deleted: false, deactivated: true };
  }

  @Get('student-progress')
  async getStudentProgress(
    @CurrentUser() user: { id: number },
    @Query('course_id') courseId?: string,
    @Query('student_id') studentId?: string,
    @Query('grade') grade?: string,
    @Query('section') section?: string,
  ) {
    const schoolAdmin = await this.db.schoolAdmin.findFirst({
      where: { userId: user.id },
    });
    const schoolId = schoolAdmin?.schoolId;
    if (!schoolId) {
      return {
        students: [],
        teachers: [],
        courses: [],
        summary: {
          total_students: 0,
          students_with_progress: 0,
          students_completed: 0,
          average_system_progress: 0,
          total_courses: 0,
        },
      };
    }
    const schoolFilter: { schoolId: string; grade?: string; section?: string } =
      { schoolId };
    if (grade) schoolFilter.grade = grade;
    if (section) schoolFilter.section = section;

    const studentWhere: {
      role: Role;
      id?: number;
      studentSchools: { some: typeof schoolFilter };
    } = {
      role: Role.student,
      studentSchools: { some: schoolFilter },
    };
    if (studentId) {
      studentWhere.id = parseInt(studentId, 10) || 0;
    }
    const allStudentsFiltered = await this.db.user.findMany({
      where: studentWhere,
      include: { profile: true, studentSchools: true },
      orderBy: { createdAt: 'desc' },
    });
    const studentIds = allStudentsFiltered.map((u) => u.id);
    if (studentIds.length === 0) {
      return {
        students: [],
        teachers: [],
        courses: [],
        summary: {
          total_students: 0,
          students_with_progress: 0,
          students_completed: 0,
          average_system_progress: 0,
          total_courses: 0,
        },
      };
    }
    const [studentCourses, courseProgress] = await Promise.all([
      this.db.studentCourse.findMany({
        where: {
          studentId: { in: studentIds },
          ...(courseId ? { courseId } : {}),
        },
      }),
      this.db.courseProgress.findMany({
        where: {
          studentId: { in: studentIds },
          ...(courseId ? { courseId } : {}),
        },
      }),
    ]);
    const courseIdsForQuery = Array.from(
      new Set<string>(studentCourses.map((sc) => sc.courseId)),
    );
    const [courses, schools] = await Promise.all([
      this.db.course.findMany({
        where: courseIdsForQuery.length
          ? { id: { in: courseIdsForQuery } }
          : undefined,
      }),
      this.db.school.findMany({
        where: { id: schoolId },
      }),
    ]);
    const [allChapters, allContents] = courseIdsForQuery.length
      ? await Promise.all([
          this.db.chapter.findMany({
            where: { courseId: { in: courseIdsForQuery } },
            select: { id: true, courseId: true },
          }),
          this.db.chapterContent.findMany({
            where: { chapter: { courseId: { in: courseIdsForQuery } } },
            select: { id: true, chapterId: true },
          }),
        ])
      : [[], []];

    // Build content lookup maps
    const chapterToCourseS = new Map(
      allChapters.map((ch) => [ch.id, ch.courseId]),
    );
    const contentsByCourseS = new Map<
      string,
      Array<{ id: string; chapterId: string }>
    >();
    for (const c of allContents) {
      const cid = chapterToCourseS.get(c.chapterId);
      if (!cid) continue;
      const arr = contentsByCourseS.get(cid) ?? [];
      arr.push(c);
      contentsByCourseS.set(cid, arr);
    }
    const chaptersByCourseS = new Map<string, Array<{ id: string }>>();
    for (const ch of allChapters) {
      const arr = chaptersByCourseS.get(ch.courseId) ?? [];
      arr.push(ch);
      chaptersByCourseS.set(ch.courseId, arr);
    }

    const courseById = new Map(courses.map((c) => [c.id, c]));
    const schoolById = new Map(schools.map((s) => [s.id, s]));
    const studentsDto = allStudentsFiltered.map((u) => {
      const primarySchool = (u.studentSchools ?? [])[0];
      const school = primarySchool
        ? schoolById.get(primarySchool.schoolId)
        : undefined;
      const studentCourseForUser = studentCourses.filter(
        (sc) => sc.studentId === u.id,
      );
      const progressForUser = courseProgress.filter(
        (cp) => cp.studentId === u.id,
      );
      const courseIdsForStudent = Array.from(
        new Set<string>(studentCourseForUser.map((sc) => sc.courseId)),
      );
      const coursesForStudent = courseIdsForStudent.map((cid) => {
        const course = courseById.get(cid);
        const progressEntries = progressForUser.filter(
          (cp) => cp.courseId === cid,
        );
        const last = progressEntries.reduce<Date | null>((latest, p) => {
          const ts = p.completedAt ?? p.updatedAt;
          return !latest ? ts : ts > latest ? ts : latest;
        }, null);

        // Content-item based progress (matches student's own view)
        const courseContents = contentsByCourseS.get(cid) ?? [];
        const totalContentItems = courseContents.length;
        const completedContentIds = new Set(
          progressEntries
            .filter(
              (p) =>
                (p as any).contentId && (p.progress >= 99 || p.completedAt),
            )
            .map((p) => (p as any).contentId as string),
        );
        const completedChapterIds = new Set(
          progressEntries
            .filter((p) => {
              const cntId = (p as any).contentId;
              return (
                (!cntId || cntId === '' || cntId === 'null') &&
                p.chapterId &&
                p.progress >= 99
              );
            })
            .map((p) => p.chapterId as string),
        );
        let hybridCompleted = 0;
        for (const c of courseContents) {
          if (
            completedContentIds.has(c.id) ||
            completedChapterIds.has(c.chapterId)
          ) {
            hybridCompleted++;
          }
        }
        const progressPercentage =
          totalContentItems > 0
            ? Math.min(
                100,
                Math.round((hybridCompleted / totalContentItems) * 100),
              )
            : progressEntries.some((p) => p.progress >= 99)
              ? 100
              : 0;

        // Completed chapters: all contents done OR explicitly marked
        const courseChapters = chaptersByCourseS.get(cid) ?? [];
        const chapterContentsMap = new Map<string, string[]>();
        for (const c of courseContents) {
          const arr = chapterContentsMap.get(c.chapterId) ?? [];
          arr.push(c.id);
          chapterContentsMap.set(c.chapterId, arr);
        }
        let completedChapters = 0;
        for (const ch of courseChapters) {
          const chContents = chapterContentsMap.get(ch.id) ?? [];
          const chDone = completedChapterIds.has(ch.id);
          if (chContents.length > 0) {
            const allDone = chContents.every((id) =>
              completedContentIds.has(id),
            );
            if (allDone || chDone) completedChapters++;
          } else if (chDone) {
            completedChapters++;
          }
        }

        const status: 'completed' | 'in_progress' | 'not_started' =
          progressPercentage >= 100
            ? 'completed'
            : progressPercentage > 0
              ? 'in_progress'
              : 'not_started';
        return {
          course_id: cid,
          course_name: course?.title ?? '',
          total_chapters: courseChapters.length,
          completed_chapters: completedChapters,
          progress_percentage: progressPercentage,
          last_accessed: last ? last.toISOString() : '',
          enrolled_on:
            studentCourseForUser
              .find((sc) => sc.courseId === cid)
              ?.enrolledAt.toISOString() ?? '',
          status,
        };
      });
      const totalCourses = coursesForStudent.length;
      const completedCourses = coursesForStudent.filter(
        (c) => c.status === 'completed',
      ).length;
      const avgStudentProgress =
        totalCourses > 0
          ? coursesForStudent.reduce(
              (sum, c) => sum + c.progress_percentage,
              0,
            ) / totalCourses
          : 0;
      const lastActivity = coursesForStudent.reduce<Date | null>(
        (latest, c) => {
          if (!c.last_accessed) return latest;
          const d = new Date(c.last_accessed);
          return !latest || d > latest ? d : latest;
        },
        null,
      );
      return {
        student_id: String(u.id),
        full_name: u.profile?.fullName ?? '',
        email: u.email,
        grade: primarySchool?.grade ?? '',
        section: primarySchool?.section ?? undefined,
        school_id: primarySchool?.schoolId,
        school_name: school?.name,
        total_courses: totalCourses,
        completed_courses: completedCourses,
        in_progress_courses: coursesForStudent.filter(
          (c) => c.status === 'in_progress',
        ).length,
        average_progress: Number(avgStudentProgress.toFixed(2)),
        courses: coursesForStudent,
        last_activity: lastActivity,
      };
    });
    const studentsWithProgress = studentsDto.filter((s) => s.total_courses > 0);
    const studentsCompleted = studentsDto.filter(
      (s) => s.total_courses > 0 && s.completed_courses === s.total_courses,
    );
    const averageSystemProgress =
      studentsDto.length > 0
        ? studentsDto.reduce((sum, s) => sum + s.average_progress, 0) /
          studentsDto.length
        : 0;
    const teachers = await this.db.teacherSchool.findMany({
      where: { schoolId },
      include: { teacher: { include: { profile: true } } },
    });
    const allCourseIds = Array.from(
      new Set<string>(studentCourses.map((sc) => sc.courseId)),
    );
    const coursesDto = allCourseIds.map((cid) => {
      const course = courseById.get(cid);
      const enrolled = studentCourses.filter((sc) => sc.courseId === cid);
      const enrolledStudentIds = new Set(enrolled.map((sc) => sc.studentId));
      let completedCount = 0;
      let sumProgress = 0;
      let countProgress = 0;
      for (const s of studentsDto) {
        if (!enrolledStudentIds.has(Number(s.student_id))) continue;
        if (s.total_courses === 0) continue;
        const courseProgressEntry = s.courses.find((c) => c.course_id === cid);
        if (!courseProgressEntry) continue;
        sumProgress += courseProgressEntry.progress_percentage;
        countProgress += 1;
        if (courseProgressEntry.status === 'completed') completedCount += 1;
      }
      const enrolledCount = enrolledStudentIds.size;
      const averageProgress =
        countProgress > 0 ? sumProgress / countProgress : 0;
      const completionRate =
        enrolledCount > 0 ? (completedCount / enrolledCount) * 100 : 0;
      return {
        course_id: cid,
        course_name: course?.title ?? '',
        grade: '',
        total_chapters: chaptersByCourseS.get(cid)?.length ?? 0,
        enrolled_students: enrolledCount,
        completed_students: completedCount,
        average_progress: Number(averageProgress.toFixed(2)),
        completion_rate: Number(completionRate.toFixed(2)),
      };
    });
    return {
      students: studentsDto,
      teachers: teachers.map((t) => ({
        teacher_id: String(t.teacherId),
        full_name: t.teacher?.profile?.fullName ?? '',
        email: t.teacher?.email ?? '',
      })),
      courses: coursesDto,
      summary: {
        total_students: studentsDto.length,
        students_with_progress: studentsWithProgress.length,
        students_completed: studentsCompleted.length,
        average_system_progress: Number(averageSystemProgress.toFixed(2)),
        average_school_progress: Number(averageSystemProgress.toFixed(2)),
        total_courses: allCourseIds.length,
      },
    };
  }

  // Courses – list (school’s courses via CourseAccess) + progress

  @Get('courses')
  async listCourses(
    @CurrentUser() user: { id: number },
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) return { courses: [] };
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100)
      : 100;
    const access = await this.db.courseAccess.findMany({
      where: { schoolId },
      take,
      include: {
        course: {
          include: {
            chapters: {
              orderBy: { sortOrder: 'asc' },
              include: { contents: { orderBy: { sortOrder: 'asc' }, take: 1 } },
            },
            _count: { select: { chapters: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // derive grades from enrolled students' school enrollment
    const courseIds = access.map((a) => a.courseId);
    const enrollments = courseIds.length
      ? await this.db.studentCourse.findMany({
          where: { courseId: { in: courseIds } },
        })
      : [];
    const studentIds = Array.from(new Set(enrollments.map((e) => e.studentId)));
    const studentSchools = studentIds.length
      ? await this.db.studentSchool.findMany({
          where: { schoolId, studentId: { in: studentIds } },
          select: { studentId: true, grade: true },
        })
      : [];
    const gradeByStudentId = new Map(
      studentSchools.map((ss) => [ss.studentId, ss.grade ?? '']),
    );

    let courses = access.map((a) => {
      const enrolled = enrollments.filter((e) => e.courseId === a.courseId);
      const grades = Array.from(
        new Set(
          enrolled
            .map((e) => gradeByStudentId.get(e.studentId) ?? '')
            .filter((g) => String(g).trim().length > 0),
        ),
      ).sort();
      return {
        id: a.course.id,
        title: a.course.title,
        course_name: a.course.title,
        description: a.course.description ?? '',
        status: a.course.isPublished ? 'Published' : 'Draft',
        num_chapters: a.course._count.chapters,
        school_id: schoolId,
        grades,
        chapters: (a.course.chapters ?? []).map((ch) => {
          const c0 = (ch.contents ?? [])[0];
          return {
            id: ch.id,
            order_number: ch.sortOrder,
            title: ch.title,
            learning_outcomes: [],
            content_type: c0?.contentType ?? 'material',
            content_url: c0?.contentUrl ?? '',
            content_description: c0?.contentText ?? '',
            is_published: a.course.isPublished,
            created_at: ch.createdAt.toISOString(),
          };
        }),
        created_at: a.course.createdAt.toISOString(),
        updated_at: a.course.updatedAt.toISOString(),
      };
    });
    if (status === 'Published')
      courses = courses.filter((c) => c.status === 'Published');
    if (status === 'Draft')
      courses = courses.filter((c) => c.status === 'Draft');
    return { courses };
  }

  @Get('courses/progress')
  async getCoursesProgress(@CurrentUser() user: { id: number }) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) return { progress: [] };
    const access = await this.db.courseAccess.findMany({
      where: { schoolId },
      include: { course: true },
    });
    const courseIds = access.map((a) => a.courseId);
    if (courseIds.length === 0) return { progress: [] };
    const enrollments = await this.db.studentCourse.findMany({
      where: { courseId: { in: courseIds } },
    });
    const allStudentIds = Array.from(
      new Set(enrollments.map((e) => e.studentId)),
    );
    const studentSchools = allStudentIds.length
      ? await this.db.studentSchool.findMany({
          where: { schoolId, studentId: { in: allStudentIds } },
          select: { studentId: true, grade: true },
        })
      : [];
    const gradeByStudentId = new Map(
      studentSchools.map((ss) => [ss.studentId, ss.grade ?? '']),
    );

    const progressRows = allStudentIds.length
      ? await this.db.courseProgress.findMany({
          where: {
            courseId: { in: courseIds },
            studentId: { in: allStudentIds },
          },
        })
      : [];

    const chapters = await this.db.chapter.findMany({
      where: { courseId: { in: courseIds } },
      select: { id: true, courseId: true },
    });
    const totalChaptersByCourse: Record<string, number> = {};
    for (const ch of chapters) {
      totalChaptersByCourse[ch.courseId] =
        (totalChaptersByCourse[ch.courseId] ?? 0) + 1;
    }

    // chapter completion per student per course (distinct chapterId with progress >= 99)
    const completedChaptersSetByStudentCourse: Record<string, Set<string>> = {};
    for (const r of progressRows) {
      if (!r.chapterId) continue;
      if (r.progress < 99) continue;
      const key = `${r.courseId}:${r.studentId}`;
      if (!completedChaptersSetByStudentCourse[key])
        completedChaptersSetByStudentCourse[key] = new Set();
      completedChaptersSetByStudentCourse[key].add(String(r.chapterId));
    }

    const byCourse: Record<
      string,
      {
        studentIds: number[];
        sum: number;
        count: number;
        completedSet: Set<number>;
        byGrade: Record<
          string,
          { total: number; completed: number; sum: number; count: number }
        >;
        completedChaptersSum: number;
      }
    > = {};
    for (const cid of courseIds) {
      byCourse[cid] = {
        studentIds: [],
        sum: 0,
        count: 0,
        completedSet: new Set(),
        byGrade: {},
        completedChaptersSum: 0,
      };
    }
    for (const e of enrollments) {
      byCourse[e.courseId]?.studentIds.push(e.studentId);
      const g = String(gradeByStudentId.get(e.studentId) ?? '').trim();
      if (g) {
        if (!byCourse[e.courseId].byGrade[g])
          byCourse[e.courseId].byGrade[g] = {
            total: 0,
            completed: 0,
            sum: 0,
            count: 0,
          };
        byCourse[e.courseId].byGrade[g].total += 1;
      }
    }

    // compute per-student average per course (across chapter rows)
    const perStudentCourse: Record<string, { sum: number; count: number }> = {};
    for (const r of progressRows) {
      const key = `${r.courseId}:${r.studentId}`;
      if (!perStudentCourse[key]) perStudentCourse[key] = { sum: 0, count: 0 };
      perStudentCourse[key].sum += r.progress;
      perStudentCourse[key].count += 1;
    }
    for (const [key, v] of Object.entries(perStudentCourse)) {
      const [courseId, studentIdStr] = key.split(':');
      const studentId = parseInt(studentIdStr, 10);
      const avg = v.count > 0 ? v.sum / v.count : 0;
      const bucket = byCourse[courseId];
      if (!bucket) continue;
      bucket.sum += avg;
      bucket.count += 1;
      if (avg >= 99) bucket.completedSet.add(studentId);
      bucket.completedChaptersSum +=
        completedChaptersSetByStudentCourse[key]?.size ?? 0;
      const g = String(gradeByStudentId.get(studentId) ?? '').trim();
      if (g && bucket.byGrade[g]) {
        bucket.byGrade[g].sum += avg;
        bucket.byGrade[g].count += 1;
        if (avg >= 99) bucket.byGrade[g].completed += 1;
      }
    }

    const progress = access.map((a) => {
      const b = byCourse[a.courseId] ?? {
        studentIds: [],
        sum: 0,
        count: 0,
        completedSet: new Set<number>(),
        byGrade: {},
        completedChaptersSum: 0,
      };
      const avg = b.count > 0 ? b.sum / b.count : 0;
      const grade_breakdown = Object.entries(b.byGrade).map(([grade, g]) => ({
        grade,
        total: g.total,
        completed: g.completed,
        average_progress:
          g.count > 0 ? Number((g.sum / g.count).toFixed(2)) : 0,
      }));
      const totalChapters = totalChaptersByCourse[a.courseId] ?? 0;
      const avgCompletedChapters =
        b.studentIds.length > 0
          ? b.completedChaptersSum / b.studentIds.length
          : 0;
      return {
        course_id: a.courseId,
        total_students: b.studentIds.length,
        completed_students: b.completedSet.size,
        average_progress: Number(avg.toFixed(2)),
        total_chapters: totalChapters,
        chapters_completed: Number(avgCompletedChapters.toFixed(2)),
        grade_breakdown,
      };
    });
    return { progress };
  }

  @Get('courses/progress/students')
  async getCoursesProgressStudents(
    @CurrentUser() user: { id: number },
    @Query('courseId') courseId?: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) return { students: [] };
    const courseIds = courseId
      ? [courseId]
      : (
          await this.db.courseAccess.findMany({
            where: { schoolId },
            select: { courseId: true },
          })
        ).map((a) => a.courseId);
    if (courseIds.length === 0) return { students: [] };
    const enrollments = await this.db.studentCourse.findMany({
      where: { courseId: { in: courseIds } },
    });
    const studentIds = Array.from(new Set(enrollments.map((e) => e.studentId)));
    if (studentIds.length === 0) return { students: [] };
    const users = await this.db.user.findMany({
      where: { id: { in: studentIds }, role: Role.student },
      include: { profile: true },
    });
    const progressRows = await this.db.courseProgress.findMany({
      where: { studentId: { in: studentIds }, courseId: { in: courseIds } },
    });
    const students = users.map((u) => {
      const perCourse = progressRows.filter((p) => p.studentId === u.id);
      const avg = perCourse.length
        ? perCourse.reduce((s, p) => s + p.progress, 0) / perCourse.length
        : 0;
      return {
        student_id: String(u.id),
        full_name: u.profile?.fullName ?? u.email,
        email: u.email,
        average_progress: Number(avg.toFixed(2)),
      };
    });
    return { students };
  }

  @Get('courses/progress/students/detail')
  async getCoursesProgressStudentDetail(
    @CurrentUser() user: { id: number },
    @Query('courseId') courseId?: string,
    @Query('studentId') studentId?: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId || !courseId) return { students: [], chapters: [] };
    const studentIdNum = studentId ? parseInt(studentId, 10) : undefined;
    const enrollments = await this.db.studentCourse.findMany({
      where: {
        courseId,
        ...(studentIdNum ? { studentId: studentIdNum } : {}),
      },
    });
    const ids = enrollments.map((e) => e.studentId);
    if (ids.length === 0) return { students: [], chapters: [] };
    const [progress, users, studentSchools, chapters] = await Promise.all([
      this.db.courseProgress.findMany({
        where: { courseId, studentId: { in: ids } },
      }),
      this.db.user.findMany({
        where: { id: { in: ids } },
        include: { profile: true },
      }),
      this.db.studentSchool.findMany({
        where: { schoolId, studentId: { in: ids } },
        select: { studentId: true, grade: true, section: true },
      }),
      this.db.chapter.findMany({
        where: { courseId },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);
    const course = await this.db.course.findUnique({ where: { id: courseId } });
    const ssByStudentId = new Map(
      studentSchools.map((ss) => [ss.studentId, ss]),
    );
    const chapterMeta = chapters.map((ch) => ({
      id: ch.id,
      title: ch.title,
      chapter_number: ch.sortOrder,
    }));
    const students = users.map((u) => {
      const ss = ssByStudentId.get(u.id);
      const per = progress.filter((r) => r.studentId === u.id);
      const byChapter = new Map(
        per.filter((r) => r.chapterId).map((r) => [String(r.chapterId), r]),
      );
      const overall = per.length
        ? per.reduce((s, r) => s + r.progress, 0) / per.length
        : 0;
      return {
        id: String(u.id),
        full_name: u.profile?.fullName ?? u.email,
        email: u.email,
        grade: ss?.grade ?? '',
        section: ss?.section ?? '',
        overall_progress: Number(overall.toFixed(2)),
        completed: overall >= 99,
        chapters: chapterMeta.map((ch) => ({
          id: ch.id,
          title: ch.title,
          chapter_number: ch.chapter_number,
          progress: Number((byChapter.get(ch.id)?.progress ?? 0).toFixed(2)),
        })),
        course_id: courseId,
        course_name: course?.title ?? '',
      };
    });
    return {
      students,
      chapters: chapterMeta,
      // backward-compatible field
      detail:
        students.length === 1
          ? {
              student_id: students[0].id,
              full_name: students[0].full_name,
              email: students[0].email,
              course_id: courseId,
              course_name: course?.title ?? '',
              progress_percentage: students[0].overall_progress,
              last_accessed: null,
            }
          : students.map((s) => ({
              student_id: s.id,
              full_name: s.full_name,
              email: s.email,
              course_id: courseId,
              course_name: course?.title ?? '',
              progress_percentage: s.overall_progress,
              last_accessed: null,
            })),
    };
  }

  // Schedules – ClassSchedule (schoolId, periodId, dayOfWeek)

  private static readonly DAY_MAP: Record<string, number> = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  };

  @Get('schedules')
  async listSchedules(@CurrentUser() user: { id: number }) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) return { schedules: [] };
    const schedules = await this.db.classSchedule.findMany({
      where: { schoolId },
      orderBy: [{ dayOfWeek: 'asc' }, { id: 'asc' }],
    });
    const periodIds = Array.from(new Set(schedules.map((s) => s.periodId)));
    const roomIds = Array.from(
      new Set(schedules.map((s) => s.roomId).filter(Boolean)),
    ) as string[];
    const teacherIds = Array.from(
      new Set(schedules.map((s) => s.teacherId).filter(Boolean)),
    ) as number[];
    const periods =
      periodIds.length > 0
        ? await this.db.period.findMany({ where: { id: { in: periodIds } } })
        : [];
    const periodMap = new Map(periods.map((p) => [p.id, p]));
    const rooms =
      roomIds.length > 0
        ? await this.db.room.findMany({ where: { id: { in: roomIds } } })
        : [];
    const roomMap = new Map(rooms.map((r) => [r.id, r]));
    const teachers =
      teacherIds.length > 0
        ? await this.db.user.findMany({
            where: { id: { in: teacherIds } },
            include: { profile: true },
          })
        : [];
    const teacherMap = new Map(teachers.map((t) => [t.id, t]));
    const dayNames = Object.entries(SchoolAdminExtraController.DAY_MAP);
    return {
      schedules: schedules.map((s) => {
        const period = periodMap.get(s.periodId);
        const dayName = dayNames.find(([, n]) => n === s.dayOfWeek)?.[0];
        const room = s.roomId ? roomMap.get(s.roomId) : undefined;
        const teacher = s.teacherId ? teacherMap.get(s.teacherId) : undefined;
        const startTime = s.startTime ?? period?.startTime ?? '';
        const endTime = s.endTime ?? period?.endTime ?? '';
        return {
          id: s.id,
          school_id: s.schoolId,
          class_id: (s as { classId?: string | null }).classId ?? null,
          teacher_id: s.teacherId ? String(s.teacherId) : null,
          subject: (s as { subject?: string | null }).subject ?? '',
          grade: (s as { grade?: string | null }).grade ?? '',
          period_id: s.periodId,
          day_of_week: dayName ?? 'Monday',
          start_time: startTime,
          end_time: endTime,
          academic_year:
            (s as { academicYear?: string | null }).academicYear ??
            currentAcademicYear(),
          is_active: (s as { isActive?: boolean }).isActive !== false,
          notes: (s as { notes?: string | null }).notes ?? null,
          period: period
            ? {
                id: period.id,
                period_number: period.periodNumber,
                start_time: period.startTime,
                end_time: period.endTime,
              }
            : null,
          room: room
            ? {
                id: room.id,
                room_number: room.roomNumber ?? room.name,
                room_name: room.roomName ?? null,
                capacity: room.capacity ?? null,
              }
            : null,
          teacher: teacher
            ? {
                id: String(teacher.id),
                full_name: teacher.profile?.fullName ?? teacher.email,
                email: teacher.email,
              }
            : null,
        };
      }),
    };
  }

  @Get('schedules/:id')
  async getSchedule(
    @CurrentUser() user: { id: number },
    @Param() params: ResourceIdParamDto,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const schedule = await this.db.classSchedule.findFirst({
      where: { id: params.id, schoolId },
    });
    if (!schedule) throw new BadRequestException('Schedule not found');
    const [period, room, teacher] = await Promise.all([
      this.db.period.findFirst({ where: { id: schedule.periodId, schoolId } }),
      schedule.roomId
        ? this.db.room.findFirst({ where: { id: schedule.roomId, schoolId } })
        : null,
      schedule.teacherId
        ? this.db.user.findUnique({
            where: { id: schedule.teacherId },
            include: { profile: true },
          })
        : null,
    ]);
    const dayOfWeek =
      Object.entries(SchoolAdminExtraController.DAY_MAP).find(
        ([, n]) => n === schedule.dayOfWeek,
      )?.[0] ?? 'Monday';
    return {
      schedule: {
        id: schedule.id,
        school_id: schedule.schoolId,
        class_id: (schedule as { classId?: string | null }).classId ?? null,
        teacher_id: schedule.teacherId ? String(schedule.teacherId) : null,
        subject: (schedule as { subject?: string | null }).subject ?? '',
        grade: (schedule as { grade?: string | null }).grade ?? '',
        period_id: schedule.periodId,
        day_of_week: dayOfWeek,
        start_time: schedule.startTime ?? period?.startTime ?? '',
        end_time: schedule.endTime ?? period?.endTime ?? '',
        academic_year:
          (schedule as { academicYear?: string | null }).academicYear ??
          currentAcademicYear(),
        is_active: (schedule as { isActive?: boolean }).isActive !== false,
        notes: (schedule as { notes?: string | null }).notes ?? null,
        period: period
          ? {
              id: period.id,
              period_number: period.periodNumber,
              start_time: period.startTime,
              end_time: period.endTime,
            }
          : null,
        room: room
          ? {
              id: room.id,
              room_number: room.roomNumber ?? room.name,
              room_name: room.roomName ?? null,
              capacity: room.capacity ?? null,
            }
          : null,
        teacher: teacher
          ? {
              id: String(teacher.id),
              full_name: teacher.profile?.fullName ?? teacher.email,
              email: teacher.email,
            }
          : null,
      },
    };
  }

  @Post('schedules')
  async createSchedule(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      class_id?: string | null;
      teacher_id?: string | number | null;
      subject?: string;
      grade?: string;
      day_of_week?: string;
      period_id?: string | null;
      room_id?: string | null;
      start_time?: string | null;
      end_time?: string | null;
      academic_year?: string | null;
      notes?: string | null;
      is_active?: boolean;
    },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const periodId = (body?.period_id as string | null) ?? null;
    const dayRaw = String(body?.day_of_week ?? 'Monday');
    const dayOfWeek = SchoolAdminExtraController.DAY_MAP[dayRaw] ?? 1;
    if (!periodId) throw new BadRequestException('period_id is required');
    const period = await this.db.period.findFirst({
      where: { id: periodId, schoolId },
    });
    if (!period) throw new BadRequestException('Invalid period_id');

    const teacherId =
      body?.teacher_id == null
        ? null
        : typeof body.teacher_id === 'number'
          ? body.teacher_id
          : parseInt(String(body.teacher_id), 10);
    const roomId = body?.room_id == null ? null : String(body.room_id);
    const grade = String(body?.grade ?? '').trim();
    const subject = String(body?.subject ?? '').trim();
    if (!grade || !subject)
      throw new BadRequestException('grade and subject are required');
    if (teacherId != null && (!Number.isFinite(teacherId) || teacherId <= 0))
      throw new BadRequestException('Invalid teacher_id');
    if (roomId) {
      const room = await this.db.room.findFirst({
        where: { id: roomId, schoolId },
      });
      if (!room) throw new BadRequestException('Invalid room_id');
    }

    // Conflict checks: same room or teacher in same day+period
    const conflictFilters = [
      ...(teacherId != null ? [{ teacherId }] : []),
      ...(roomId ? [{ roomId }] : []),
    ];
    if (conflictFilters.length > 0) {
      const conflict = await this.db.classSchedule.findFirst({
        where: { schoolId, dayOfWeek, periodId, OR: conflictFilters },
      });
      if (conflict)
        throw new BadRequestException(
          'Schedule conflict: teacher or room already assigned for this period',
        );
    }

    const schedule = await this.db.classSchedule.create({
      data: {
        schoolId,
        periodId,
        dayOfWeek,
        teacherId,
        roomId,
        grade,
        subject,
        classId: body?.class_id ?? null,
        academicYear: body?.academic_year ?? currentAcademicYear(),
        startTime: body?.start_time ?? null,
        endTime: body?.end_time ?? null,
        notes: body?.notes ?? null,
        isActive: typeof body?.is_active === 'boolean' ? body.is_active : true,
      },
    });
    return {
      schedule: {
        id: schedule.id,
        school_id: schedule.schoolId,
        class_id: (schedule as { classId?: string | null }).classId ?? null,
        teacher_id: schedule.teacherId ? String(schedule.teacherId) : null,
        subject: (schedule as { subject?: string | null }).subject ?? '',
        grade: (schedule as { grade?: string | null }).grade ?? '',
        period_id: schedule.periodId,
        day_of_week: dayRaw,
        room_id: schedule.roomId ?? null,
        start_time: schedule.startTime ?? period.startTime,
        end_time: schedule.endTime ?? period.endTime,
        academic_year:
          (schedule as { academicYear?: string | null }).academicYear ??
          currentAcademicYear(),
        is_active: (schedule as { isActive?: boolean }).isActive !== false,
        notes: (schedule as { notes?: string | null }).notes ?? null,
      },
    };
  }

  @Patch('schedules/:id')
  async updateSchedule(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
    @Body()
    body: {
      class_id?: string | null;
      teacher_id?: string | number | null;
      subject?: string;
      grade?: string;
      day_of_week?: string;
      period_id?: string | null;
      room_id?: string | null;
      start_time?: string | null;
      end_time?: string | null;
      academic_year?: string | null;
      notes?: string | null;
      is_active?: boolean;
    },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const existing = await this.db.classSchedule.findFirst({
      where: { id, schoolId },
    });
    if (!existing) throw new BadRequestException('Schedule not found');
    const dayRaw =
      body?.day_of_week !== undefined ? String(body.day_of_week) : undefined;
    const dayOfWeek =
      dayRaw !== undefined
        ? (SchoolAdminExtraController.DAY_MAP[dayRaw] ?? existing.dayOfWeek)
        : existing.dayOfWeek;
    const periodId =
      body?.period_id !== undefined
        ? String(body.period_id ?? '')
        : existing.periodId;
    if (!periodId) throw new BadRequestException('period_id is required');
    if (periodId !== existing.periodId) {
      const period = await this.db.period.findFirst({
        where: { id: periodId, schoolId },
      });
      if (!period) throw new BadRequestException('Invalid period_id');
    }

    const teacherId =
      body?.teacher_id === undefined
        ? ((existing as { teacherId?: number | null }).teacherId ?? null)
        : body.teacher_id == null
          ? null
          : typeof body.teacher_id === 'number'
            ? body.teacher_id
            : parseInt(String(body.teacher_id), 10);
    const roomId =
      body?.room_id === undefined
        ? ((existing as { roomId?: string | null }).roomId ?? null)
        : body.room_id == null
          ? null
          : String(body.room_id);
    const grade =
      body?.grade === undefined
        ? ((existing as { grade?: string | null }).grade ?? '')
        : String(body.grade ?? '').trim();
    const subject =
      body?.subject === undefined
        ? ((existing as { subject?: string | null }).subject ?? '')
        : String(body.subject ?? '').trim();
    if (!grade || !subject)
      throw new BadRequestException('grade and subject are required');
    if (teacherId != null && (!Number.isFinite(teacherId) || teacherId <= 0))
      throw new BadRequestException('Invalid teacher_id');
    if (roomId) {
      const room = await this.db.room.findFirst({
        where: { id: roomId, schoolId },
      });
      if (!room) throw new BadRequestException('Invalid room_id');
    }

    const updateConflictFilters = [
      ...(teacherId != null ? [{ teacherId }] : []),
      ...(roomId ? [{ roomId }] : []),
    ];
    if (updateConflictFilters.length > 0) {
      const conflict = await this.db.classSchedule.findFirst({
        where: {
          schoolId,
          dayOfWeek,
          periodId,
          id: { not: id },
          OR: updateConflictFilters,
        },
      });
      if (conflict)
        throw new BadRequestException(
          'Schedule conflict: teacher or room already assigned for this period',
        );
    }

    const updated = await this.db.classSchedule.update({
      where: { id },
      data: {
        periodId,
        dayOfWeek,
        teacherId,
        roomId,
        grade,
        subject,
        classId:
          body?.class_id !== undefined
            ? body.class_id
            : ((existing as { classId?: string | null }).classId ?? null),
        academicYear:
          body?.academic_year !== undefined
            ? body.academic_year
            : ((existing as { academicYear?: string | null }).academicYear ??
              currentAcademicYear()),
        startTime:
          body?.start_time !== undefined
            ? body.start_time
            : ((existing as { startTime?: string | null }).startTime ?? null),
        endTime:
          body?.end_time !== undefined
            ? body.end_time
            : ((existing as { endTime?: string | null }).endTime ?? null),
        notes:
          body?.notes !== undefined
            ? body.notes
            : ((existing as { notes?: string | null }).notes ?? null),
        ...(typeof body?.is_active === 'boolean'
          ? { isActive: body.is_active }
          : {}),
      },
    });
    const period = await this.db.period.findFirst({
      where: { id: updated.periodId, schoolId },
    });
    return {
      schedule: {
        id: updated.id,
        school_id: updated.schoolId,
        class_id: (updated as { classId?: string | null }).classId ?? null,
        teacher_id: updated.teacherId ? String(updated.teacherId) : null,
        subject: (updated as { subject?: string | null }).subject ?? '',
        grade: (updated as { grade?: string | null }).grade ?? '',
        period_id: updated.periodId,
        day_of_week:
          dayRaw ??
          Object.entries(SchoolAdminExtraController.DAY_MAP).find(
            ([, n]) => n === updated.dayOfWeek,
          )?.[0] ??
          'Monday',
        room_id: updated.roomId ?? null,
        start_time: updated.startTime ?? period?.startTime ?? null,
        end_time: updated.endTime ?? period?.endTime ?? null,
        academic_year:
          (updated as { academicYear?: string | null }).academicYear ??
          currentAcademicYear(),
        is_active: (updated as { isActive?: boolean }).isActive !== false,
        notes: (updated as { notes?: string | null }).notes ?? null,
      },
    };
  }

  @Delete('schedules/:id')
  async deleteSchedule(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const existing = await this.db.classSchedule.findFirst({
      where: { id, schoolId },
    });
    if (!existing) throw new BadRequestException('Schedule not found');
    await this.db.classSchedule.delete({ where: { id } });
    return { success: true };
  }

  @Post('schedules/sync-to-teachers')
  async syncSchedulesToTeachers(
    @CurrentUser() user: { id: number },
    @Body() body?: { teacherIds?: string[] },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');

    let teacherFilter: any = { not: null };
    if (
      body?.teacherIds &&
      Array.isArray(body.teacherIds) &&
      body.teacherIds.length > 0
    ) {
      const ids = body.teacherIds
        .map((id) => parseInt(String(id), 10))
        .filter((id) => !isNaN(id));
      if (ids.length > 0) {
        teacherFilter = { in: ids };
      }
    }

    console.log(
      `[SchoolAdminExtraController] syncSchedulesToTeachers: schoolId=${schoolId}, teacherFilter=${JSON.stringify(teacherFilter)}`,
    );
    const schedules = await this.db.classSchedule.findMany({
      where: { schoolId, isActive: true, teacherId: teacherFilter },
    });
    console.log(
      `[SchoolAdminExtraController] syncSchedulesToTeachers: found ${schedules.length} schedules to sync`,
    );

    // Group by teacher
    const byTeacher = new Map<number, typeof schedules>();
    for (const s of schedules) {
      if (s.teacherId == null) continue;
      if (!byTeacher.has(s.teacherId)) byTeacher.set(s.teacherId, []);
      byTeacher.get(s.teacherId)!.push(s);
    }

    const dayNames = Object.entries(SchoolAdminExtraController.DAY_MAP);
    let synced = 0;

    for (const [teacherId, teacherSchedules] of byTeacher) {
      const lines = teacherSchedules.map((s) => {
        const day =
          dayNames.find(([, n]) => n === s.dayOfWeek)?.[0] ??
          `Day ${s.dayOfWeek}`;
        const time =
          s.startTime && s.endTime ? ` (${s.startTime}–${s.endTime})` : '';
        return `${day}: ${s.subject ?? 'Class'} – ${s.grade ?? 'All'}${time}`;
      });

      const notification = await this.db.notification.create({
        data: {
          userId: teacherId,
          senderId: user.id,
          title: 'Your Updated Schedule',
          message: `Your current schedule:\n${lines.join('\n')}`,
          mode: 'schedule',
        },
      });

      const unreadCount = await this.db.notification.count({
        where: { userId: teacherId, readAt: null, deletedAt: null },
      });
      this.realtimeGateway.emitNotificationNew(teacherId, {
        id: notification.id,
        title: notification.title,
        message: notification.message,
        type: notification.mode ?? 'schedule',
        is_read: false,
        created_at: notification.createdAt.toISOString(),
      });
      this.realtimeGateway.emitUnreadCount(teacherId, unreadCount);
      // Trigger a full dashboard refresh for the teacher
      await this.realtimeGateway.emitDashboardStatsForUser(teacherId);
      synced++;
    }

    return {
      synced,
      skipped: schedules.filter((s) => s.teacherId == null).length,
      success: true,
    };
  }

  // Notifications – list (for school admin’s own user), create (broadcast to recipients), recipients, PATCH

  @Get('notifications')
  async listNotifications(
    @CurrentUser() user: { id: number },
    @Query('limit') limit?: string,
    @Query('mode') mode?: string,
    @Query('school_id') schoolIdParam?: string,
  ) {
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100)
      : 50;
    const m = String(mode ?? 'received')
      .trim()
      .toLowerCase(); // received | sent | all
    const schoolId = schoolIdParam ?? (await this.getSchoolId(user.id));

    // Allowed recipients for this school (for "sent/all" views)
    const allowedRecipientIds: number[] = schoolId
      ? Array.from(
          new Set<number>([
            ...(
              await this.db.teacherSchool.findMany({
                where: { schoolId },
                select: { teacherId: true },
              })
            ).map((t) => t.teacherId),
            ...(
              await this.db.studentSchool.findMany({
                where: { schoolId },
                select: { studentId: true },
              })
            ).map((s) => s.studentId),
          ]),
        )
      : [];

    const where =
      m === 'sent'
        ? {
            senderId: user.id,
            deletedAt: null,
            ...(allowedRecipientIds.length > 0
              ? { userId: { in: allowedRecipientIds } }
              : {}),
          }
        : m === 'all'
          ? {
              deletedAt: null,
              OR: [
                { userId: user.id },
                {
                  senderId: user.id,
                  ...(allowedRecipientIds.length > 0
                    ? { userId: { in: allowedRecipientIds } }
                    : {}),
                },
              ],
            }
          : { userId: user.id, deletedAt: null };

    const notifications = await this.db.notification.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      take,
    });
    return {
      notifications: notifications.map((n) => ({
        id: n.id,
        user_id: n.userId,
        sender_id: n.senderId ?? null,
        title: n.title,
        message: n.message,
        type: n.mode ?? 'general',
        is_read: !!n.readAt,
        created_at: n.createdAt.toISOString(),
      })),
    };
  }

  @Post('notifications')
  async createNotification(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      title?: string;
      message?: string;
      type?: string;
      recipientType?: string;
      recipients?: string[];
      school_id?: string;
    },
  ) {
    const title = String(body?.title ?? '').trim();
    const message = String(body?.message ?? '').trim();
    if (!title || !message)
      throw new BadRequestException('Title and message are required');
    const recipientType = body?.recipientType ?? 'role';
    const recipients = Array.isArray(body?.recipients) ? body.recipients : [];
    const schoolId = body?.school_id ?? (await this.getSchoolId(user.id));
    let userIds: number[] = [];
    if (recipientType === 'role') {
      for (const r of recipients) {
        if (r === 'role:teacher') {
          const ts = await this.db.teacherSchool.findMany({
            where: { schoolId: schoolId ?? undefined },
            select: { teacherId: true },
          });
          userIds.push(...ts.map((t) => t.teacherId));
        } else if (r === 'role:student') {
          const ss = await this.db.studentSchool.findMany({
            where: { schoolId: schoolId ?? undefined },
            select: { studentId: true },
          });
          userIds.push(...ss.map((s) => s.studentId));
        }
      }
    } else {
      userIds = recipients
        .map((id) => parseInt(id, 10))
        .filter((n) => !Number.isNaN(n));
    }
    userIds = Array.from(new Set(userIds));
    for (const uid of userIds) {
      const created = await this.db.notification.create({
        data: {
          userId: uid,
          senderId: user.id,
          title,
          message,
          mode: body?.type ?? 'general',
        },
      });
      const count = await this.db.notification.count({
        where: { userId: uid, readAt: null, deletedAt: null },
      });
      this.realtimeGateway.emitNotificationNew(uid, {
        id: created.id,
        title: created.title,
        message: created.message,
        type: created.mode ?? 'general',
        is_read: false,
        created_at: created.createdAt.toISOString(),
      });
      this.realtimeGateway.emitUnreadCount(uid, count);
      await this.realtimeGateway.emitDashboardStatsForUser(uid);
    }
    return { sent: userIds.length, success: true };
  }

  @Get('notifications/recipients')
  async listNotificationRecipients(
    @CurrentUser() user: { id: number },
    @Query('school_id') schoolIdParam?: string,
  ) {
    const schoolId = schoolIdParam ?? (await this.getSchoolId(user.id));
    if (!schoolId) return { roles: [], users: [] };
    const [teacherCount, studentCount] = await Promise.all([
      this.db.teacherSchool.count({ where: { schoolId } }),
      this.db.studentSchool.count({ where: { schoolId } }),
    ]);
    const roles = [
      teacherCount > 0
        ? { id: 'role:teacher', name: 'All Teachers', count: teacherCount }
        : null,
      studentCount > 0
        ? { id: 'role:student', name: 'All Students', count: studentCount }
        : null,
    ].filter(
      (r): r is { id: string; name: string; count: number } => r !== null,
    );
    const [teacherUsers, studentUsers] = await Promise.all([
      this.db.teacherSchool.findMany({ where: { schoolId } }),
      this.db.studentSchool.findMany({
        where: { schoolId },
        include: { student: { include: { profile: true } } },
      }),
    ]);
    const teacherIds = Array.from(
      new Set(teacherUsers.map((t) => t.teacherId)),
    );
    const teachers =
      teacherIds.length > 0
        ? await this.db.user.findMany({
            where: { id: { in: teacherIds } },
            include: { profile: true },
          })
        : [];
    const teacherById = new Map(teachers.map((t) => [t.id, t]));
    const users = [
      ...teacherUsers
        .map((ts) => {
          const t = teacherById.get(ts.teacherId);
          return t
            ? {
                id: String(t.id),
                name: t.profile?.fullName ?? t.email,
                email: t.email,
                role: 'teacher' as const,
              }
            : null;
        })
        .filter((u) => u !== null),
      ...studentUsers.map((ss) => ({
        id: String(ss.student.id),
        name: ss.student.profile?.fullName ?? ss.student.email,
        email: ss.student.email,
        role: 'student' as const,
      })),
    ];
    return { roles, users };
  }

  @Patch('notifications/:id')
  async updateNotification(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
    @Body() body: { is_read?: boolean },
  ) {
    const n = await this.db.notification.findFirst({
      where: { id, userId: user.id },
    });
    if (!n) throw new BadRequestException('Notification not found');

    if (body?.is_read === true) {
      await this.db.notification.update({
        where: { id },
        data: { readAt: new Date() },
      });
      const unreadCount = await this.db.notification.count({
        where: { userId: user.id, readAt: null, deletedAt: null },
      });
      this.realtimeGateway.emitNotificationRead(user.id, {
        notification_id: id,
        mark_all: false,
        read_at: new Date().toISOString(),
      });
      this.realtimeGateway.emitUnreadCount(user.id, unreadCount);
      await this.realtimeGateway.emitDashboardStatsForUser(user.id);
    } else if (body?.is_read === false) {
      await this.db.notification.update({
        where: { id },
        data: { readAt: null },
      });
      const unreadCount = await this.db.notification.count({
        where: { userId: user.id, readAt: null, deletedAt: null },
      });
      this.realtimeGateway.emitUnreadCount(user.id, unreadCount);
    }

    return { success: true };
  }

  // Reports – TeacherReport (school-scoped)

  @Get('reports')
  async getReports(
    @CurrentUser() user: { id: number },
    @Query('limit') limit?: string,
    @Query('pending') pending?: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) return { reports: [] };
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100)
      : 50;
    const where: { schoolId: string; status?: string } = { schoolId };
    if (pending === '1' || pending === 'true') where.status = 'submitted';
    const reports = await this.db.teacherReport.findMany({
      where,
      orderBy: { reportDate: 'desc' },
      take,
    });
    const teacherIds = Array.from(new Set(reports.map((r) => r.teacherId)));
    const teachers =
      teacherIds.length > 0
        ? await this.db.user.findMany({
            where: { id: { in: teacherIds } },
            include: { profile: true },
          })
        : [];
    const teacherMap = new Map(teachers.map((t) => [t.id, t]));
    const toUiStatus = (
      s?: string | null,
    ): 'Pending' | 'Approved' | 'Rejected' => {
      const v = String(s ?? 'submitted').toLowerCase();
      if (v === 'approved') return 'Approved';
      if (v === 'rejected') return 'Rejected';
      return 'Pending';
    };
    return {
      reports: reports.map((r) => {
        const t = teacherMap.get(r.teacherId);
        return {
          id: r.id,
          teacher_id: r.teacherId,
          school_id: r.schoolId,
          date: r.reportDate.toISOString(),
          grade: r.grade ?? '',
          period_id: r.periodId,
          status: toUiStatus(r.status as string),
          topics_taught: r.topicsTaught ?? '',
          student_count: r.studentCount ?? 0,
          duration_hours: r.durationHours ?? 0,
          notes: r.notes ?? '',
          teacher: {
            full_name: t?.profile?.fullName ?? t?.email ?? '',
            email: t?.email ?? '',
          },
        };
      }),
    };
  }

  @Get('reports/:id')
  async getReport(
    @CurrentUser() user: { id: number },
    @Param() params: ResourceIdParamDto,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const report = await this.db.teacherReport.findFirst({
      where: { id: params.id, schoolId },
    });
    if (!report) throw new BadRequestException('Report not found');
    const teacher = await this.db.user.findUnique({
      where: { id: report.teacherId },
      include: { profile: true },
    });
    return {
      report: {
        id: report.id,
        teacher_id: report.teacherId,
        school_id: report.schoolId,
        date: report.reportDate.toISOString(),
        grade: report.grade ?? '',
        period_id: report.periodId,
        status: report.status,
        topics_taught: report.topicsTaught ?? '',
        student_count: report.studentCount ?? 0,
        duration_hours: report.durationHours ?? 0,
        notes: report.notes ?? '',
        teacher: {
          full_name: teacher?.profile?.fullName ?? teacher?.email ?? '',
          email: teacher?.email ?? '',
        },
      },
    };
  }

  @Patch('reports/:id')
  async updateReport(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
    @Body() body: { action?: string; status?: string },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const report = await this.db.teacherReport.findFirst({
      where: { id, schoolId },
    });
    if (!report) throw new BadRequestException('Report not found');
    const normalize = (s: string) => s.trim().toLowerCase();
    const status =
      body?.action === 'approve'
        ? 'approved'
        : body?.action === 'reject'
          ? 'rejected'
          : body?.status
            ? (() => {
                const v = normalize(body.status);
                if (v === 'approved') return 'approved';
                if (v === 'rejected') return 'rejected';
                if (v === 'pending' || v === 'submitted') return 'submitted';
                return report.status;
              })()
            : report.status;
    await this.db.teacherReport.update({
      where: { id },
      data: { status },
    });
    const [schoolAdmins, adminUsers] = await Promise.all([
      this.db.schoolAdmin.findMany({
        where: { schoolId },
        select: { userId: true },
      }),
      this.db.user.findMany({
        where: { role: Role.admin },
        select: { id: true },
      }),
    ]);
    await this.realtimeGateway.emitDashboardStatsForUsers([
      report.teacherId,
      ...schoolAdmins.map((s) => s.userId),
      ...adminUsers.map((u) => u.id),
    ]);
    return { success: true };
  }

  @Patch('reports/bulk')
  async bulkUpdateReports(
    @CurrentUser() user: { id: number },
    @Body() body: { report_ids?: string[]; action?: string },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const ids = Array.isArray(body?.report_ids) ? body.report_ids : [];
    if (ids.length === 0) return { approved: 0 };
    const action =
      body?.action === 'approve'
        ? 'approved'
        : body?.action === 'reject'
          ? 'rejected'
          : 'submitted';
    await this.db.teacherReport.updateMany({
      where: { id: { in: ids }, schoolId },
      data: { status: action },
    });
    const affectedReports = await this.db.teacherReport.findMany({
      where: { id: { in: ids }, schoolId },
      select: { teacherId: true },
    });
    const [schoolAdmins, adminUsers] = await Promise.all([
      this.db.schoolAdmin.findMany({
        where: { schoolId },
        select: { userId: true },
      }),
      this.db.user.findMany({
        where: { role: Role.admin },
        select: { id: true },
      }),
    ]);
    await this.realtimeGateway.emitDashboardStatsForUsers([
      ...affectedReports.map((r) => r.teacherId),
      ...schoolAdmins.map((s) => s.userId),
      ...adminUsers.map((u) => u.id),
    ]);
    return { approved: ids.length };
  }

  // Leaves – TeacherLeave (school-scoped)

  @Get('leaves')
  async listLeaves(
    @CurrentUser() user: { id: number },
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) return { leaves: [] };
    const take = limit
      ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100)
      : 50;
    const normalizeIn = (s: string) => s.trim().toLowerCase();
    const statusNorm = status ? normalizeIn(status) : '';
    const where: { schoolId: string; status?: string } = { schoolId };
    if (statusNorm && statusNorm !== 'all') where.status = statusNorm;
    const leaves = await this.db.teacherLeave.findMany({
      where,
      orderBy: { startDate: 'desc' },
      take,
      include: { teacher: { include: { profile: true } } },
    });
    const approverIds = Array.from(
      new Set(
        leaves
          .map((l) => (l.approvedBy ? parseInt(String(l.approvedBy), 10) : NaN))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    );
    const approvers =
      approverIds.length > 0
        ? await this.db.user.findMany({
            where: { id: { in: approverIds } },
            include: { profile: true },
          })
        : [];
    const approverById = new Map<
      number,
      { id: string; full_name: string; email: string; role: string }
    >();
    for (const a of approvers) {
      approverById.set(a.id, {
        id: String(a.id),
        full_name: a.profile?.fullName ?? a.email,
        email: a.email,
        role: String(a.role),
      });
    }

    const toStatusOut = (s: string) => {
      const x = normalizeIn(s);
      if (x === 'approved') return 'Approved';
      if (x === 'rejected') return 'Rejected';
      return 'Pending';
    };
    return {
      leaves: leaves.map((l) => ({
        id: l.id,
        teacher_id: String(l.teacherId),
        school_id: l.schoolId,
        start_date: l.startDate.toISOString(),
        end_date: l.endDate.toISOString(),
        reason: l.reason,
        leave_type: (l as { leaveType?: string }).leaveType ?? 'General',
        status: toStatusOut(l.status),
        total_days: Math.max(
          1,
          Math.round(
            (Date.UTC(
              l.endDate.getUTCFullYear(),
              l.endDate.getUTCMonth(),
              l.endDate.getUTCDate(),
            ) -
              Date.UTC(
                l.startDate.getUTCFullYear(),
                l.startDate.getUTCMonth(),
                l.startDate.getUTCDate(),
              )) /
              (1000 * 60 * 60 * 24),
          ) + 1,
        ),
        substitute_required:
          (l as { substituteRequired?: boolean }).substituteRequired ?? false,
        created_at: l.createdAt.toISOString(),
        approved_by: l.approvedBy ?? null,
        approved_at: l.status === 'approved' ? l.updatedAt.toISOString() : null,
        reviewed_by: null,
        reviewed_at: null,
        profiles: {
          id: String(l.teacherId),
          full_name: l.teacher?.profile?.fullName ?? l.teacher?.email ?? '',
          email: l.teacher?.email ?? '',
        },
        reviewer: null,
        approver: l.approvedBy
          ? (approverById.get(parseInt(String(l.approvedBy), 10)) ?? null)
          : null,
      })),
    };
  }

  @Get('leaves/:id')
  async getLeave(
    @CurrentUser() user: { id: number },
    @Param() params: ResourceIdParamDto,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const leave = await this.db.teacherLeave.findFirst({
      where: { id: params.id, schoolId },
      include: { teacher: { include: { profile: true } } },
    });
    if (!leave) throw new BadRequestException('Leave not found');
    return {
      leave: {
        id: leave.id,
        teacher_id: String(leave.teacherId),
        school_id: leave.schoolId,
        start_date: leave.startDate.toISOString(),
        end_date: leave.endDate.toISOString(),
        reason: leave.reason,
        leave_type: (leave as { leaveType?: string }).leaveType ?? 'General',
        status: leave.status,
        total_days: Math.max(
          1,
          Math.round(
            (Date.UTC(
              leave.endDate.getUTCFullYear(),
              leave.endDate.getUTCMonth(),
              leave.endDate.getUTCDate(),
            ) -
              Date.UTC(
                leave.startDate.getUTCFullYear(),
                leave.startDate.getUTCMonth(),
                leave.startDate.getUTCDate(),
              )) /
              (1000 * 60 * 60 * 24),
          ) + 1,
        ),
        created_at: leave.createdAt.toISOString(),
        approved_by: leave.approvedBy ?? null,
        approved_at:
          leave.status === 'approved' ? leave.updatedAt.toISOString() : null,
        profiles: {
          id: String(leave.teacherId),
          full_name:
            leave.teacher?.profile?.fullName ?? leave.teacher?.email ?? '',
          email: leave.teacher?.email ?? '',
        },
      },
    };
  }

  @Patch('leaves/:id')
  async updateLeave(
    @CurrentUser() user: { id: number },
    @Param('id') id: string,
    @Body()
    body: {
      action?: string;
      status?: string;
      admin_remarks?: string;
      approved_by?: string;
    },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const leave = await this.db.teacherLeave.findFirst({
      where: { id, schoolId },
    });
    if (!leave) throw new BadRequestException('Leave not found');
    const normalize = (s: string) => s.trim().toLowerCase();
    const statusRaw =
      body?.action === 'approve'
        ? 'approved'
        : body?.action === 'reject'
          ? 'rejected'
          : body?.status
            ? normalize(body.status)
            : leave.status;
    const status =
      statusRaw === 'approved' ||
      statusRaw === 'rejected' ||
      statusRaw === 'pending'
        ? statusRaw
        : leave.status;

    const updated = await this.db.teacherLeave.update({
      where: { id },
      data: {
        status,
        ...(body?.admin_remarks !== undefined && {
          adminRemarks: body.admin_remarks,
        }),
        approvedBy:
          status === 'approved'
            ? (body?.approved_by ?? String(user.id))
            : status === 'rejected'
              ? null
              : undefined,
      },
    });

    // On approval, update attendance for the leave date range.
    // Mark as Leave-Approved unless already Present.
    if (status === 'approved') {
      const start = new Date(updated.startDate);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(updated.endDate);
      end.setUTCHours(0, 0, 0, 0);
      for (
        let d = new Date(start);
        d.getTime() <= end.getTime();
        d.setUTCDate(d.getUTCDate() + 1)
      ) {
        const day = new Date(d);
        const existing = await this.db.attendance.findUnique({
          where: {
            teacherId_schoolId_date: {
              teacherId: updated.teacherId,
              schoolId: updated.schoolId,
              date: day,
            },
          },
        });
        if (existing?.status === 'Present') continue;
        await this.db.attendance.upsert({
          where: {
            teacherId_schoolId_date: {
              teacherId: updated.teacherId,
              schoolId: updated.schoolId,
              date: day,
            },
          },
          create: {
            teacherId: updated.teacherId,
            schoolId: updated.schoolId,
            date: day,
            status: 'Leave-Approved',
          },
          update: { status: 'Leave-Approved' },
        });
      }
    }
    const [schoolAdmins, adminUsers] = await Promise.all([
      this.db.schoolAdmin.findMany({
        where: { schoolId },
        select: { userId: true },
      }),
      this.db.user.findMany({
        where: { role: Role.admin },
        select: { id: true },
      }),
    ]);
    await this.realtimeGateway.emitDashboardStatsForUsers([
      updated.teacherId,
      ...schoolAdmins.map((s) => s.userId),
      ...adminUsers.map((u) => u.id),
    ]);
    return { success: true };
  }

  // Password reset requests – scoped to this school admin's school

  @Get('password-reset-requests')
  async listPasswordResetRequests(
    @CurrentUser() user: { id: number },
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) return { requests: [] };
    return this.passwordResetRequestService.list({
      status: status && status !== 'all' ? status : undefined,
      limit: limit ? Math.min(parseInt(limit, 10) || 100, 200) : 100,
      schoolId,
    });
  }

  @Patch('password-reset-requests')
  async updatePasswordResetRequests(
    @CurrentUser() user: { id: number },
    @Body()
    body: {
      id?: string;
      status?: string;
      notes?: string;
      approved_by?: string;
      temp_password?: string;
    },
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    return this.passwordResetRequestService.update(
      {
        id: String(body?.id ?? '').trim(),
        status: String(body?.status ?? '').trim(),
        notes: body?.notes,
        approved_by: body?.approved_by ?? String(user.id),
        temp_password: body?.temp_password,
      },
      { restrictToSchoolId: schoolId },
    );
  }

  @Delete('password-reset-requests')
  async deletePasswordResetRequests(
    @CurrentUser() user: { id: number },
    @Query('id') id?: string,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');
    const trimmed = (id ?? '').trim();
    if (!trimmed) throw new BadRequestException('id is required');
    // Verify the request belongs to this school before deleting
    const request = await this.db.passwordResetRequest.findUnique({
      where: { id: trimmed },
      select: { schoolId: true },
    });
    if (!request)
      throw new BadRequestException('Password reset request not found');
    if (request.schoolId !== schoolId) {
      throw new ForbiddenException(
        'You do not have permission to delete this request',
      );
    }
    await this.passwordResetRequestService.delete(trimmed);
    return { success: true };
  }

  // Data export – stub for compatibility

  @Get('data/export')
  async exportData(@CurrentUser() _user: { id: number }) {
    return { export: [], message: 'Export not implemented.' };
  }

  @Post('data/import')
  async importData(
    @CurrentUser() user: { id: number },
    @Body() dto: DataImportDto,
  ) {
    const schoolId = await this.getSchoolId(user.id);
    if (!schoolId) throw new BadRequestException('School not found');

    const rows = Array.isArray(dto.records) ? dto.records : [];

    if (dto.type === 'students') {
      if (rows.length === 0)
        throw new BadRequestException('No records provided');
      if (rows.length > 500)
        throw new BadRequestException(
          'Import limit is 500 records per request',
        );

      const genPassword = () => {
        const buf = randomBytes(9).toString('base64').replace(/[+/=]/g, '');
        return `Ym${buf}A1!`;
      };

      const results: Array<{
        index: number;
        email: string | null;
        success: boolean;
        error?: string;
        generated_password?: string;
      }> = [];

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? {};
        const email = String(r.email ?? '')
          .trim()
          .toLowerCase();
        if (!email) {
          results.push({
            index: i,
            email: null,
            success: false,
            error: 'email is required',
          });
          continue;
        }
        const exists = await this.db.user.findUnique({ where: { email } });
        if (exists) {
          results.push({
            index: i,
            email,
            success: false,
            error: 'Email already exists',
          });
          continue;
        }
        const rawPassword = String(r.password ?? '').trim();
        const effectivePassword = rawPassword || genPassword();
        const hash = await bcrypt.hash(effectivePassword, 10);
        try {
          await this.db.$transaction(async (tx) => {
            const newUser = await tx.user.create({
              data: {
                email,
                password: hash,
                role: Role.student,
                tenantId: schoolId,
                isActive: true,
              },
            });
            // Validate cross-tenant ownership using tx so the newly created user
            // (not yet committed) is visible to the lookup.
            await this.db.assertCrossTenantUserIds(
              [newUser.id],
              schoolId,
              tx as any,
            );
            await tx.profile.upsert({
              where: { userId: newUser.id },
              create: {
                userId: newUser.id,
                fullName: r.full_name != null ? String(r.full_name) : null,
                parentName:
                  r.parent_name != null ? String(r.parent_name) : null,
                parentPhone:
                  r.parent_phone != null ? String(r.parent_phone) : null,
                schoolId,
              },
              update: {
                fullName: r.full_name != null ? String(r.full_name) : null,
              },
            });
            await tx.studentSchool.create({
              data: {
                studentId: newUser.id,
                schoolId,
                grade: r.grade != null ? String(r.grade) : null,
                section: r.section != null ? String(r.section) : null,
                isActive: true,
              },
            });

            // Auto-enroll in courses for the school + grade
            await this.enrollmentService.enrollStudentInRelevantCourses(
              newUser.id,
              schoolId,
              r.grade != null ? String(r.grade) : null,
            );
          });
          results.push({
            index: i,
            email,
            success: true,
            generated_password: rawPassword ? undefined : effectivePassword,
          });
        } catch (e) {
          results.push({
            index: i,
            email,
            success: false,
            error: e instanceof Error ? e.message : 'Failed to create student',
          });
        }
      }

      return {
        success: true,
        school_id: schoolId,
        type: 'students',
        imported: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
      };
    }

    throw new BadRequestException(
      `Import type "${dto.type}" is not supported. Supported: students`,
    );
  }
}
