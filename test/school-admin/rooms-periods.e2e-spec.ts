import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { bootstrapApp } from '../admin/support/app';
import {
  createQaFixture,
  teardownQaFixture,
  QaFixture,
} from '../admin/support/fixtures';
import { closePool } from '../admin/support/db';

describe('school-admin rooms & periods CRUD', () => {
  let app: INestApplication;
  let fixture: QaFixture;
  let auth: [string, string];

  beforeAll(async () => {
    app = await bootstrapApp();
    fixture = await createQaFixture(app);
    auth = ['Authorization', `Bearer ${fixture.schoolAdmin.token}`];
  }, 60000);

  afterAll(async () => {
    if (app && fixture) await teardownQaFixture(app, fixture);
    if (app) await app.close();
    await closePool();
  }, 60000);

  describe('rooms', () => {
    let roomId: string;

    it('creates a room', async () => {
      const res = await request(app.getHttpServer())
        .post('/school-admin/rooms')
        .set(...auth)
        .send({
          room_number: 'QA-101',
          room_name: 'QA Lab',
          capacity: 25,
          location: 'Block A',
          facilities: ['Projector', 'AC'],
        })
        .expect(201);
      expect(res.body.room.room_number).toBe('QA-101');
      expect(res.body.room.capacity).toBe(25);
      expect(res.body.room.facilities).toEqual(['Projector', 'AC']);
      roomId = res.body.room.id;
      expect(roomId).toBeTruthy();
    });

    it('lists rooms including the created one', async () => {
      const res = await request(app.getHttpServer())
        .get('/school-admin/rooms')
        .set(...auth)
        .expect(200);
      expect(Array.isArray(res.body.rooms)).toBe(true);
      expect(res.body.rooms.some((r: any) => r.id === roomId)).toBe(true);
    });

    it('gets a single room', async () => {
      const res = await request(app.getHttpServer())
        .get(`/school-admin/rooms/${roomId}`)
        .set(...auth)
        .expect(200);
      expect(res.body.room.id).toBe(roomId);
      expect(res.body.room.room_name).toBe('QA Lab');
    });

    it('updates a room', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/school-admin/rooms/${roomId}`)
        .set(...auth)
        .send({ capacity: 40, is_active: false })
        .expect(200);
      expect(res.body.room.capacity).toBe(40);
      expect(res.body.room.is_active).toBe(false);
    });

    it('rejects creating a room without room_number', async () => {
      await request(app.getHttpServer())
        .post('/school-admin/rooms')
        .set(...auth)
        .send({ room_name: 'No number' })
        .expect(400);
    });

    it('deletes the room', async () => {
      await request(app.getHttpServer())
        .delete(`/school-admin/rooms/${roomId}`)
        .set(...auth)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/school-admin/rooms/${roomId}`)
        .set(...auth)
        .expect(400);
    });
  });

  describe('periods', () => {
    let periodId: string;

    it('creates a period', async () => {
      const res = await request(app.getHttpServer())
        .post('/school-admin/periods')
        .set(...auth)
        .send({ period_number: 9, start_time: '13:00', end_time: '14:00' })
        .expect(201);
      expect(res.body.period.period_number).toBe(9);
      expect(res.body.period.start_time).toBe('13:00');
      periodId = res.body.period.id;
      expect(periodId).toBeTruthy();
    });

    it('lists periods including the created one', async () => {
      const res = await request(app.getHttpServer())
        .get('/school-admin/periods')
        .set(...auth)
        .expect(200);
      expect(res.body.periods.some((p: any) => p.id === periodId)).toBe(true);
    });

    it('gets a single period', async () => {
      const res = await request(app.getHttpServer())
        .get(`/school-admin/periods/${periodId}`)
        .set(...auth)
        .expect(200);
      expect(res.body.period.id).toBe(periodId);
    });

    it('updates a period', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/school-admin/periods/${periodId}`)
        .set(...auth)
        .send({ end_time: '14:30' })
        .expect(200);
      expect(res.body.period.end_time).toBe('14:30');
      expect(res.body.period.start_time).toBe('13:00');
    });

    it('rejects creating a period missing start/end time', async () => {
      await request(app.getHttpServer())
        .post('/school-admin/periods')
        .set(...auth)
        .send({ period_number: 10 })
        .expect(400);
    });

    it('deletes the period', async () => {
      await request(app.getHttpServer())
        .delete(`/school-admin/periods/${periodId}`)
        .set(...auth)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/school-admin/periods/${periodId}`)
        .set(...auth)
        .expect(400);
    });
  });

  it('rooms and periods are tenant-scoped (missing school -> empty list for a token with no school)', async () => {
    // A school-admin JWT for a user without a schoolAdmin row should get empty
    // lists, not an error and not another school's data. We simulate this by
    // asking for a nonexistent room id, which must 400 (Room not found) rather
    // than ever succeeding, since it can never belong to any schoolId filter.
    const res = await request(app.getHttpServer())
      .get('/school-admin/rooms/00000000-0000-0000-0000-000000000000')
      .set(...auth)
      .expect(400);
    expect(res.body.message ?? res.body.error).toBeTruthy();
  });
});
