import { Test, TestingModule } from '@nestjs/testing';
import { CertificateService } from './certificate.service';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';

jest.mock('../utils/certificate-svg.util', () => ({
  buildCertificateSvg: jest.fn().mockReturnValue('<svg></svg>'),
  svgToJpegBuffer: jest.fn().mockResolvedValue(Buffer.from('jpeg')),
  shortCertId: jest.fn((id: string) => `YM-${id.slice(0, 8).toUpperCase()}`),
}));

describe('CertificateService', () => {
  let service: CertificateService;
  let db: {
    studentCertificate: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    studentCourse: { findUnique: jest.Mock };
    chapter: { findMany: jest.Mock };
    chapterContent: { findMany: jest.Mock };
    courseProgress: { findMany: jest.Mock };
    course: { findUnique: jest.Mock };
    profile: { findUnique: jest.Mock };
    systemSetting: { findUnique: jest.Mock };
  };
  let storage: { objectExists: jest.Mock; buildKey: jest.Mock; uploadBuffer: jest.Mock };
  let notifications: { sendOne: jest.Mock };

  beforeEach(async () => {
    db = {
      studentCertificate: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'abcd1234-0000-0000-0000-000000000000' }),
        update: jest.fn().mockResolvedValue({}),
      },
      studentCourse: { findUnique: jest.fn().mockResolvedValue({ studentId: 1 }) },
      chapter: { findMany: jest.fn().mockResolvedValue([]) },
      chapterContent: { findMany: jest.fn().mockResolvedValue([]) },
      courseProgress: { findMany: jest.fn().mockResolvedValue([]) },
      course: { findUnique: jest.fn().mockResolvedValue({ title: 'Course' }) },
      profile: { findUnique: jest.fn().mockResolvedValue({ fullName: 'Student Name' }) },
      systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    storage = {
      objectExists: jest.fn().mockResolvedValue(true),
      buildKey: jest.fn().mockReturnValue('certificates/1/key.jpg'),
      uploadBuffer: jest.fn().mockResolvedValue('https://cdn.example.com/certificates/1/key.jpg'),
    };
    notifications = { sendOne: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CertificateService,
        { provide: DatabaseService, useValue: db },
        { provide: StorageService, useValue: storage },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get<CertificateService>(CertificateService);
  });

  describe('issueIfEligible', () => {
    it('returns not_enrolled when the student has no StudentCourse row', async () => {
      db.studentCourse.findUnique.mockResolvedValue(null);
      const result = await service.issueIfEligible(1, 'course-1');
      expect(result).toEqual({ issued: false, reason: 'not_enrolled' });
      expect(db.studentCertificate.create).not.toHaveBeenCalled();
    });

    it('returns not_eligible when progress is below 80%', async () => {
      db.chapter.findMany.mockResolvedValue([{ id: 'ch1' }]);
      db.chapterContent.findMany.mockResolvedValue([{ id: 'c1', chapterId: 'ch1' }]);
      db.courseProgress.findMany.mockResolvedValue([]);
      const result = await service.issueIfEligible(1, 'course-1');
      expect(result).toEqual({ issued: false, reason: 'not_eligible' });
      expect(db.studentCertificate.create).not.toHaveBeenCalled();
    });

    it('is idempotent — returns the existing certificate without re-issuing', async () => {
      db.studentCertificate.findUnique.mockResolvedValue({ id: 'existing-id' });
      const result = await service.issueIfEligible(1, 'course-1');
      expect(result).toEqual({
        issued: true,
        certificateId: 'existing-id',
        alreadyExisted: true,
      });
      expect(db.studentCertificate.create).not.toHaveBeenCalled();
      expect(storage.uploadBuffer).not.toHaveBeenCalled();
    });

    it('issues a certificate and notifies the student when eligible', async () => {
      db.chapter.findMany.mockResolvedValue([{ id: 'ch1' }]);
      db.chapterContent.findMany.mockResolvedValue([{ id: 'c1', chapterId: 'ch1' }]);
      db.courseProgress.findMany.mockResolvedValue([
        { contentId: 'c1', chapterId: 'ch1', progress: 100, completedAt: new Date(), updatedAt: new Date() },
      ]);

      const result = await service.issueIfEligible(1, 'course-1', 2);

      expect(result.issued).toBe(true);
      expect(db.studentCertificate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ studentId: 1, courseId: 'course-1', issuedBy: 2, status: 'active' }),
        }),
      );
      expect(storage.uploadBuffer).toHaveBeenCalled();
      expect(db.studentCertificate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            certificateUrl: 'https://cdn.example.com/certificates/1/key.jpg',
          }),
        }),
      );
      expect(notifications.sendOne).toHaveBeenCalledWith(
        2,
        1,
        expect.objectContaining({ type: 'certificate' }),
      );
    });

    it('does not let a notification failure roll back an already-issued certificate', async () => {
      db.chapter.findMany.mockResolvedValue([{ id: 'ch1' }]);
      db.chapterContent.findMany.mockResolvedValue([{ id: 'c1', chapterId: 'ch1' }]);
      db.courseProgress.findMany.mockResolvedValue([
        { contentId: 'c1', chapterId: 'ch1', progress: 100, completedAt: new Date(), updatedAt: new Date() },
      ]);
      notifications.sendOne.mockRejectedValue(new Error('notif down'));

      const result = await service.issueIfEligible(1, 'course-1');
      expect(result.issued).toBe(true);
    });
  });

  describe('verifyObjectsExist', () => {
    it('marks certificates as broken when the object no longer exists in storage', async () => {
      db.studentCertificate.findMany.mockResolvedValue([
        { id: 'c1', certificateKey: 'certificates/1/c1.jpg', certificateUrl: 'https://x/c1.jpg' },
      ]);
      storage.objectExists.mockResolvedValue(false);

      const results = await service.verifyObjectsExist(['c1']);

      expect(results).toEqual([{ id: 'c1', status: 'broken' }]);
      expect(db.studentCertificate.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'broken' },
      });
    });

    it('excludes revoked certificates from the storage check', async () => {
      db.studentCertificate.findMany.mockResolvedValue([]);
      await service.verifyObjectsExist(['revoked-cert']);
      expect(db.studentCertificate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['revoked-cert'] }, status: { not: 'revoked' } },
        }),
      );
    });
  });
});
