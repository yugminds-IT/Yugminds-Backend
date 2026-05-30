import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { CreateAccountService } from './create-account.service';

@Controller('admin/create-account')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class CreateAccountController {
  constructor(private readonly service: CreateAccountService) {}

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.service.create(body);
  }
}
