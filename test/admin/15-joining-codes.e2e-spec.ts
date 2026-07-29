import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { createQaFixture, teardownQaFixture, QaFixture } from './support/fixtures';
import { authHeader } from './support/auth';
import { closePool, pool } from './support/db';

describe('Admin joining-codes CRUD', () => {
  let app: INestApplication;
  let fixture: QaFixture;

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  it('GET /admin/joining-codes?schoolId=... lists the auto-generated codes', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/joining-codes?schoolId=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const list = res.body?.data ?? res.body;
    const codes = Array.isArray(list) ? list : (list?.codes ?? list?.joinCodes ?? []);
    expect(codes.length).toBeGreaterThan(0);
  });

  it('GET /admin/joining-codes with schoolId=undefined string does not 500', async () => {
    // Regression check for the frontend bug where JoiningCodesDialog sends
    // `schoolId || "undefined"` as a literal string when nothing is
    // selected — the backend must not blow up on that value.
    const res = await request(app.getHttpServer())
      .get('/admin/joining-codes?schoolId=undefined')
      .set(...authHeader(fixture.admin.token));
    expect(res.status).toBeLessThan(500);
  });

  it('POST /admin/joining-codes creates a new code for a grade', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/joining-codes')
      .set(...authHeader(fixture.admin.token))
      .send({ schoolId: fixture.schoolId, grades: [fixture.grade] })
      .expect(201);
    expect(res.body).toBeDefined();
  });

  it('PATCH /admin/joining-codes deactivates a code', async () => {
    const list = await request(app.getHttpServer())
      .get(`/admin/joining-codes?schoolId=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const codesBody = list.body?.data ?? list.body;
    const codes = Array.isArray(codesBody) ? codesBody : (codesBody?.codes ?? codesBody?.joinCodes ?? []);
    const target = codes[0];
    expect(target).toBeDefined();

    await request(app.getHttpServer())
      .patch('/admin/joining-codes')
      .set(...authHeader(fixture.admin.token))
      .send({ codeId: target.id, isActive: false })
      .expect(200);
  });

  it('a newly created code has a real expiration date set (~1 year out), not null', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/joining-codes')
      .set(...authHeader(fixture.admin.token))
      .send({ schoolId: fixture.schoolId, grades: [fixture.grade] })
      .expect(201);
    const code = res.body?.codes?.[fixture.grade];
    expect(code).toBeDefined();

    const list = await request(app.getHttpServer())
      .get(`/admin/joining-codes?schoolId=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const codesBody = list.body?.data ?? list.body;
    const codes = Array.isArray(codesBody) ? codesBody : (codesBody?.codes ?? []);
    const created = codes.find((c: { code: string }) => c.code === code);
    expect(created).toBeDefined();
    expect(created.expires_at).toBeTruthy();
    const daysOut =
      (new Date(created.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(daysOut).toBeGreaterThan(350);
    expect(daysOut).toBeLessThan(380);
  });

  it('a single-use code can only register ONE student, then is rejected', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/admin/joining-codes')
      .set(...authHeader(fixture.admin.token))
      .send({ schoolId: fixture.schoolId, grades: [fixture.grade], usageType: 'single' })
      .expect(201);
    const code = createRes.body?.codes?.[fixture.grade];
    expect(code).toBeDefined();

    const suffix = Date.now().toString(36);
    const firstEmail = `__qa_test_singleuse_${suffix}_1@example.test`;
    const secondEmail = `__qa_test_singleuse_${suffix}_2@example.test`;

    // First registration succeeds.
    const first = await request(app.getHttpServer())
      .post('/validate-joining-code')
      .send({
        code,
        studentData: {
          full_name: 'QA Single Use One',
          email: firstEmail,
          password: 'QaTest123!',
        },
      })
      .expect(201);
    expect(first.body.success).toBe(true);

    // Second registration with the SAME single-use code must be rejected —
    // this is the bug: usageType='single' alone (no explicit maxUses) used
    // to never be enforced by ValidateJoiningCodeService.validate().
    const second = await request(app.getHttpServer())
      .post('/validate-joining-code')
      .send({
        code,
        studentData: {
          full_name: 'QA Single Use Two',
          email: secondEmail,
          password: 'QaTest123!',
        },
      })
      .expect(201);
    expect(second.body.success).toBe(false);
    // Rejected either by the new usageType==='single' check directly, or by
    // the maxUses=1 default now applied to single-use codes at creation —
    // both are correct, independent layers of the same fix.
    const rejectionMsg = String(second.body.error ?? '').toLowerCase();
    expect(
      rejectionMsg.includes('already been used') || rejectionMsg.includes('maximum uses'),
    ).toBe(true);

    // Clean up the one real user account this test created (the second
    // registration was correctly rejected, so only the first exists).
    await pool.query(`DELETE FROM "User" WHERE email = $1`, [firstEmail]);
  });

  it('usageType=single is enforced even with maxUses explicitly cleared (isolates the core fix)', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/admin/joining-codes')
      .set(...authHeader(fixture.admin.token))
      .send({ schoolId: fixture.schoolId, grades: [fixture.grade], usageType: 'single' })
      .expect(201);
    const code = createRes.body?.codes?.[fixture.grade];
    expect(code).toBeDefined();

    const list = await request(app.getHttpServer())
      .get(`/admin/joining-codes?schoolId=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const codesBody = list.body?.data ?? list.body;
    const codes = Array.isArray(codesBody) ? codesBody : (codesBody?.codes ?? []);
    const target = codes.find((c: { code: string }) => c.code === code);
    expect(target).toBeDefined();

    // Explicitly clear maxUses so ONLY the usageType==='single' check in
    // ValidateJoiningCodeService.validate() can possibly reject a second use.
    await request(app.getHttpServer())
      .patch('/admin/joining-codes')
      .set(...authHeader(fixture.admin.token))
      .send({ codeId: target.id, maxUses: null })
      .expect(200);

    const suffix = Date.now().toString(36);
    const email = `__qa_test_singleuse_isolated_${suffix}@example.test`;

    const first = await request(app.getHttpServer())
      .post('/validate-joining-code')
      .send({
        code,
        studentData: { full_name: 'QA Isolated', email, password: 'QaTest123!' },
      })
      .expect(201);
    expect(first.body.success).toBe(true);

    const second = await request(app.getHttpServer())
      .post('/validate-joining-code')
      .send({ code })
      .expect(201);
    expect(second.body.is_valid).toBe(false);
    expect(String(second.body.message ?? '').toLowerCase()).toContain('already been used');

    await pool.query(`DELETE FROM "User" WHERE email = $1`, [email]);
  });

  it('DELETE /admin/joining-codes/:id permanently removes a code', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/admin/joining-codes')
      .set(...authHeader(fixture.admin.token))
      .send({ schoolId: fixture.schoolId, grades: [fixture.grade] })
      .expect(201);
    const code = createRes.body?.codes?.[fixture.grade];

    const list = await request(app.getHttpServer())
      .get(`/admin/joining-codes?schoolId=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const codesBody = list.body?.data ?? list.body;
    const codes = Array.isArray(codesBody) ? codesBody : (codesBody?.codes ?? []);
    const target = codes.find((c: { code: string }) => c.code === code);
    expect(target).toBeDefined();

    await request(app.getHttpServer())
      .delete(`/admin/joining-codes/${target.id}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);

    const after = await request(app.getHttpServer())
      .get(`/admin/joining-codes?schoolId=${fixture.schoolId}`)
      .set(...authHeader(fixture.admin.token))
      .expect(200);
    const afterBody = after.body?.data ?? after.body;
    const afterCodes = Array.isArray(afterBody) ? afterBody : (afterBody?.codes ?? []);
    expect(afterCodes.some((c: { id: string }) => c.id === target.id)).toBe(false);

    // Deleting an id that no longer exists is a client error, not a 500/200.
    const res = await request(app.getHttpServer())
      .delete(`/admin/joining-codes/${target.id}`)
      .set(...authHeader(fixture.admin.token));
    expect(res.status).toBe(400);
  });
});
