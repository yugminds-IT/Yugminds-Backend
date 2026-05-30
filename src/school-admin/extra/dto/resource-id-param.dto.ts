import { IsString, MinLength } from 'class-validator';

export class ResourceIdParamDto {
  @IsString()
  @MinLength(1)
  id: string;
}
