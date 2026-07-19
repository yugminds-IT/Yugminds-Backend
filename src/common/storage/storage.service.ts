import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

/**
 * S3-compatible object storage (AWS S3, or MinIO on Coolify — same client,
 * just point S3_ENDPOINT/S3_FORCE_PATH_STYLE at whichever one you're using).
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('S3_BUCKET') ?? '';
    this.publicUrl = (this.config.get<string>('S3_PUBLIC_URL') ?? '').replace(
      /\/+$/,
      '',
    );
    this.client = new S3Client({
      region: this.config.get<string>('S3_REGION') ?? 'us-east-1',
      endpoint: this.config.get<string>('S3_ENDPOINT'),
      forcePathStyle:
        (this.config.get<string>('S3_FORCE_PATH_STYLE') ?? '').toLowerCase() ===
        'true',
      credentials: {
        accessKeyId: this.config.get<string>('S3_ACCESS_KEY_ID') ?? '',
        secretAccessKey: this.config.get<string>('S3_SECRET_ACCESS_KEY') ?? '',
      },
    });
  }

  /**
   * Builds a unique, prefix-namespaced object key.
   *
   * Key convention: `<domain>/<owner-id-or-'unassigned'>/<uuid>.ext`. Include
   * the most specific single owner scope available in `prefix` (userId,
   * studentId, schoolId, or a courseId/chapterId path) — e.g.
   * `certificates/${studentId}`, `logos/${schoolId ?? 'unassigned'}`.
   * Genuinely site-wide content (no owner) may stay flat, e.g. `community`.
   *
   * Whenever the resulting key is stored (via a URL built from it), persist
   * the key itself too — not just the public URL — so it can be deleted
   * later without reverse-parsing S3_PUBLIC_URL out of a stored string.
   */
  buildKey(prefix: string, originalName: string): string {
    const ext = (originalName.split('.').pop() || '').toLowerCase();
    const safeExt = ext && ext.length <= 10 ? `.${ext}` : '';
    return `${prefix}/${randomUUID()}${safeExt}`;
  }

  /** Uploads a buffer and returns its public URL. */
  async uploadBuffer(
    key: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    return `${this.publicUrl}/${key}`;
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
