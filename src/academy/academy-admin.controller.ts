import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AcademyRole } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import {
  AcademyAuthGuard,
  type AcademyPrincipal,
  AcademyRoles,
  CurrentAccount,
} from './academy-auth';
import { AcademyAuthService } from './academy-auth.service';
import { CommerceService } from './commerce.service';
import { BookingService } from './booking.service';
import {
  CourseBuilderService,
  MAX_UPLOAD_BYTES,
} from './course-builder.service';
import {
  CourseDto,
  CreateTutorDto,
  GrantCourseDto,
  LessonDto,
  ModuleDto,
  MoveDto,
  ProductDto,
  TutorProfileDto,
} from './academy.dto';

@Public()
@Controller('academy/admin')
@UseGuards(AcademyAuthGuard)
@AcademyRoles(AcademyRole.ADMIN)
export class AcademyAdminController {
  constructor(
    private readonly commerce: CommerceService,
    private readonly bookings: BookingService,
    private readonly builder: CourseBuilderService,
    private readonly auth: AcademyAuthService,
  ) {}

  @Get('overview')
  overview() {
    return this.commerce.overview();
  }

  // ─── Courses (builder) ─────────────────────────────────────────────────────

  @Get('courses')
  courses() {
    return this.builder.listCourses();
  }

  @Post('courses')
  createCourse(@Body() dto: CourseDto) {
    return this.builder.createCourse(dto);
  }

  @Get('courses/:id')
  course(@Param('id') id: string) {
    return this.builder.getCourse(id);
  }

  @Patch('courses/:id')
  updateCourse(@Param('id') id: string, @Body() dto: CourseDto) {
    return this.builder.updateCourse(id, dto);
  }

  @Delete('courses/:id')
  deleteCourse(@Param('id') id: string) {
    return this.builder.deleteCourse(id);
  }

  @Post('courses/:id/modules')
  addModule(@Param('id') courseId: string, @Body() dto: ModuleDto) {
    return this.builder.addModule(courseId, dto);
  }

  @Patch('modules/:id')
  updateModule(@Param('id') id: string, @Body() dto: ModuleDto) {
    return this.builder.updateModule(id, dto);
  }

  @Delete('modules/:id')
  deleteModule(@Param('id') id: string) {
    return this.builder.deleteModule(id);
  }

  @HttpCode(200)
  @Post('modules/:id/move')
  moveModule(@Param('id') id: string, @Body() dto: MoveDto) {
    return this.builder.moveModule(id, dto.direction);
  }

  @Post('modules/:id/lessons')
  addLesson(@Param('id') moduleId: string, @Body() dto: LessonDto) {
    return this.builder.addLesson(moduleId, dto);
  }

  @Patch('lessons/:id')
  updateLesson(@Param('id') id: string, @Body() dto: LessonDto) {
    return this.builder.updateLesson(id, dto);
  }

  @Delete('lessons/:id')
  deleteLesson(@Param('id') id: string) {
    return this.builder.deleteLesson(id);
  }

  @HttpCode(200)
  @Post('lessons/:id/move')
  moveLesson(@Param('id') id: string, @Body() dto: MoveDto) {
    return this.builder.moveLesson(id, dto.direction);
  }

  @Post('uploads')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  upload(
    @UploadedFile()
    file?: {
      buffer: Buffer;
      mimetype: string;
      size: number;
      originalname: string;
    },
  ) {
    return this.builder.upload(file);
  }

  @Get('lms-courses')
  lmsCourses() {
    return this.builder.lmsCourses();
  }

  @Post('lms-courses/:id/import')
  importLms(@Param('id') id: string) {
    return this.builder.importLmsCourse(id);
  }

  // ─── Products & orders ─────────────────────────────────────────────────────

  @Get('products')
  products() {
    return this.commerce.adminProducts();
  }

  @Post('products')
  createProduct(@Body() dto: ProductDto) {
    return this.commerce.saveProduct(dto);
  }

  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() dto: ProductDto) {
    return this.commerce.saveProduct(dto, id);
  }

  @Get('orders')
  orders(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.commerce.adminOrders({
      status,
      search,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @HttpCode(200)
  @Post('orders/:id/refund')
  refund(@Param('id') id: string) {
    return this.commerce.refund(id);
  }

  // ─── People ────────────────────────────────────────────────────────────────

  @Get('learners')
  learners(@Query('search') search?: string) {
    return this.commerce.adminLearners(search);
  }

  @HttpCode(200)
  @Post('learners/grant')
  grant(@Body() dto: GrantCourseDto) {
    return this.commerce.grantCourse(dto.learnerId, dto.courseId);
  }

  @HttpCode(200)
  @Post('accounts/:id/reset-password')
  resetPassword(@Param('id') id: string) {
    return this.auth.resetPassword(id);
  }

  @HttpCode(200)
  @Post('accounts/:id/active')
  setActive(
    @CurrentAccount() a: AcademyPrincipal,
    @Param('id') id: string,
    @Body() body: { isActive?: boolean },
  ) {
    // An admin can't lock themselves out.
    return this.commerce.setAccountActive(
      id,
      id === a.id ? true : body.isActive !== false,
    );
  }

  @Get('tutors')
  tutors() {
    return this.bookings.adminTutors();
  }

  @Post('tutors')
  createTutor(@Body() dto: CreateTutorDto) {
    return this.bookings.createTutor(dto);
  }

  @Patch('tutors/:id')
  updateTutor(@Param('id') id: string, @Body() dto: TutorProfileDto) {
    return this.bookings.adminUpdateTutor(id, dto);
  }

  @Get('bookings')
  allBookings(@Query('from') from?: string, @Query('to') to?: string) {
    return this.bookings.adminBookings(from, to);
  }

  @HttpCode(200)
  @Post('bookings/:id/cancel')
  cancelBooking(
    @CurrentAccount() a: AcademyPrincipal,
    @Param('id') id: string,
  ) {
    return this.bookings.cancel({ id: a.id, as: 'admin' }, id);
  }
}
