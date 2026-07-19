import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { DigestService } from './digest.service';

@Controller('admin/digest')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class DigestController {
  constructor(private readonly digest: DigestService) {}

  /** Preview this week's digest without sending it. */
  @Get('preview')
  preview() {
    return this.digest.buildDigest();
  }

  /** Send the digest to all admins now (same as the Monday cron). */
  @Post('run')
  run() {
    return this.digest.sendWeeklyDigest();
  }
}
