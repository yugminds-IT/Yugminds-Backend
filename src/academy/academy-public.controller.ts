import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { CommerceService } from './commerce.service';
import { BookingService } from './booking.service';
import { LearningService } from './learning.service';
import { RazorpayService } from './razorpay.service';

/** Storefront: catalog, tutors, certificate verification and the payment webhook. No sign-in. */
@Public()
@Controller('academy')
export class AcademyPublicController {
  constructor(
    private readonly commerce: CommerceService,
    private readonly bookings: BookingService,
    private readonly learning: LearningService,
    private readonly razorpay: RazorpayService,
  ) {}

  @Get('products')
  products() {
    return this.commerce.listProducts();
  }

  @Get('products/:slug')
  product(@Param('slug') slug: string) {
    return this.commerce.getProduct(slug);
  }

  @Get('tutors')
  tutors() {
    return this.bookings.listTutors();
  }

  @Get('tutors/:id')
  tutor(@Param('id') id: string) {
    return this.bookings.getTutor(id);
  }

  @Get('tutors/:id/slots')
  slots(@Param('id') id: string, @Query('minutes') minutes?: string) {
    const m = Number(minutes ?? 60);
    if (!Number.isInteger(m) || m < 15 || m > 240)
      throw new BadRequestException('Invalid class length');
    return this.bookings.slots(id, m);
  }

  @Get('certificates/:shortId')
  certificate(@Param('shortId') shortId: string) {
    return this.learning.certificate(shortId);
  }

  @Throttle({ default: { limit: 600, ttl: 60000 } })
  @HttpCode(200)
  @Post('webhooks/razorpay')
  webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-razorpay-signature') signature?: string,
  ) {
    if (
      !req.rawBody ||
      !this.razorpay.verifyWebhookSignature(req.rawBody, signature ?? '')
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return this.commerce.handleWebhook(req.body);
  }
}
