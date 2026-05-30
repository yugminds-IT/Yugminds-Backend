import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '../../auth/decorators/public.decorator';
import { ValidateJoiningCodeService } from './validate-joining-code.service';

@Controller('validate-joining-code')
export class ValidateJoiningCodeController {
  constructor(private readonly service: ValidateJoiningCodeService) {}

  @Public()
  @Post()
  async validate(
    @Body()
    body: {
      code?: string;
      studentData?: {
        full_name?: string;
        email?: string;
        password?: string;
        parent_name?: string;
        parent_phone?: string;
      };
    },
  ) {
    const code = body?.code != null ? String(body.code).trim() : '';
    const studentData = body.studentData;

    if (
      studentData &&
      typeof studentData === 'object' &&
      studentData.email &&
      studentData.password
    ) {
      return this.service.validateAndRegister(code, {
        full_name: studentData.full_name ?? '',
        email: studentData.email,
        password: studentData.password,
        parent_name: studentData.parent_name,
        parent_phone: studentData.parent_phone,
      });
    }

    return this.service.validate(code);
  }
}
