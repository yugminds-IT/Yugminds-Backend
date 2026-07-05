import { Module } from '@nestjs/common';
import { SeedService } from './seed.service';
import { DatabaseModule } from '../../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [SeedService],
})
export class SeedModule {}
