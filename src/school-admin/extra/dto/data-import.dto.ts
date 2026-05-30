import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class DataImportDto {
  @IsString()
  @MaxLength(64)
  type: string;

  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  records?: Record<string, unknown>[];
}
