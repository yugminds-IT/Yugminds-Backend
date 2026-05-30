import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { AuthService, CreateUserOptions } from '../../auth/auth.service';

const VALID_ROLES = ['admin', 'school_admin', 'teacher', 'student'];

@Injectable()
export class CreateAccountService {
  private readonly logger = new Logger(CreateAccountService.name);

  constructor(private readonly authService: AuthService) {}

  async create(body: Record<string, unknown>) {
    const role = String(body.role || 'student');
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const tenantId = (body.tenantId ?? body.school_id) as string | undefined;
    const isSuperAdmin = !!body.is_super_admin;

    if (!email || !password) {
      throw new BadRequestException('Email and password required');
    }
    if (!VALID_ROLES.includes(role)) {
      throw new BadRequestException(
        `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`,
      );
    }

    const dto: CreateUserOptions = {
      email,
      password,
      role: role as CreateUserOptions['role'],
      tenantId: tenantId || undefined,
    };

    const elevate = role === 'admin' ? isSuperAdmin : false;

    try {
      const result = await this.authService.signup(dto, elevate);
      return { success: true, user: result.user };
    } catch (err: unknown) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error(
        'Create account failed',
        err instanceof Error ? err.message : String(err),
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }
  }
}
