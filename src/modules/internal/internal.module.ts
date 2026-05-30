import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { InternalController } from './internal.controller';
import { InternalGuard } from './internal.guard';
import { InternalService } from './internal.service';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [InternalController],
  providers: [InternalService, InternalGuard],
})
export class InternalModule {}
