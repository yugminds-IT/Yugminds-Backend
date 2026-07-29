import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { generate as generateTotp } from 'otplib';
import { bootstrapApp } from './support/app';
import { mintAccessToken, authHeader } from './support/auth';
import { getBootstrapAdmin, closePool, pool } from './support/db';

// NOTE on scope: `settings/cleanup` (POST /admin/settings/cleanup) hard-deletes
// real inactive users system-wide (role != admin, createdAt older than 30 days,
// no school/teacher/school-admin relation at all — see admin-extra.controller.ts
// cleanupSettings()). That's a genuine destructive operation against whatever
// real orphaned accounts exist in this dev DB, not scoped to any QA fixture, so
// this suite deliberately does NOT invoke it with intent to succeed — only its
// authz boundary is exercised (401/403), same as every other admin route here.

describe('Admin settings / security', () => {
  let app: INestApplication;
  let adminAuth: [string, string];
  let adminId: number;

  const testKey = `qa_test_e2e_setting_${Date.now()}`;
  let originalBackupLast: string | undefined;
  let originalNotificationSettings: string | undefined;

  beforeAll(async () => {
    app = await bootstrapApp();
    const admin = await getBootstrapAdmin();
    adminId = admin.id;
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

    const before = await request(app.getHttpServer())
      .get('/admin/settings')
      .set(...adminAuth)
      .expect(200);
    originalBackupLast = before.body?.settings?.['backup:last'];
    originalNotificationSettings = before.body?.settings?.['settings:notifications'];
  }, 60000);

  afterAll(async () => {
    await pool.query('DELETE FROM "SystemSetting" WHERE key = $1', [testKey]);

    if (originalBackupLast !== undefined) {
      await pool.query(
        `INSERT INTO "SystemSetting" (id, key, value) VALUES (gen_random_uuid(), $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        ['backup:last', originalBackupLast],
      );
    } else {
      await pool.query('DELETE FROM "SystemSetting" WHERE key = $1', ['backup:last']);
    }

    if (originalNotificationSettings !== undefined) {
      await pool.query(
        `INSERT INTO "SystemSetting" (id, key, value) VALUES (gen_random_uuid(), $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        ['settings:notifications', originalNotificationSettings],
      );
    } else {
      await pool.query('DELETE FROM "SystemSetting" WHERE key = $1', [
        'settings:notifications',
      ]);
    }

    // Safety net: MFA test below is expected to clean up after itself, but
    // never leave the real bootstrap admin's account in an "enabled" state.
    await pool.query('DELETE FROM "SystemSetting" WHERE key LIKE $1', [
      `mfa:%:${adminId}%`,
    ]);

    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /admin/settings returns a key/value map', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/settings')
      .set(...adminAuth)
      .expect(200);
    expect(res.body.settings).toBeDefined();
    expect(typeof res.body.settings).toBe('object');
  });

  it('POST /admin/settings upserts a new key, GET reflects it', async () => {
    await request(app.getHttpServer())
      .post('/admin/settings')
      .set(...adminAuth)
      .send({ [testKey]: 'qa-value-1' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/admin/settings')
      .set(...adminAuth)
      .expect(200);
    expect(res.body.settings[testKey]).toBe('qa-value-1');
  });

  it('PATCH /admin/settings updates the same key (alias behavior)', async () => {
    await request(app.getHttpServer())
      .patch('/admin/settings')
      .set(...adminAuth)
      .send({ [testKey]: 'qa-value-2' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/admin/settings')
      .set(...adminAuth)
      .expect(200);
    expect(res.body.settings[testKey]).toBe('qa-value-2');
  });

  it('POST /admin/settings with empty body is a no-op success', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/settings')
      .set(...adminAuth)
      .send({})
      .expect(201);
    expect(res.body.success).toBe(true);
  });

  it('GET and POST /admin/settings/export both return schools/users/courses/settings snapshots', async () => {
    const getRes = await request(app.getHttpServer())
      .get('/admin/settings/export')
      .set(...adminAuth)
      .expect(200);
    expect(Array.isArray(getRes.body.export.schools)).toBe(true);
    expect(Array.isArray(getRes.body.export.users)).toBe(true);
    expect(Array.isArray(getRes.body.export.courses)).toBe(true);
    expect(Array.isArray(getRes.body.export.settings)).toBe(true);
    expect(typeof getRes.body.exported_at).toBe('string');

    const postRes = await request(app.getHttpServer())
      .post('/admin/settings/export')
      .set(...adminAuth)
      .expect(201);
    expect(postRes.body.export).toBeDefined();
  });

  it('POST /admin/settings/backup stores a snapshot under backup:last', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/settings/backup')
      .set(...adminAuth)
      .expect(201);
    expect(res.body.message).toBeDefined();

    const settingsRes = await request(app.getHttpServer())
      .get('/admin/settings')
      .set(...adminAuth)
      .expect(200);
    const stored = settingsRes.body.settings['backup:last'];
    expect(typeof stored).toBe('string');
    const parsed = JSON.parse(stored);
    expect(parsed.export).toBeDefined();
  });

  it('PATCH /admin/settings/notifications stores the payload as JSON', async () => {
    const payload = { emailDigest: true, qaMarker: testKey };
    await request(app.getHttpServer())
      .patch('/admin/settings/notifications')
      .set(...adminAuth)
      .send(payload)
      .expect(200);

    const settingsRes = await request(app.getHttpServer())
      .get('/admin/settings')
      .set(...adminAuth)
      .expect(200);
    const stored = JSON.parse(settingsRes.body.settings['settings:notifications']);
    expect(stored.qaMarker).toBe(testKey);
    expect(stored.emailDigest).toBe(true);
  });

  it('GET /admin/security returns login/mfa overview shape for the caller', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/security')
      .set(...adminAuth)
      .expect(200);
    expect('last_login' in res.body).toBe(true);
    expect(typeof res.body.failed_login_attempts).toBe('number');
    expect(typeof res.body.mfa_enabled).toBe('boolean');
  });

  it('MFA enable -> verify -> disable round-trips cleanly for the caller', async () => {
    const enableRes = await request(app.getHttpServer())
      .post('/admin/security/mfa')
      .set(...adminAuth)
      .send({ action: 'enable' })
      .expect(201);
    expect(typeof enableRes.body.secret).toBe('string');
    expect(typeof enableRes.body.factorId).toBe('string');
    expect(typeof enableRes.body.qr_code).toBe('string');
    expect(enableRes.body.qr_code).toMatch(/^data:image\//);

    const { secret, factorId } = enableRes.body;

    try {
      const code = await generateTotp({ secret });
      const verifyRes = await request(app.getHttpServer())
        .post('/admin/security/mfa')
        .set(...adminAuth)
        .send({ code, factorId })
        .expect(201);
      expect(verifyRes.body.success).toBe(true);

      const securityRes = await request(app.getHttpServer())
        .get('/admin/security')
        .set(...adminAuth)
        .expect(200);
      expect(securityRes.body.mfa_enabled).toBe(true);
    } finally {
      await request(app.getHttpServer())
        .delete('/admin/security/mfa')
        .set(...adminAuth)
        .expect(200);
    }

    const finalSecurityRes = await request(app.getHttpServer())
      .get('/admin/security')
      .set(...adminAuth)
      .expect(200);
    expect(finalSecurityRes.body.mfa_enabled).toBe(false);
  });

  it('MFA verify rejects a wrong code and does not enable MFA', async () => {
    const enableRes = await request(app.getHttpServer())
      .post('/admin/security/mfa')
      .set(...adminAuth)
      .send({ action: 'enable' })
      .expect(201);
    const { factorId } = enableRes.body;

    await request(app.getHttpServer())
      .post('/admin/security/mfa')
      .set(...adminAuth)
      .send({ code: '000000', factorId })
      .expect(400);

    const securityRes = await request(app.getHttpServer())
      .get('/admin/security')
      .set(...adminAuth)
      .expect(200);
    expect(securityRes.body.mfa_enabled).toBe(false);

    await request(app.getHttpServer())
      .delete(`/admin/security/mfa?factorId=${factorId}`)
      .set(...adminAuth)
      .expect(200);
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/admin/settings').expect(401);
    await request(app.getHttpServer()).post('/admin/settings/cleanup').expect(401);
    await request(app.getHttpServer()).get('/admin/security').expect(401);
  });

  it('rejects non-admin roles on settings/cleanup and security', async () => {
    const fakeStudentToken = mintAccessToken({
      id: 999999999,
      email: 'nonexistent@example.test',
      role: 'student',
      isSuperAdmin: false,
      tenantId: null,
      tokenVersion: 0,
    });
    const authHeaderVal = `Bearer ${fakeStudentToken}`;

    const cleanupRes = await request(app.getHttpServer())
      .post('/admin/settings/cleanup')
      .set('Authorization', authHeaderVal);
    expect([401, 403]).toContain(cleanupRes.status);

    const securityRes = await request(app.getHttpServer())
      .get('/admin/security')
      .set('Authorization', authHeaderVal);
    expect([401, 403]).toContain(securityRes.status);
  });
});
