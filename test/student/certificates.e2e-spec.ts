import request from 'supertest';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import { authHeader } from '../admin/support/auth';
import { closePool, pool } from '../admin/support/db';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';

/**
 * Regression coverage for GET /student/certificates' issued_by field: it
 * used to never query the StudentCertificate.issuedBy relation at all, and
 * instead populated a "profiles.full_name" field from the certificate's
 * RECIPIENT (the student's own profile) — so a certificate manually issued
 * by an admin/teacher showed the student as their own issuer, and every
 * auto-issued certificate had no honest fallback either.
 *
 * Inserts StudentCertificate rows directly via SQL (rather than going
 * through the admin batch-generate flow, which requires real course
 * progress to be eligible) to isolate this endpoint's response mapping.
 */
describe('Student certificates — issued_by resolution', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let studentAuth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    studentAuth = authHeader(fixture.students[0].token);
  }, 90000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 90000);

  it(
    'a manually-issued certificate shows the real issuing admin, not the ' +
      "student's own name",
    async () => {
      const certId = randomUUID();
      await pool.query(
        `INSERT INTO "StudentCertificate"
           (id, "studentId", "courseId", "certificateName", "certificateUrl", status, "issuedBy")
         VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
        [
          certId,
          fixture.students[0].id,
          fixture.courseId,
          'QA Manual Certificate',
          'pending',
          fixture.admin.id,
        ],
      );

      const res = await request(app.getHttpServer())
        .get('/student/certificates')
        .set(...studentAuth)
        .expect(200);
      const found = res.body.certificates.find(
        (c: { id: string }) => c.id === certId,
      );
      expect(found).toBeDefined();
      expect(found.issued_by).toBeDefined();
      expect(found.issued_by).not.toBe(fixture.students[0].email);
      expect(found.issued_by).not.toBe('Yugminds');
    },
  );

  it(
    "an auto-issued certificate (issuedBy null) shows 'Yugminds' as the " +
      'issuer, not the student themselves',
    async () => {
      const certId = randomUUID();
      await pool.query(
        `INSERT INTO "StudentCertificate"
           (id, "studentId", "courseId", "certificateName", "certificateUrl", status, "issuedBy")
         VALUES ($1, $2, $3, $4, $5, 'active', NULL)`,
        [
          certId,
          fixture.students[1].id,
          fixture.courseId,
          'QA Auto Certificate',
          'pending',
        ],
      );

      const res = await request(app.getHttpServer())
        .get('/student/certificates')
        .set(...authHeader(fixture.students[1].token))
        .expect(200);
      const found = res.body.certificates.find(
        (c: { id: string }) => c.id === certId,
      );
      expect(found).toBeDefined();
      expect(found.issued_by).toBe('Yugminds');
    },
  );
});
