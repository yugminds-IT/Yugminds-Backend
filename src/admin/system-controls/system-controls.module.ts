import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { SystemControlsController } from './system-controls.controller.js';
import { SystemControlsService } from './system-controls.service.js';

// Standalone module (depends only on DatabaseModule) so both AdminModule and
// AuthModule can use SystemControlsService without a circular import —
// AdminModule already imports AuthModule, so AuthModule can't import AdminModule back.
@Module({
  imports: [DatabaseModule],
  controllers: [SystemControlsController],
  providers: [SystemControlsService],
  exports: [SystemControlsService],
})
export class SystemControlsModule {}
