import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AdminDashboardController } from './dashboard/dashboard.controller.js';
import { AdminSchoolsController } from './schools/schools.controller.js';
import { AdminTeachersController } from './teachers/teachers.controller.js';
import { AdminCoursesController } from './courses/courses.controller.js';
import { AdminStudentsController } from './students/students.controller.js';
import { AdminProfileController } from './profile/profile.controller.js';
import { CreateAccountController } from './create-account/create-account.controller.js';
import { AdminSchoolAdminsController } from './school-admins/school-admins.controller.js';
import { AdminJoiningCodesController } from './joining-codes/joining-codes.controller.js';
import { AdminTeacherAttendanceController } from './teacher-attendance/teacher-attendance.controller.js';
import { AdminLeavesController } from './leaves/leaves.controller.js';
import { AdminExtraController } from './extra/admin-extra.controller.js';
import { CommunityAdminController } from './community/community-admin.controller.js';
import { AdminLicensesController } from './licenses/licenses.controller.js';
import { PasswordResetRequestModule } from '../common/password-reset-request/password-reset-request.module.js';
import { RealtimeModule } from '../common/realtime/realtime.module';
import { CommonModule } from '../common/common.module';
import { AdminDashboardService } from './dashboard/dashboard.service.js';
import { AdminSchoolsService } from './schools/schools.service.js';
import { AdminTeachersService } from './teachers/teachers.service.js';
import { AdminCoursesService } from './courses/courses.service.js';
import { AdminStudentsService } from './students/students.service.js';
import { AdminProfileService } from './profile/profile.service.js';
import { CreateAccountService } from './create-account/create-account.service.js';
import { AdminSchoolAdminsService } from './school-admins/school-admins.service.js';
import { AdminJoiningCodesService } from './joining-codes/joining-codes.service.js';
import { AdminTeacherAttendanceService } from './teacher-attendance/teacher-attendance.service.js';
import { AdminLeavesService } from './leaves/leaves.service.js';
import { AdminLicensesService } from './licenses/licenses.service.js';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditController } from './audit/audit.controller.js';
import { ImpersonationController } from './impersonation/impersonation.controller.js';
import { TrashController } from './trash/trash.controller.js';
import { TrashService } from './trash/trash.service.js';
import { AdminSearchController } from './search/search.controller.js';
import { AdminSearchService } from './search/search.service.js';
import { SystemControlsController } from './system-controls/system-controls.controller.js';
import { SystemControlsService } from './system-controls/system-controls.service.js';
import { AlertsController } from './alerts/alerts.controller.js';
import { AlertsService } from './alerts/alerts.service.js';
import { DigestController } from './digest/digest.controller.js';
import { DigestService } from './digest/digest.service.js';
import { SavedViewsController } from './saved-views/saved-views.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuditInterceptor } from './audit/audit.interceptor.js';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    PasswordResetRequestModule,
    RealtimeModule,
    CommonModule,
  ],
  controllers: [
    AdminDashboardController,
    AdminSchoolsController,
    AdminTeachersController,
    AdminCoursesController,
    AdminStudentsController,
    AdminProfileController,
    CreateAccountController,
    AdminSchoolAdminsController,
    AdminJoiningCodesController,
    AdminTeacherAttendanceController,
    AdminLeavesController,
    AdminExtraController,
    CommunityAdminController,
    AdminLicensesController,
    AuditController,
    ImpersonationController,
    TrashController,
    AdminSearchController,
    SystemControlsController,
    AlertsController,
    DigestController,
    SavedViewsController,
  ],
  providers: [
    AdminDashboardService,
    AdminSchoolsService,
    AdminTeachersService,
    AdminCoursesService,
    AdminStudentsService,
    AdminProfileService,
    CreateAccountService,
    AdminSchoolAdminsService,
    AdminJoiningCodesService,
    AdminTeacherAttendanceService,
    AdminLeavesService,
    AdminLicensesService,
    AuditService,
    TrashService,
    AdminSearchService,
    SystemControlsService,
    AlertsService,
    DigestService,
    // Global interceptor, but it only logs mutating requests under /admin (see AuditInterceptor).
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AdminModule {}
