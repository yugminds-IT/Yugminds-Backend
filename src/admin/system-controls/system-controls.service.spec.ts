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
    await service.update({ maintenance_mode: true, maintenance_message: 'down for QA' });
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
});
