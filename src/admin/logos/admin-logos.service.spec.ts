import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AdminLogosService } from './admin-logos.service';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../../common/storage/storage.service';

/** Minimal valid PNG buffer carrying the given IHDR width/height. */
function pngWithDims(w: number, h: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0);
  ihdrData.writeUInt32BE(h, 4);
  const crc = Buffer.alloc(4);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc]);
}

describe('AdminLogosService', () => {
  let service: AdminLogosService;
  let db: {
    logo: {
      findMany: jest.Mock;
      count: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    school: { findUnique: jest.Mock };
  };
  let storage: {
    buildKey: jest.Mock;
    uploadBuffer: jest.Mock;
    deleteObject: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      logo: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
      },
      school: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Sunrise Academy', schoolNumber: 1 }),
      },
    };
    storage = {
      buildKey: jest.fn().mockReturnValue('logos/1/key.png'),
      uploadBuffer: jest.fn().mockResolvedValue('https://cdn.example.com/logos/1/key.png'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminLogosService,
        { provide: DatabaseService, useValue: db },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get<AdminLogosService>(AdminLogosService);
  });

  describe('readImageDims', () => {
    it('returns "svg" for an SVG mimetype regardless of content', () => {
      expect(service.readImageDims(Buffer.from('<svg/>'), 'image/svg+xml')).toBe('svg');
    });

    it('parses PNG width/height from the IHDR chunk', () => {
      expect(service.readImageDims(pngWithDims(500, 400), 'image/png')).toEqual({
        w: 500,
        h: 400,
      });
    });

    it('throws (fails closed) for a truncated/corrupt PNG instead of silently allowing it', () => {
      expect(() => service.readImageDims(Buffer.from([0x89, 0x50]), 'image/png')).toThrow(
        BadRequestException,
      );
    });

    it('throws (fails closed) for a JPEG with no recognizable SOF marker', () => {
      const garbage = Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      expect(() => service.readImageDims(garbage, 'image/jpeg')).toThrow(BadRequestException);
    });

    it('throws for an unsupported mimetype', () => {
      expect(() => service.readImageDims(Buffer.from('x'), 'image/gif')).toThrow(
        BadRequestException,
      );
    });
  });

  describe('list', () => {
    it('applies a case-insensitive search filter on schoolName server-side', async () => {
      await service.list({ search: 'sunrise' });
      expect(db.logo.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            schoolName: { contains: 'sunrise', mode: 'insensitive' },
          }),
        }),
      );
      expect(db.logo.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            schoolName: { contains: 'sunrise', mode: 'insensitive' },
          }),
        }),
      );
    });

    it('excludes soft-deleted logos and has no search filter when none given', async () => {
      await service.list({});
      const where = db.logo.findMany.mock.calls[0][0].where;
      expect(where.deletedAt).toBeNull();
      expect(where.schoolName).toBeUndefined();
    });
  });

  describe('create', () => {
    const validFile = {
      buffer: pngWithDims(400, 400),
      mimetype: 'image/png',
      size: 1000,
      originalname: 'logo.png',
    };

    it('rejects when the school already has a non-deleted logo', async () => {
      db.logo.findFirst.mockResolvedValue({ id: 'existing-1' });

      await expect(
        service.create(validFile, { school_id: 'school-1' }),
      ).rejects.toThrow(BadRequestException);
      expect(db.logo.create).not.toHaveBeenCalled();
      expect(storage.uploadBuffer).not.toHaveBeenCalled();
    });

    it('rejects an image smaller than 300x300', async () => {
      const small = { ...validFile, buffer: pngWithDims(200, 200) };
      await expect(
        service.create(small, { school_id: 'school-1' }),
      ).rejects.toThrow('Minimum image dimensions');
      expect(db.logo.create).not.toHaveBeenCalled();
    });

    it('allows an SVG regardless of the 300x300 minimum', async () => {
      db.logo.create.mockResolvedValue({
        id: 'new-1',
        schoolId: 'school-1',
        schoolName: 'Sunrise Academy',
        description: null,
        imageUrl: 'https://cdn.example.com/logos/1/key.svg',
        createdAt: new Date(),
      });
      const svgFile = {
        buffer: Buffer.from('<svg/>'),
        mimetype: 'image/svg+xml',
        size: 100,
        originalname: 'logo.svg',
      };
      await expect(
        service.create(svgFile, { school_id: 'school-1' }),
      ).resolves.toBeDefined();
      expect(db.logo.create).toHaveBeenCalled();
    });

    it('creates a logo when the school has none yet', async () => {
      db.logo.create.mockResolvedValue({
        id: 'new-1',
        schoolId: 'school-1',
        schoolName: 'Sunrise Academy',
        description: null,
        imageUrl: 'https://cdn.example.com/logos/1/key.png',
        createdAt: new Date(),
      });

      const result = await service.create(validFile, { school_id: 'school-1' });
      expect(result.school_name).toBe('Sunrise Academy');
      expect(storage.uploadBuffer).toHaveBeenCalled();
    });
  });

  describe('update — replace image', () => {
    it('deletes the old S3 object after a successful replace', async () => {
      db.logo.findUnique.mockResolvedValue({
        id: 'l1',
        schoolId: null,
        imageKey: 'logos/unassigned/old-key.png',
        deletedAt: null,
      });
      db.logo.update.mockResolvedValue({
        id: 'l1',
        schoolId: null,
        schoolName: 'X',
        description: null,
        imageUrl: 'https://cdn.example.com/new-key.png',
        createdAt: new Date(),
      });

      const file = {
        buffer: pngWithDims(400, 400),
        mimetype: 'image/png',
        size: 1000,
        originalname: 'logo.png',
      };
      await service.update('l1', file, { replace_image: 'true' });

      expect(storage.deleteObject).toHaveBeenCalledWith('logos/unassigned/old-key.png');
    });

    it('does not touch storage when not replacing the image', async () => {
      db.logo.findUnique.mockResolvedValue({
        id: 'l1',
        schoolId: null,
        imageKey: 'logos/unassigned/old-key.png',
        deletedAt: null,
      });
      db.logo.update.mockResolvedValue({
        id: 'l1',
        schoolId: null,
        schoolName: 'X',
        description: 'new desc',
        imageUrl: 'https://cdn.example.com/old-key.png',
        createdAt: new Date(),
      });

      await service.update('l1', undefined, { description: 'new desc' });

      expect(storage.uploadBuffer).not.toHaveBeenCalled();
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('soft-deletes by default (no S3 deletion)', async () => {
      db.logo.findUnique.mockResolvedValue({ id: 'l1', imageKey: 'logos/1/k.png' });
      await service.remove('l1');
      expect(db.logo.update).toHaveBeenCalledWith({
        where: { id: 'l1' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(db.logo.delete).not.toHaveBeenCalled();
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('hard-deletes the row and the S3 object when hard=true', async () => {
      db.logo.findUnique.mockResolvedValue({ id: 'l1', imageKey: 'logos/1/k.png' });
      await service.remove('l1', 'true');
      expect(db.logo.delete).toHaveBeenCalledWith({ where: { id: 'l1' } });
      expect(storage.deleteObject).toHaveBeenCalledWith('logos/1/k.png');
    });
  });
});
