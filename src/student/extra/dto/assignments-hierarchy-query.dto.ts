import { IsOptional, IsString } from 'class-validator';

export class AssignmentsHierarchyQueryDto {
  @IsOptional()
  @IsString()
  course_id?: string;
}
