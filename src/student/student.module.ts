import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { CommonModule } from '../common/common.module';
import { StudentDashboardController } from './dashboard/dashboard.controller';
import { StudentDashboardService } from './dashboard/dashboard.service';
import { StudentExtraController } from './extra/student-extra.controller';

@Module({
  imports: [DatabaseModule, AuthModule, CommonModule],
  controllers: [StudentDashboardController, StudentExtraController],
  providers: [StudentDashboardService],
})
export class StudentModule {}
