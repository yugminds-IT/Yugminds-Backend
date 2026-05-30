import { Controller, UseGuards } from '@nestjs/common';
import { Public } from '../../auth/decorators/public.decorator';
import { InternalGuard } from './internal.guard';
import { InternalService } from './internal.service';

@Controller('internal')
@Public()
@UseGuards(InternalGuard)
export class InternalController {
  constructor(private readonly internalService: InternalService) {}
}
