import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { SessionsService } from './sessions.service';

/** Standalone so Academy can share session storage without pulling in LMS auth. */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
