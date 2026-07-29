import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

const sendMock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    sendMock.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('') },
        },
      ],
    }).compile();
    service = module.get<StorageService>(StorageService);
  });

  describe('objectExists', () => {
    it('returns true when the HEAD request succeeds', async () => {
      sendMock.mockResolvedValue({});
      await expect(service.objectExists('certificates/1/x.jpg')).resolves.toBe(
        true,
      );
    });

    it('returns false when the HEAD request throws (e.g. object deleted)', async () => {
      sendMock.mockRejectedValue(new Error('NotFound'));
      await expect(service.objectExists('certificates/1/x.jpg')).resolves.toBe(
        false,
      );
    });
  });
});
