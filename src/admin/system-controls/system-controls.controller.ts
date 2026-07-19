import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Public } from '../../auth/decorators/public.decorator';
import { Role } from '@prisma/client';
import { SystemControlsService, SystemControls } from './system-controls.service';
import { SkipThrottle } from '@nestjs/throttler';

@Controller()
export class SystemControlsController {
  constructor(private readonly controls: SystemControlsService) {}

  @Get('admin/system-controls')
  @UseGuards(RolesGuard)
  @Roles(Role.admin)
  get() {
    return this.controls.get();
  }

  @Patch('admin/system-controls')
  @UseGuards(RolesGuard)
  @Roles(Role.admin)
  update(@Body() body: Partial<SystemControls>) {
    return this.controls.update(body);
  }

  /** Public status any client can read (maintenance banner, announcements). */
  @Public()
  @SkipThrottle()
  @Get('system-status')
  status() {
    return this.controls.publicStatus();
  }
}
