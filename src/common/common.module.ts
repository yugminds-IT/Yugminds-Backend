import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { GetRoleController } from './get-role/get-role.controller';
import { ProfileController } from './profile/profile.controller';
import { GetRoleService } from './get-role/get-role.service';
import { ProfileService } from './profile/profile.service';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { CommonExtraController } from './extra/common-extra.controller';
import { CommunityPublicController } from './community/community-public.controller';
import { ValidateJoiningCodeController } from './validate-joining-code/validate-joining-code.controller';
import { ValidateJoiningCodeService } from './validate-joining-code/validate-joining-code.service';
import { RealtimeModule } from './realtime/realtime.module';
import { StorageModule } from './storage/storage.module';
import { EnrollmentService } from './enrollment/enrollment.service';
import { RankingService } from './assignment/ranking.service';
import { StudentRankingService } from './assignment/student-ranking.service';
import { RetakeRequestTeacherResolver } from './assignment/retake-request-teacher-resolver.service';
import { CertificateService } from './certificates/certificate.service';

@Module({
  imports: [DatabaseModule, AuthModule, RealtimeModule, StorageModule],
  controllers: [
    GetRoleController,
    ProfileController,
    NotificationsController,
    CommonExtraController,
    CommunityPublicController,
    ValidateJoiningCodeController,
  ],
  providers: [
    GetRoleService,
    ProfileService,
    NotificationsService,
    ValidateJoiningCodeService,
    EnrollmentService,
    RankingService,
    StudentRankingService,
    RetakeRequestTeacherResolver,
    CertificateService,
  ],
  exports: [
    NotificationsService,
    EnrollmentService,
    RankingService,
    StudentRankingService,
    RetakeRequestTeacherResolver,
    CertificateService,
  ],
})
export class CommonModule {}
