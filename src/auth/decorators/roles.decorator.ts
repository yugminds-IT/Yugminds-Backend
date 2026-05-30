import { SetMetadata } from '@nestjs/common';
import { Role } from '../types/role.type';

export const ROLES_KEY = 'roles';

/**
 * Restrict route access to specific roles.
 * Use with RolesGuard. Super admins bypass role check.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
