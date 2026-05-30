import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class InternalGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<any>();
    const logger = new Logger(InternalGuard.name);

    const configured = String(
      this.config.get<string>('INTERNAL_API_KEY') ?? '',
    ).trim();
    if (!configured) {
      throw new ForbiddenException('Internal API key is not configured');
    }

    const raw = req.headers['x-internal-api-key'];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided || String(provided).trim() !== configured) {
      logger.warn(
        `Internal API access denied: ${req.method} ${req.originalUrl ?? req.url} ip=${req.ip}`,
      );
      throw new ForbiddenException('Invalid internal API token');
    }

    logger.log(
      `Internal API access granted: ${req.method} ${req.originalUrl ?? req.url} ip=${req.ip}`,
    );
    return true;
  }
}
