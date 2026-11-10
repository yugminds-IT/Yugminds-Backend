import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class ResetPasswordDto {
  /** Required unless the account is in forced-change mode (mustChangePassword). */
  @IsOptional()
  @IsString()
  current_password?: string;

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
}
