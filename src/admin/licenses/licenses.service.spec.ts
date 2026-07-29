import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AdminLicensesService } from './licenses.service';
import { DatabaseService } from '../../database/database.service';

describe('AdminLicensesService', () => {
  let service: AdminLicensesService;
  let db: {
    robocodersLicense: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      findUnique: jest.Mock;
    };
    school: { findUnique: jest.Mock };
    tenant: { findUnique: jest.Mock };
  };

  const REAL_ENV = process.env.ROBOCODERS_LICENSE_SECRET;
  const REAL_BUILD = process.env.ROBOCODERS_BUILD_LICENSE_NUMBER;

  beforeAll(() => {
    // A fixed, obviously-fake test secret — never the real one.
    process.env.ROBOCODERS_LICENSE_SECRET =
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  });
  afterAll(() => {
    if (REAL_ENV === undefined) delete process.env.ROBOCODERS_LICENSE_SECRET;
    else process.env.ROBOCODERS_LICENSE_SECRET = REAL_ENV;
    if (REAL_BUILD === undefined) delete process.env.ROBOCODERS_BUILD_LICENSE_NUMBER;
    else process.env.ROBOCODERS_BUILD_LICENSE_NUMBER = REAL_BUILD;
  });

  beforeEach(async () => {
    db = {
      robocodersLicense: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
      },
      school: { findUnique: jest.fn().mockResolvedValue({ id: 'school-1' }) },
      tenant: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminLicensesService,
        { provide: DatabaseService, useValue: db },
      ],
    }).compile();

    service = module.get<AdminLicensesService>(AdminLicensesService);
  });

  describe('generate', () => {
    const validBody = {
      schoolId: 'school-1',
      systemLabel: 'Lab PC 1',
      machineId: 'AABBCCDDEEFF0011',
      durationDays: 365,
    };

    it('rejects when an active, unexpired license already exists for the same school+machineId', async () => {
      db.robocodersLicense.findFirst.mockResolvedValue({
        id: 'existing-1',
        systemLabel: 'Lab PC 1 (old)',
        expiryDate: new Date('2099-01-01T00:00:00Z'),
      });

      await expect(service.generate(validBody)).rejects.toThrow(
        BadRequestException,
      );
      expect(db.robocodersLicense.create).not.toHaveBeenCalled();
    });

    it('allows generating when the existing license for that machine has already expired', async () => {
      db.robocodersLicense.findFirst.mockResolvedValue(null); // expiryDate >= today filter excludes it
      db.robocodersLicense.create.mockResolvedValue({
        id: 'new-1',
        schoolId: 'school-1',
        systemLabel: 'Lab PC 1',
        machineId: 'AABBCCDDEEFF0011',
        licenseNumber: 10001,
        startDate: new Date(),
        expiryDate: new Date(Date.now() + 365 * 86400000),
        durationDays: 365,
        activationKey: 'X',
        notes: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expect(service.generate(validBody)).resolves.toBeDefined();
      expect(db.robocodersLicense.create).toHaveBeenCalled();
    });

    it('rejects when the school does not exist', async () => {
      db.school.findUnique.mockResolvedValue(null);
      await expect(service.generate(validBody)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('list', () => {
    it('queries without a schoolId filter when none is given (all-schools mode)', async () => {
      await service.list({});
      expect(db.robocodersLicense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.not.objectContaining({ schoolId: expect.anything() }) }),
      );
    });

    it('applies a schoolId filter when given', async () => {
      await service.list({ schoolId: 'school-1' });
      expect(db.robocodersLicense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ schoolId: 'school-1' }) }),
      );
    });

    it('applies a search filter across system label, machine id, and activation key', async () => {
      await service.list({ search: 'lab' });
      const where = db.robocodersLicense.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { systemLabel: { contains: 'lab', mode: 'insensitive' } },
        { machineId: { contains: 'lab', mode: 'insensitive' } },
        { activationKey: { contains: 'lab', mode: 'insensitive' } },
      ]);
    });

    it('applies status=active as isActive + date-window filters', async () => {
      await service.list({ status: 'active' });
      const where = db.robocodersLicense.findMany.mock.calls[0][0].where;
      expect(where.isActive).toBe(true);
      expect(where.startDate).toEqual({ lte: expect.any(Date) });
      expect(where.expiryDate).toEqual({ gte: expect.any(Date) });
    });
  });

  describe('serialize (via list) — days_remaining consistency', () => {
    it('reports 1 day remaining (not 0) when today is the expiry day itself', async () => {
      const today = new Date(
        Date.UTC(
          new Date().getUTCFullYear(),
          new Date().getUTCMonth(),
          new Date().getUTCDate(),
        ),
      );
      db.robocodersLicense.findMany.mockResolvedValue([
        {
          id: 'r1',
          schoolId: 'school-1',
          systemLabel: 'Lab PC 1',
          machineId: 'AABBCCDDEEFF0011',
          licenseNumber: 10001,
          startDate: new Date(today.getTime() - 30 * 86400000),
          expiryDate: today,
          durationDays: 30,
          activationKey: 'X',
          notes: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const { licenses } = await service.list({});
      expect(licenses[0].is_expired).toBe(false);
      expect(licenses[0].days_remaining).toBe(1);
    });
  });
});
