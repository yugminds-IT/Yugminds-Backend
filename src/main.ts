import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());

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

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
