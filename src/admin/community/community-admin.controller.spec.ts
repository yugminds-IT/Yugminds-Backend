import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { CommunityAdminController } from './community-admin.controller';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../../common/storage/storage.service';

describe('CommunityAdminController — orphaned upload cleanup', () => {
  let controller: CommunityAdminController;
  let db: {
    communityPageConfig: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
    communityItem: { findUnique: jest.Mock; update: jest.Mock; delete: jest.Mock };
    communityItemVersion: { create: jest.Mock; aggregate: jest.Mock };
    $transaction: jest.Mock;
  };
  let storage: {
    keyFromUrl: jest.Mock;
    deleteObject: jest.Mock;
    buildKey: jest.Mock;
    uploadBuffer: jest.Mock;
  };

  const validImageFile = {
    buffer: Buffer.from('x'),
    mimetype: 'image/png',
    size: 100,
    originalname: 'x.png',
  };

  beforeEach(async () => {
    db = {
      communityPageConfig: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      communityItem: {
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      communityItemVersion: {
        create: jest.fn().mockResolvedValue({}),
        aggregate: jest.fn().mockResolvedValue({ _max: { versionNumber: 1 } }),
      },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
    };
    storage = {
      keyFromUrl: jest.fn((url: string) =>
        url.startsWith('https://cdn.example.com/') ? url.replace('https://cdn.example.com/', '') : null,
      ),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      buildKey: jest.fn().mockReturnValue('community/new-key.png'),
      uploadBuffer: jest.fn().mockResolvedValue('https://cdn.example.com/community/new-key.png'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityAdminController,
        { provide: DatabaseService, useValue: db },
        { provide: StorageService, useValue: storage },
      ],
      controllers: [],
    })
      // CommunityAdminController is a plain provider here so we can call its
      // methods directly without going through HTTP.
      .compile();

    controller = module.get<CommunityAdminController>(CommunityAdminController);
  });

  describe('deleteItem', () => {
    it('deletes media/thumbnail/avatar S3 objects it owns after the row is deleted', async () => {
      db.communityItem.delete.mockResolvedValue({
        id: 'i1',
        mediaUrl: 'https://cdn.example.com/community/media.png',
        thumbnailUrl: 'https://cdn.example.com/community/thumb.png',
        creatorAvatarUrl: 'https://external.example.com/avatar.png', // not ours — must not be deleted
      });

      await controller.deleteItem('i1');

      expect(storage.deleteObject).toHaveBeenCalledWith('community/media.png');
      expect(storage.deleteObject).toHaveBeenCalledWith('community/thumb.png');
      expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    });

    it('propagates not-found as BadRequestException without touching storage', async () => {
      db.communityItem.delete.mockRejectedValue({ code: 'P2025' });
      await expect(controller.deleteItem('missing')).rejects.toThrow(BadRequestException);
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('updateItem — media replace', () => {
    it('deletes the old media object after replacing it', async () => {
      db.communityItem.findUnique.mockResolvedValue({
        id: 'i1',
        sectionType: 'project',
        title: 'Old title',
        mediaUrl: 'https://cdn.example.com/community/old-media.png',
        thumbnailUrl: null,
        creatorAvatarUrl: null,
      });
      db.communityItem.update.mockResolvedValue({
        id: 'i1',
        sectionType: 'project',
        title: 'Old title',
        mediaUrl: 'https://cdn.example.com/community/new-key.png',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await controller.updateItem('i1', validImageFile, {});

      expect(storage.deleteObject).toHaveBeenCalledWith('community/old-media.png');
    });

    it('does not touch storage when no new media file is provided', async () => {
      db.communityItem.findUnique.mockResolvedValue({
        id: 'i1',
        sectionType: 'project',
        title: 'Old title',
        mediaUrl: 'https://cdn.example.com/community/old-media.png',
      });
      db.communityItem.update.mockResolvedValue({
        id: 'i1',
        sectionType: 'project',
        title: 'New title',
        mediaUrl: 'https://cdn.example.com/community/old-media.png',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await controller.updateItem('i1', undefined, { title: 'New title' });

      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('updateConfig — hero image replace', () => {
    it('deletes the old hero image after replacing it', async () => {
      db.communityPageConfig.findUnique.mockResolvedValue({
        id: 'default',
        heroTitle: 'T',
        heroSubtitle: null,
        heroImageUrl: 'https://cdn.example.com/community/old-hero.png',
        sectionTitles: {},
        sectionEnabled: {},
        sectionColors: {},
        impactStats: [],
        socialLinks: [],
        cornerPillars: [],
      });
      db.communityPageConfig.update.mockResolvedValue({
        id: 'default',
        heroTitle: 'T',
        heroImageUrl: 'https://cdn.example.com/community/new-key.png',
        sectionTitles: {},
        sectionEnabled: {},
        sectionColors: {},
        impactStats: [],
        socialLinks: [],
        cornerPillars: [],
        updatedAt: new Date(),
      });

      await controller.updateConfig(validImageFile, {});

      expect(storage.deleteObject).toHaveBeenCalledWith('community/old-hero.png');
    });

    it('does not touch storage when no new hero image is provided', async () => {
      db.communityPageConfig.findUnique.mockResolvedValue({
        id: 'default',
        heroTitle: 'T',
        heroImageUrl: 'https://cdn.example.com/community/old-hero.png',
        sectionTitles: {},
        sectionEnabled: {},
        sectionColors: {},
        impactStats: [],
        socialLinks: [],
        cornerPillars: [],
      });
      db.communityPageConfig.update.mockResolvedValue({
        id: 'default',
        heroTitle: 'New title',
        heroImageUrl: 'https://cdn.example.com/community/old-hero.png',
        sectionTitles: {},
        sectionEnabled: {},
        sectionColors: {},
        impactStats: [],
        socialLinks: [],
        cornerPillars: [],
        updatedAt: new Date(),
      });

      await controller.updateConfig(undefined, { hero_title: 'New title' });

      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('uploadThumbnail / uploadAvatar — replace cleanup', () => {
    it('deletes the old thumbnail after replacing it', async () => {
      db.communityItem.findUnique.mockResolvedValue({
        id: 'i1',
        thumbnailUrl: 'https://cdn.example.com/community/old-thumb.png',
      });
      db.communityItem.update.mockResolvedValue({
        id: 'i1',
        thumbnailUrl: 'https://cdn.example.com/community/new-key.png',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await controller.uploadThumbnail('i1', validImageFile);

      expect(storage.deleteObject).toHaveBeenCalledWith('community/old-thumb.png');
    });

    it('deletes the old avatar after replacing it', async () => {
      db.communityItem.findUnique.mockResolvedValue({
        id: 'i1',
        creatorAvatarUrl: 'https://cdn.example.com/community/old-avatar.png',
      });
      db.communityItem.update.mockResolvedValue({
        id: 'i1',
        creatorAvatarUrl: 'https://cdn.example.com/community/new-key.png',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await controller.uploadAvatar('i1', validImageFile);

      expect(storage.deleteObject).toHaveBeenCalledWith('community/old-avatar.png');
    });

    it('does not attempt to delete an externally-hosted avatar', async () => {
      db.communityItem.findUnique.mockResolvedValue({
        id: 'i1',
        creatorAvatarUrl: 'https://external.example.com/avatar.png',
      });
      db.communityItem.update.mockResolvedValue({
        id: 'i1',
        creatorAvatarUrl: 'https://cdn.example.com/community/new-key.png',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await controller.uploadAvatar('i1', validImageFile);

      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
  });
});
