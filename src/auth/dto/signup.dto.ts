import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

// Full role set — used internally by admin-only account creation flows.
export const SignupRole = {
  admin: 'admin',
  school_admin: 'school_admin',
  teacher: 'teacher',
  student: 'student',
} as const;
export type SignupRole = (typeof SignupRole)[keyof typeof SignupRole];

// Subset allowed on the public signup endpoint.
export const PublicSignupRole = {
  teacher: 'teacher',
  student: 'student',
} as const;
export type PublicSignupRole =
  (typeof PublicSignupRole)[keyof typeof PublicSignupRole];

export class SignupDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @Matches(/[A-Z]/, {
    message: 'Password must contain at least one uppercase letter',
  })
  @Matches(/[a-z]/, {
    message: 'Password must contain at least one lowercase letter',
  })
  @Matches(/[0-9]/, { message: 'Password must contain at least one number' })
  password: string;

  @IsEnum(PublicSignupRole, { message: 'Role must be teacher or student' })
  role: PublicSignupRole;

  @IsOptional()
  @IsString()
  tenantId?: string;
  // isSuperAdmin is intentionally excluded — public callers cannot elevate privileges.
}
