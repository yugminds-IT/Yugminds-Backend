import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AdminProfileService } from './profile.service';
import { DatabaseService } from '../../database/database.service';

describe('AdminProfileService', () => {
  let service: AdminProfileService;
  let db: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    profile: { upsert: jest.Mock };
  };

  const adminUser = {
    id: 1,
    email: 'admin@yugminds.com',
    password: 'hashed',
    role: 'admin',
    isSuperAdmin: false,
    profile: { fullName: 'Yugminds Admin' },
  };

  beforeEach(async () => {
    db = {
      user: {
        findUnique: jest.fn().mockResolvedValue(adminUser),
        update: jest.fn().mockResolvedValue({}),
      },
      profile: { upsert: jest.fn().mockResolvedValue({}) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminProfileService,
        { provide: DatabaseService, useValue: db },
      ],
    }).compile();

    service = module.get<AdminProfileService>(AdminProfileService);
  });

  describe('get', () => {
    it('maps Profile.fullName to full_name and strips the password hash', async () => {
      const result = await service.get(1);
      expect(result.full_name).toBe('Yugminds Admin');
      expect((result as { password?: string }).password).toBeUndefined();
      expect((result as { email?: string }).email).toBe('admin@yugminds.com');
    });

    it('returns undefined full_name when the admin has no Profile row (data-provisioning gap)', async () => {
      db.user.findUnique.mockResolvedValue({ ...adminUser, profile: null });
      const result = await service.get(1);
      expect(result.full_name).toBeUndefined();
    });

    it('throws NotFoundException for a missing user', async () => {
      db.user.findUnique.mockResolvedValue(null);
      await expect(service.get(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('upserts the Profile row with the trimmed full_name', async () => {
      db.user.findUnique
        .mockResolvedValueOnce(adminUser) // permission check
        .mockResolvedValueOnce({ ...adminUser, profile: { fullName: 'New Name' } }); // final fetch

      await service.update(1, { full_name: '  New Name  ' });

      expect(db.profile.upsert).toHaveBeenCalledWith({
        where: { userId: 1 },
        create: { userId: 1, fullName: 'New Name' },
        update: { fullName: 'New Name' },
      });
    });

    it('rejects non-admin, non-super-admin users', async () => {
      db.user.findUnique.mockResolvedValue({ ...adminUser, role: 'teacher', isSuperAdmin: false });
      await expect(service.update(1, { full_name: 'x' })).rejects.toThrow(ForbiddenException);
      expect(db.profile.upsert).not.toHaveBeenCalled();
    });

    it('ignores a blank full_name instead of clearing it', async () => {
      db.user.findUnique
        .mockResolvedValueOnce(adminUser)
        .mockResolvedValueOnce(adminUser);

      await service.update(1, { full_name: '   ' });

      expect(db.profile.upsert).not.toHaveBeenCalled();
    });
  });
});
