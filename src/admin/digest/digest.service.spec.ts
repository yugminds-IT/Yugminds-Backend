import { Test, TestingModule } from '@nestjs/testing';
import { DigestService } from './digest.service';
import { DatabaseService } from '../../database/database.service';
import { Role } from '@prisma/client';

describe('DigestService', () => {
  let service: DigestService;
  let db: {
    systemSetting: { findUnique: jest.Mock; upsert: jest.Mock };
    user: { findMany: jest.Mock; count: jest.Mock };
    school: { count: jest.Mock };
    assignmentSubmission: { count: jest.Mock };
    passwordResetRequest: { count: jest.Mock };
    teacherLeave: { count: jest.Mock };
    contactSubmission: { count: jest.Mock };
    notification: { createMany: jest.Mock };
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      systemSetting: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
        count: jest.fn().mockResolvedValue(0),
      },
      school: { count: jest.fn().mockResolvedValue(0) },
      assignmentSubmission: { count: jest.fn().mockResolvedValue(0) },
      passwordResetRequest: { count: jest.fn().mockResolvedValue(0) },
      teacherLeave: { count: jest.fn().mockResolvedValue(0) },
      contactSubmission: { count: jest.fn().mockResolvedValue(0) },
      notification: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
      $queryRaw: jest.fn().mockResolvedValue([{ count: 0n }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [DigestService, { provide: DatabaseService, useValue: db }],
    }).compile();

    service = module.get<DigestService>(DigestService);
  });

  describe('sendWeeklyDigest', () => {
    it('sends to all active admins and records the lock when none exists yet', async () => {
      const result = await service.sendWeeklyDigest();

      expect(result).toEqual({ recipients: 2 });
      expect(db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { role: Role.admin, isActive: true } }),
      );
      expect(db.notification.createMany).toHaveBeenCalledTimes(1);
      expect(db.systemSetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: 'digest:last_sent_at' } }),
      );
    });

    it('skips sending — and does not touch the lock — when one was already sent within the last 6 days', async () => {
      db.systemSetting.findUnique.mockResolvedValue({
        key: 'digest:last_sent_at',
        value: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const result = await service.sendWeeklyDigest();

      expect(result).toEqual({ recipients: 0, skipped: true });
      expect(db.notification.createMany).not.toHaveBeenCalled();
      expect(db.systemSetting.upsert).not.toHaveBeenCalled();
    });

    it('sends again once the lock is older than 6 days', async () => {
      db.systemSetting.findUnique.mockResolvedValue({
        key: 'digest:last_sent_at',
        value: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const result = await service.sendWeeklyDigest();

      expect(result).toEqual({ recipients: 2 });
      expect(db.notification.createMany).toHaveBeenCalledTimes(1);
    });

    it('does not error and skips notification creation when there are no active admins', async () => {
      db.user.findMany.mockResolvedValue([]);

      const result = await service.sendWeeklyDigest();

      expect(result).toEqual({ recipients: 0 });
      expect(db.notification.createMany).not.toHaveBeenCalled();
    });
  });
});
