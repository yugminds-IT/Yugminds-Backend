import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { mintAccessToken, authHeader } from './support/auth';
import { getBootstrapAdmin, closePool } from './support/db';

describe('Admin system-controls: maintenance mode (extreme care, always restored)', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let adminAuth: [string, string];
  let originalControls: {
    maintenance_mode: boolean;
    maintenance_message: string;
  };

  beforeAll(async () => {
    app = await bootstrapApp();
    const admin = await getBootstrapAdmin();
    adminAuth = authHeader(
      mintAccessToken({
        id: admin.id,
        email: admin.email,
        role: 'admin',
        isSuperAdmin: admin.isSuperAdmin,
        tenantId: admin.tenantId,
        tokenVersion: admin.tokenVersion,
      }),
    );
    fixture = await createQaFixture(app);

    const current = await request(app.getHttpServer())
      .get('/admin/system-controls')
      .set(...adminAuth)
      .expect(200);
    originalControls = {
      maintenance_mode: current.body.maintenance_mode,
      maintenance_message: current.body.maintenance_message,
    };
  }, 60000);

  afterAll(async () => {
    // ALWAYS restore, even if an assertion above failed mid-test.
    if (app && originalControls) {
      await request(app.getHttpServer())
        .patch('/admin/system-controls')
        .set(...adminAuth)
        .send(originalControls)
        .catch(() => undefined);
    }
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('toggling maintenance ON blocks the fixture teacher login, admin login still works, then restores', async () => {
    try {
      await request(app.getHttpServer())
        .patch('/admin/system-controls')
        .set(...adminAuth)
        .send({ maintenance_mode: true, maintenance_message: 'QA maintenance window' })
        .expect(200);

      // Wrong password during maintenance: invalid-credentials wins over the
      // maintenance message (checked after password validation in auth.service).
      const wrongPassword = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: fixture.teachers[0].email, password: 'DefinitelyWrong123!' });
      expect(wrongPassword.status).toBe(401);
      expect(wrongPassword.body?.message).not.toMatch(/maintenance/i);

      // Correct password during maintenance: blocked with the maintenance message.
      const blocked = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: fixture.teachers[0].email, password: fixture.teachers[0].password });
      expect(blocked.status).toBe(401);
      expect(blocked.body?.message).toMatch(/QA maintenance window/);

      // Admin is exempt from maintenance mode.
      const adminLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'admin@yugminds.com', password: process.env.ADMIN_SEED_PASSWORD });
      expect([200, 201]).toContain(adminLogin.status);

      // Public status reflects it too.
      const status = await request(app.getHttpServer()).get('/system-status').expect(200);
      expect(status.body.maintenance_mode).toBe(true);
    } finally {
      await request(app.getHttpServer())
        .patch('/admin/system-controls')
        .set(...adminAuth)
        .send(originalControls)
        .expect(200);
    }

    const restored = await request(app.getHttpServer()).get('/system-status').expect(200);
    expect(restored.body.maintenance_mode).toBe(originalControls.maintenance_mode);

    // Login works normally again post-restore.
    const after = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: fixture.teachers[0].email, password: fixture.teachers[0].password });
    expect([200, 201]).toContain(after.status);
  }, 30000);

  it('announcement banner toggles and restores independently', async () => {
    const newAnnouncement = { enabled: true, text: 'QA announcement', level: 'info' as const };
    await request(app.getHttpServer())
      .patch('/admin/system-controls')
      .set(...adminAuth)
      .send({ announcement: newAnnouncement })
      .expect(200);

    const status = await request(app.getHttpServer()).get('/system-status').expect(200);
    expect(status.body.announcement.text).toBe('QA announcement');

    await request(app.getHttpServer())
      .patch('/admin/system-controls')
      .set(...adminAuth)
      .send({ announcement: { enabled: false, text: '', level: 'info' } })
      .expect(200);
  });

  it('feature flags are readable from the public /system-status endpoint, as the admin UI advertises', async () => {
    const before = await request(app.getHttpServer())
      .get('/admin/system-controls')
      .set(...adminAuth)
      .expect(200);
    const originalFlags = before.body.feature_flags;

    try {
      await request(app.getHttpServer())
        .patch('/admin/system-controls')
        .set(...adminAuth)
        .send({ feature_flags: { qa_test_flag: true } })
        .expect(200);

      const status = await request(app.getHttpServer()).get('/system-status').expect(200);
      expect(status.body.feature_flags).toMatchObject({ qa_test_flag: true });
    } finally {
      await request(app.getHttpServer())
        .patch('/admin/system-controls')
        .set(...adminAuth)
        .send({ feature_flags: originalFlags })
        .expect(200);
    }
  });
});
