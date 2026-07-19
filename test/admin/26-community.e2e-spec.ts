import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from './support/app';
import { mintAccessToken, authHeader } from './support/auth';
import { getBootstrapAdmin, closePool } from './support/db';

describe('Admin community CMS: item CRUD + versioning (fixture-only, not featured)', () => {
  let app: INestApplication;
  let adminAuth: [string, string];
  let itemId: string;

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
  }, 60000);

  afterAll(async () => {
    if (itemId) {
      await request(app.getHttpServer())
        .delete(`/admin/community/items/${itemId}`)
        .set(...adminAuth)
        .catch(() => undefined);
    }
    if (app) await app.close();
    await closePool();
  }, 30000);

  it('POST /admin/community/items creates a non-featured profile item (no media required)', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/community/items')
      .set(...adminAuth)
      .field('section_type', 'profile')
      .field('title', '__qa_test__ Community Profile')
      .field('is_published', 'false')
      .field('is_featured', 'false')
      .expect(201);
    itemId = res.body?.item?.id;
    expect(itemId).toBeDefined();
  });

  it('PUT /admin/community/items/:id updates the title and creates a new version', async () => {
    await request(app.getHttpServer())
      .put(`/admin/community/items/${itemId}`)
      .set(...adminAuth)
      .field('title', '__qa_test__ Community Profile Updated')
      .expect(200);

    const versions = await request(app.getHttpServer())
      .get(`/admin/community/items/${itemId}/versions`)
      .set(...adminAuth)
      .expect(200);
    const versionList = versions.body?.data ?? versions.body?.versions ?? versions.body;
    expect(Array.isArray(versionList) ? versionList.length : 0).toBeGreaterThan(0);
  });

  it('GET /admin/community/items/:id reflects the update', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/community/items/${itemId}`)
      .set(...adminAuth)
      .expect(200);
    const item = res.body?.item;
    expect(item.title).toBe('__qa_test__ Community Profile Updated');
  });
});
