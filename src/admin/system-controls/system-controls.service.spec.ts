import { Test, TestingModule } from '@nestjs/testing';
import { SystemControlsService } from './system-controls.service';
import { DatabaseService } from '../../database/database.service';

describe('SystemControlsService', () => {
  let service: SystemControlsService;
  let rows: Array<{ key: string; value: string }>;
  let db: {
    systemSetting: { findMany: jest.Mock; upsert: jest.Mock };
  };

  beforeEach(async () => {
    rows = [];
    db = {
      systemSetting: {
        findMany: jest.fn(() => Promise.resolve(rows)),
        upsert: jest.fn(({ where, create }: any) => {
          const existing = rows.find((r) => r.key === where.key);
          if (existing) existing.value = create.value;
          else rows.push({ key: where.key, value: create.value });
          return Promise.resolve();
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemControlsService,
        { provide: DatabaseService, useValue: db },
      ],
    }).compile();

    service = module.get<SystemControlsService>(SystemControlsService);
  });

  it('defaults to maintenance off and empty feature flags', async () => {
    const controls = await service.get();
    expect(controls.maintenance_mode).toBe(false);
    expect(controls.feature_flags).toEqual({});
  });

  it('publicStatus exposes feature_flags (the UI advertises GET /system-status as a read path for them)', async () => {
    await service.update({ feature_flags: { new_dashboard: true } });
    const status = await service.publicStatus();
    expect(status.feature_flags).toEqual({ new_dashboard: true });
  });

  it('isMaintenanceActive reflects the persisted maintenance state (single source of truth used by auth.service)', async () => {
    await service.update({
      maintenance_mode: true,
      maintenance_message: 'down for QA',
    });
    const result = await service.isMaintenanceActive();
    expect(result).toEqual({ active: true, message: 'down for QA' });
  });

  it('rejects invalid feature flag names and caps at 100 flags', async () => {
    const tooMany: Record<string, boolean> = {};
    for (let i = 0; i < 105; i++) tooMany[`flag_${i}`] = true;
    tooMany['bad name!'] = true;

    await service.update({ feature_flags: tooMany });
    const controls = await service.get();

    expect(controls.feature_flags['bad name!']).toBeUndefined();
    expect(Object.keys(controls.feature_flags).length).toBeLessThanOrEqual(100);
  });

  it('invalidates the read cache on update so a save is immediately visible', async () => {
    await service.get(); // warms the cache
    await service.update({ maintenance_mode: true });
    const controls = await service.get();
    expect(controls.maintenance_mode).toBe(true);
  });

  describe('maintenance message', () => {
    const DEFAULT =
      'Yugminds is undergoing scheduled maintenance. Please check back shortly.';

    it('falls back to the default when the saved message is blank, so people never read an empty message', async () => {
      await service.update({
        maintenance_mode: true,
        maintenance_message: '   ',
      });
      expect((await service.isMaintenanceActive()).message).toBe(DEFAULT);
      expect((await service.publicStatus()).maintenance_message).toBe(DEFAULT);
    });

    it('trims the message and keeps it to 500 characters', async () => {
      await service.update({ maintenance_message: `  ${'x'.repeat(600)}  ` });
      expect((await service.get()).maintenance_message).toBe('x'.repeat(500));
    });

    it('keeps a real message as written', async () => {
      await service.update({ maintenance_message: 'Back at 6 pm.' });
      expect((await service.get()).maintenance_message).toBe('Back at 6 pm.');
    });
  });

  describe('announcement', () => {
    it('cleans the level and the length', async () => {
      await service.update({
        announcement: {
          enabled: true,
          text: 'y'.repeat(900),
          level: 'nonsense' as never,
        },
      });
      expect((await service.get()).announcement).toEqual({
        enabled: true,
        text: 'y'.repeat(500),
        level: 'info',
      });
    });

    it('changing only one part leaves the rest as it was, instead of wiping the text', async () => {
      await service.update({
        announcement: {
          enabled: true,
          text: 'Report cards on Friday',
          level: 'warning',
        },
      });
      await service.update({ announcement: { enabled: false } as never });
      expect((await service.get()).announcement).toEqual({
        enabled: false,
        text: 'Report cards on Friday',
        level: 'warning',
      });
    });
  });

  describe('saving one section does not touch the others', () => {
    it('updating only the announcement leaves maintenance mode and flags alone', async () => {
      await service.update({
        maintenance_mode: true,
        feature_flags: { beta: true },
      });
      await service.update({
        announcement: { enabled: true, text: 'Hello', level: 'info' },
      });
      const c = await service.get();
      expect(c.maintenance_mode).toBe(true);
      expect(c.feature_flags).toEqual({ beta: true });
    });
  });

  describe('damaged stored values do not break the status', () => {
    it('falls back to safe values when the stored JSON has the wrong shape', async () => {
      rows.push(
        { key: 'announcement', value: '"just a string"' },
        { key: 'feature_flags', value: '[1,2,3]' },
      );
      const s = await service.publicStatus();
      expect(s.announcement).toEqual({
        enabled: false,
        text: '',
        level: 'info',
      });
      expect(s.feature_flags).toEqual({});
    });

    it('keeps only real on/off values and an allowed level from stored data', async () => {
      rows.push(
        {
          key: 'announcement',
          value: JSON.stringify({ enabled: 'yes', text: 42, level: 'purple' }),
        },
        {
          key: 'feature_flags',
          value: JSON.stringify({ ok: true, bad: 'yes', also_ok: false }),
        },
      );
      const s = await service.publicStatus();
      expect(s.announcement).toEqual({
        enabled: false,
        text: '',
        level: 'info',
      });
      expect(s.feature_flags).toEqual({ ok: true, also_ok: false });
    });
  });
});
