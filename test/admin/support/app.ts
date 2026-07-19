import './env';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../../src/app.module';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';

/**
 * Boots one full Nest application per spec file (own Prisma connections,
 * own module graph) — mirrors test/app.e2e-spec.ts, plus the same global
 * pipe/filter wiring main.ts applies in production so error shapes match.
 * Each spec calls this in beforeAll and app.close() in afterAll.
 */
export async function bootstrapApp(): Promise<INestApplication> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}
