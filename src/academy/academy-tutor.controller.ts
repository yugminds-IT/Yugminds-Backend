import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
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
import { BookingService } from './booking.service';
import {
  AvailabilityDto,
  TutorProfileDto,
  UpdateBookingDto,
} from './academy.dto';

/** Academy tutor (TUTOR account + active profile, checked per call). */
@Public()
@Controller('academy/tutor')
@UseGuards(AcademyAuthGuard)
@AcademyRoles(AcademyRole.TUTOR)
export class AcademyTutorController {
  constructor(private readonly bookings: BookingService) {}

  @Get('me')
  me(@CurrentAccount() a: AcademyPrincipal) {
    return this.bookings.requireTutor(a.id);
  }

  @Patch('me')
  updateMe(
    @CurrentAccount() a: AcademyPrincipal,
    @Body() dto: TutorProfileDto,
  ) {
    return this.bookings.updateOwnProfile(a.id, dto);
  }

  @Put('availability')
  availability(
    @CurrentAccount() a: AcademyPrincipal,
    @Body() dto: AvailabilityDto,
  ) {
    return this.bookings.setAvailability(a.id, dto.windows);
  }

  @Get('bookings')
  async list(
    @CurrentAccount() a: AcademyPrincipal,
    @Query('scope') scope?: 'upcoming' | 'past' | 'all',
  ) {
    await this.bookings.requireTutor(a.id);
    return this.bookings.tutorBookings(a.id, scope);
  }

  @Patch('bookings/:id')
  async update(
    @CurrentAccount() a: AcademyPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateBookingDto,
  ) {
    await this.bookings.requireTutor(a.id);
    return this.bookings.updateBooking(a.id, id, dto);
  }

  @HttpCode(200)
  @Post('bookings/:id/cancel')
  async cancel(@CurrentAccount() a: AcademyPrincipal, @Param('id') id: string) {
    await this.bookings.requireTutor(a.id);
    return this.bookings.cancel({ id: a.id, as: 'tutor' }, id);
  }
}
