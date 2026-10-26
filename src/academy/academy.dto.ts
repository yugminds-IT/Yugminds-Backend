import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  AcademyBookingStatus,
  AcademyLessonType,
  AcademyProductType,
} from '@prisma/client';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE = /^[0-9+\-\s]{7,20}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HTTPS = { protocols: ['https'], require_protocol: true };

class StrongPassword {
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

// ─── Auth ──────────────────────────────────────────────────────────────────

export class AcademySignupDto extends StrongPassword {
  @IsString() @MinLength(2) @MaxLength(100) fullName: string;
  @IsEmail() email: string;
  @IsString() @Matches(PHONE) phone: string;
  @IsOptional() @IsString() @MaxLength(100) parentName?: string;
}

export class AcademyLoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) password: string;
}

export class ChangePasswordDto {
  @IsString() currentPassword: string;
  @IsString()
  @MinLength(8)
  @Matches(/[A-Z]/, {
    message: 'Password must contain at least one uppercase letter',
  })
  @Matches(/[a-z]/, {
    message: 'Password must contain at least one lowercase letter',
  })
  @Matches(/[0-9]/, { message: 'Password must contain at least one number' })
  newPassword: string;
}

export class UpdateProfileDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) fullName?: string;
  @IsOptional() @IsString() @Matches(PHONE) phone?: string;
  @IsOptional() @IsString() @MaxLength(100) parentName?: string;
}

// ─── Learning ──────────────────────────────────────────────────────────────

export class QuizSubmitDto {
  @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) answers: number[];
}

// ─── Commerce & bookings ───────────────────────────────────────────────────

export class CheckoutDto {
  @IsString() productId: string;
}

export class VerifyPaymentDto {
  @IsString() razorpay_order_id: string;
  @IsString() razorpay_payment_id: string;
  @IsString() razorpay_signature: string;
}

export class CreateBookingDto {
  @IsString() tutorId: string; // AcademyTutorProfile.id
  @IsISO8601() startsAt: string;
}

export class ProductDto {
  @IsEnum(AcademyProductType) type: AcademyProductType;
  @IsString() @Matches(SLUG) @MaxLength(80) slug: string;
  @IsString() @MinLength(2) @MaxLength(150) title: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
  @IsOptional() @IsString() thumbnailUrl?: string;
  // 0 = free (demo course / trial class), claimable once per learner.
  @IsInt() @Min(0) @Max(100_000_00) priceInPaise: number;
  @IsOptional() @IsInt() @Min(100) mrpInPaise?: number;
  @IsOptional() @IsString() courseId?: string;
  @IsOptional() @IsInt() @Min(15) @Max(240) sessionMinutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) sessionCount?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class TutorProfileDto {
  @IsOptional() @IsString() @MaxLength(150) headline?: string;
  @IsOptional() @IsString() @MaxLength(5000) bio?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  subjects?: string[];
  @IsOptional() @IsString() photoUrl?: string;
  @IsOptional() @IsUrl(HTTPS) defaultMeetingLink?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateTutorDto extends TutorProfileDto {
  @IsString() @MinLength(2) @MaxLength(100) fullName: string;
  @IsEmail() email: string;
  @IsOptional() @IsString() @Matches(PHONE) phone?: string;
}

export class AvailabilityWindowDto {
  @IsInt() @Min(0) @Max(6) dayOfWeek: number;
  @Matches(HHMM) startTime: string;
  @Matches(HHMM) endTime: string;
}

export class AvailabilityDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityWindowDto)
  windows: AvailabilityWindowDto[];
}

export class UpdateBookingDto {
  @IsOptional() @IsUrl(HTTPS) meetingLink?: string;
  @IsOptional() @IsString() @MaxLength(5000) tutorNotes?: string;
  @IsOptional() @IsEnum(AcademyBookingStatus) status?: AcademyBookingStatus;
}

export class GrantCourseDto {
  @IsString() learnerId: string;
  @IsString() courseId: string;
}

// ─── Course builder ────────────────────────────────────────────────────────

export class CourseDto {
  @IsString() @MinLength(2) @MaxLength(150) title: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
  @IsOptional() @IsString() thumbnailUrl?: string;
  @IsOptional() @IsBoolean() isPublished?: boolean;
}

export class ModuleDto {
  @IsString() @MinLength(1) @MaxLength(150) title: string;
}

export class QuizQuestionDto {
  @IsString() @MinLength(1) @MaxLength(1000) question: string;
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  options: string[];
  @IsInt() @Min(0) answer: number;
}

export class LessonDto {
  @IsString() @MinLength(1) @MaxLength(200) title: string;
  @IsEnum(AcademyLessonType) type: AcademyLessonType;
  @IsOptional() @IsString() @MaxLength(2000) contentUrl?: string;
  @IsOptional() @IsString() @MaxLength(200_000) body?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => QuizQuestionDto)
  quiz?: QuizQuestionDto[];
  @IsOptional() @IsInt() @Min(0) @Max(600) durationMinutes?: number;
  @IsOptional() @IsBoolean() isPreview?: boolean;
}

export class MoveDto {
  @IsIn(['up', 'down']) direction: 'up' | 'down';
}
