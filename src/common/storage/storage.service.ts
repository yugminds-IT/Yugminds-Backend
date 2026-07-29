import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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

  /** Recovers the object key from a public URL — for rows persisted before `certificateKey` existed. */
  keyFromUrl(url: string): string | null {
    if (!this.publicUrl || !url.startsWith(`${this.publicUrl}/`)) return null;
    return url.slice(this.publicUrl.length + 1);
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /**
   * Fetches an object's bytes server-side, for proxying a download to the
   * browser. Direct browser `fetch()` of the public S3 URL fails unless the
   * bucket has CORS configured for the frontend origin — proxying through
   * the backend (which already has S3 credentials) sidesteps that entirely.
   */
  async getObject(
    key: string,
  ): Promise<{ body: Buffer; contentType: string | undefined }> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await res.Body?.transformToByteArray();
    return { body: Buffer.from(bytes ?? []), contentType: res.ContentType };
  }

  /** True if the object is actually present in the bucket — a real health check, not inferred from a stored URL. */
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }
}
