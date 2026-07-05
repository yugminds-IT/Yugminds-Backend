import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import http from 'http';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Disable NestJS request logging in production to reduce I/O overhead
    logger:
      process.env.NODE_ENV === 'production'
        ? ['error', 'warn']
        : ['log', 'error', 'warn', 'debug'],
  });

  // Gzip/Brotli compression — reduces JSON payload size by 70-90%.
  // Must be registered before any body parsers.
  app.use(
    compression({
      level: 6,           // Balanced speed vs ratio (1=fast, 9=smallest)
      threshold: 1024,    // Only compress responses > 1 KB
      filter: (req, res) => {
        // Don't compress SSE streams or already-compressed formats
        const contentType = res.getHeader('Content-Type') as string ?? '';
        if (contentType.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );

  app.use(helmet());

  // SECURITY: In production this API sits behind a reverse proxy / load balancer,
  // so the real client IP arrives in X-Forwarded-For. Tell Express how many proxy
  // hops to trust so `req.ip` resolves to the genuine client and CANNOT be spoofed
  // by a client-supplied X-Forwarded-For header. Rate limiting keys unauthenticated
  // requests (login/signup/refresh) on this IP, so getting it right is what makes
  // the brute-force limits real. Set TRUSTED_PROXY_HOPS to the number of proxies
  // in front of the app (default 1 = single load balancer / CDN).
  const trustedProxyHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1) || 1;
  app.getHttpAdapter().getInstance().set('trust proxy', trustedProxyHops);

  // SECURITY: Use smaller global limit to prevent DoS; override per-route for file uploads
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  // Required for reading httpOnly refresh token cookies in /auth/refresh.
  app.use(cookieParser());

  // SECURITY: Restrict CORS to allowed origins only
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((o) =>
    o.trim(),
  ) ?? ['http://localhost:3000'];
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Cache-Control',
      'x-csrf-token',
      'x-tenant-id',
    ],
    maxAge: 3600,
  });

  const server = app.getHttpServer() as http.Server;

  // Keep-alive: reuse TCP connections for multiple requests (critical at 5k+ users)
  server.keepAliveTimeout = 65_000;   // must be > load-balancer idle timeout (60s)
  server.headersTimeout = 66_000;     // slightly above keepAliveTimeout

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
