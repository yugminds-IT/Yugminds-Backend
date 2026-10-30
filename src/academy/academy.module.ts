import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../database/database.module';
import { AcademyAuthController } from './academy-auth.controller';
import { AcademyPublicController } from './academy-public.controller';
import { AcademyLearnerController } from './academy-learner.controller';
import { AcademyTutorController } from './academy-tutor.controller';
import { AcademyAdminController } from './academy-admin.controller';
import { AcademyAuthGuard } from './academy-auth';
import { SessionsModule } from '../auth/sessions/sessions.module';
import { AcademyAuthService } from './academy-auth.service';
import { CommerceService } from './commerce.service';
import { BookingService } from './booking.service';
import { LearningService } from './learning.service';
import { CourseBuilderService } from './course-builder.service';
import { RazorpayService } from './razorpay.service';

/**
 * RoboCoders Academy — a standalone B2C app (own accounts, courses, payments)
 * sharing only this server and database with the LMS. Its JwtModule has no
 * default secret: every sign/verify passes ACADEMY_JWT_SECRET explicitly.
 */
@Module({
  imports: [DatabaseModule, SessionsModule, JwtModule.register({})],
  controllers: [
    AcademyAuthController,
    AcademyPublicController,
    AcademyLearnerController,
    AcademyTutorController,
    AcademyAdminController,
  ],
  providers: [
    AcademyAuthGuard,
    AcademyAuthService,
    CommerceService,
    BookingService,
    LearningService,
    CourseBuilderService,
    RazorpayService,
  ],
})
export class AcademyModule {}
