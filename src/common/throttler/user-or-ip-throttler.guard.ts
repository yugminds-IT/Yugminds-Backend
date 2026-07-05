import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Throttler that keys requests by authenticated user instead of by IP.
 *
 * WHY: This LMS is used inside schools, where an entire computer lab (30–100+
 * students) sits behind a single NAT'd public IP. The default IP-based tracker
 * shares one request budget across the whole school, so a single class loading
 * dashboards would collectively trip the limit and get false 429s.
 *
 * Authenticated requests are keyed by `user:<id>` (the JwtAuthGuard runs before
 * this guard and populates `req.user`), giving each student their own budget.
 * Unauthenticated requests (login / signup / refresh / password reset) have no
 * user yet, so they fall back to IP — those endpoints keep IP-based limits as
 * brute-force protection (see auth.controller.ts @Throttle overrides).
 */
@Injectable()
export class UserOrIpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId = req?.user?.id;
    if (userId !== undefined && userId !== null) {
      return `user:${userId}`;
    }

    // Use Express's resolved client IP. With `trust proxy` configured in main.ts,
    // `req.ip` is derived from X-Forwarded-For honoring only the trusted hop count,
    // so it reflects the genuine client and can't be spoofed by a hostile header.
    // (Do NOT parse X-Forwarded-For manually here — the leftmost entry is
    // attacker-controlled and would let clients bypass the per-IP auth limits.)
    const ip = req?.ip || req?.socket?.remoteAddress || 'unknown';
    return `ip:${ip}`;
  }
}
