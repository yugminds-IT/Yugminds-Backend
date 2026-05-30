import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class SimpleProgressDto {
  // Note: frontend sends camelCase (`courseId`, `chapterId`, `isCompleted`).
  // We accept these directly and map them to DB fields.
  @IsString()
  courseId: string;

  @IsOptional()
  @IsString()
  chapterId?: string;

  @IsOptional()
  @IsString()
  contentId?: string;

  @IsBoolean()
  isCompleted: boolean;
}
