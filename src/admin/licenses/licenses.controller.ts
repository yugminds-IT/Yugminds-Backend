import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RolesGuard } from '../../auth/roles/roles.guard';
import { Role } from '@prisma/client';
import { AdminLicensesService } from './licenses.service';

@Controller('admin/licenses')
@UseGuards(RolesGuard)
@Roles(Role.admin)
export class AdminLicensesController {
  constructor(private readonly service: AdminLicensesService) {}

  @Get()
  list(
    @Query('schoolId') schoolId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.service.list({ schoolId, status, search });
  }

  @Post()
  generate(@Body() body: Record<string, unknown>) {
    return this.service.generate(body);
  }

  @Post('import')
  import(@Body() body: Record<string, unknown>) {
    return this.service.import(body);
  }

  @Post('decode')
  decode(@Body() body: { activationKey?: string }) {
    return this.service.decode(body?.activationKey ?? '');
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
