import { IsString, MinLength } from 'class-validator';

export class NotificationIdParamDto {
  @IsString()
  @MinLength(1)
  id: string;
}
