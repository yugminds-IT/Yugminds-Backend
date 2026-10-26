import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AcademyRole } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import {
  AcademyAuthGuard,
  type AcademyPrincipal,
  AcademyRoles,
  CurrentAccount,
} from './academy-auth';
import { CommerceService } from './commerce.service';
import { BookingService } from './booking.service';
import { LearningService } from './learning.service';
import {
  CheckoutDto,
  CreateBookingDto,
  QuizSubmitDto,
  VerifyPaymentDto,
} from './academy.dto';

@Public()
@Controller('academy/me')
@UseGuards(AcademyAuthGuard)
@AcademyRoles(AcademyRole.LEARNER)
export class AcademyLearnerController {
  constructor(
    private readonly commerce: CommerceService,
    private readonly bookings: BookingService,
    private readonly learning: LearningService,
  ) {}

  // ─── Learning ──────────────────────────────────────────────────────────────

  @Get('courses')
  courses(@CurrentAccount() a: AcademyPrincipal) {
    return this.learning.myCourses(a.id);
  }

  @Get('courses/:id')
  course(@CurrentAccount() a: AcademyPrincipal, @Param('id') id: string) {
    return this.learning.course(id, a.id);
  }

  @HttpCode(200)
  @Post('lessons/:id/complete')
  complete(@CurrentAccount() a: AcademyPrincipal, @Param('id') id: string) {
    return this.learning.completeLesson(a.id, id);
  }

  @HttpCode(200)
  @Post('lessons/:id/quiz')
  quiz(
    @CurrentAccount() a: AcademyPrincipal,
    @Param('id') id: string,
    @Body() dto: QuizSubmitDto,
  ) {
    return this.learning.submitQuiz(a.id, id, dto.answers);
  }

  @Get('certificates')
  certificates(@CurrentAccount() a: AcademyPrincipal) {
    return this.learning.myCertificates(a.id);
  }

  // ─── Purchases ─────────────────────────────────────────────────────────────

  @Post('checkout')
  checkout(@CurrentAccount() a: AcademyPrincipal, @Body() dto: CheckoutDto) {
    return this.commerce.createCheckout(a.id, dto.productId);
  }

  @HttpCode(200)
  @Post('checkout/verify')
  verify(@CurrentAccount() a: AcademyPrincipal, @Body() dto: VerifyPaymentDto) {
    return this.commerce.verifyCheckout(
      a.id,
      dto.razorpay_order_id,
      dto.razorpay_payment_id,
      dto.razorpay_signature,
    );
  }

  @Get('orders')
  orders(@CurrentAccount() a: AcademyPrincipal) {
    return this.commerce.myOrders(a.id);
  }

  // ─── 1:1 classes ───────────────────────────────────────────────────────────

  @Get('credits')
  credits(@CurrentAccount() a: AcademyPrincipal) {
    return this.bookings.myCredits(a.id);
  }

  @Get('bookings')
  myBookings(@CurrentAccount() a: AcademyPrincipal) {
    return this.bookings.myBookings(a.id);
  }

  @Post('bookings')
  book(@CurrentAccount() a: AcademyPrincipal, @Body() dto: CreateBookingDto) {
    return this.bookings.book(a.id, dto.tutorId, dto.startsAt);
  }

  @HttpCode(200)
  @Post('bookings/:id/cancel')
  cancel(@CurrentAccount() a: AcademyPrincipal, @Param('id') id: string) {
    return this.bookings.cancel({ id: a.id, as: 'learner' }, id);
  }
}
