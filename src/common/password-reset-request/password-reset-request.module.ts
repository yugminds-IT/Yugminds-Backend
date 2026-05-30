import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PasswordResetRequestService } from './password-reset-request.service';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [DatabaseModule, forwardRef(() => RealtimeModule)],
  providers: [PasswordResetRequestService],
  exports: [PasswordResetRequestService],
})
export class PasswordResetRequestModule {}
