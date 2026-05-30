import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class BatchGenerateCertificatesDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  course_ids?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  student_ids?: string[];

  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}
