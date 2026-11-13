import { Transform } from 'class-transformer';
import { emailTransform } from '../../common/utils/email.util';
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @Transform(emailTransform)
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}
