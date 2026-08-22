import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import { REDIS_CLIENT } from '../common/redis/redis.constants';

/**
 * Redis-backed refresh token store (replaces the old Postgres RefreshToken
 * table). Each token is kept as its own key with a native Redis TTL so
 * expiry is enforced by Redis itself instead of a manually-filtered
 * `expiresAt` column; a per-user set tracks the live token ids so we can
 * enumerate/revoke them without a full-table scan.
 *
 * SECURITY: refresh tokens are hashed with SHA-256, not bcrypt. bcrypt
 * silently truncates input to 72 bytes, and these JWTs share an identical
 * prefix (header + sub/email/role/tenantId/tokenVersion claims) well past
 * that mark — only `iat`/`exp` differ, near the end of the string. Hashing
 * with bcrypt made every token for a user compare equal, so a revoked
 * token could still be redeemed via any other live session. SHA-256 has
 * no such limit; the tokens are already high-entropy (HMAC-signed JWTs),
 * so bcrypt's deliberate slowness buys nothing here anyway.
 *
 * Trade-off (accepted): a Redis restart/eviction with no persistence wipes
 * all refresh tokens, forcing every user to log in again.
 */
@Injectable()
export class RefreshTokenStoreService {
  private readonly logger = new Logger(RefreshTokenStoreService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private setKey(userId: number): string {
    return `refreshtokens:${userId}`;
  }

  private tokenKey(userId: number, tokenId: string): string {
    return `refreshtoken:${userId}:${tokenId}`;
  }

  private hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  /** Hashes and stores a new refresh token for the user, TTL-bound to refreshExpirySeconds. */
  async store(
    userId: number,
    rawToken: string,
    refreshExpirySeconds: number,
  ): Promise<void> {
    const tokenId = randomUUID();
    try {
      await this.redis
        .multi()
        .set(
          this.tokenKey(userId, tokenId),
          this.hash(rawToken),
          'EX',
          refreshExpirySeconds,
        )
        .sadd(this.setKey(userId), tokenId)
        .expire(this.setKey(userId), refreshExpirySeconds)
        .exec();
    } catch (err) {
      // Login/signup must not 500 just because Redis is briefly unreachable —
      // fail open here (the caller still gets a working access token). The
      // refresh token simply won't be redeemable later (findMatch fails
      // closed below), so the user re-logs in instead of refreshing; that's
      // an acceptable degradation, not a security gap.
      this.logger.warn(
        `Redis refresh-token store failed, continuing without persisting it: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Finds the stored token matching rawToken among the user's live tokens.
   * Returns its tokenId, or null if none match. Opportunistically prunes
   * set members whose token key already expired.
   */
  async findMatch(userId: number, rawToken: string): Promise<string | null> {
    try {
      const tokenIds = await this.redis.smembers(this.setKey(userId));
      if (!tokenIds.length) return null;

      const hashes = await this.redis.mget(
        ...tokenIds.map((id) => this.tokenKey(userId, id)),
      );

      const staleIds = tokenIds.filter((_, i) => hashes[i] === null);
      if (staleIds.length) {
        await this.redis.srem(this.setKey(userId), ...staleIds);
      }

      const target = Buffer.from(this.hash(rawToken));
      const matched = tokenIds.find((_, i) => {
        const hash = hashes[i];
        if (!hash) return false;
        const candidate = Buffer.from(hash);
        return (
          candidate.length === target.length &&
          timingSafeEqual(candidate, target)
        );
      });
      return matched ?? null;
    } catch (err) {
      // Unlike store/revoke, this is a security check — if Redis can't be
      // consulted we cannot confirm the token is legitimate, so fail closed
      // (no match) rather than risk accepting an unverifiable refresh token.
      this.logger.warn(
        `Redis refresh-token lookup failed, denying refresh: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Revokes one specific token (used on rotation and single-session logout). */
  async revoke(userId: number, tokenId: string): Promise<void> {
    try {
      await this.redis
        .multi()
        .del(this.tokenKey(userId, tokenId))
        .srem(this.setKey(userId), tokenId)
        .exec();
    } catch (err) {
      // Logout must not 500 just because Redis is briefly unreachable — if
      // Redis is down the stored token is equally unreachable to findMatch,
      // so it can't be redeemed anyway even though revoke() didn't run.
      this.logger.warn(
        `Redis refresh-token revoke failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Revokes every refresh token for the user (logout-everywhere, password change, deactivation). */
  async revokeAll(userId: number): Promise<void> {
    try {
      const tokenIds = await this.redis.smembers(this.setKey(userId));
      if (tokenIds.length) {
        await this.redis.del(...tokenIds.map((id) => this.tokenKey(userId, id)));
      }
      await this.redis.del(this.setKey(userId));
    } catch (err) {
      this.logger.warn(
        `Redis refresh-token revokeAll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
