import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';

@Controller()
export class AppController {
  // Simple root endpoint so accidental probes to `/` don't spam logs with 404s.
  @Public()
  @Get()
  root() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
