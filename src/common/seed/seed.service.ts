import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../database/database.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    try {
      await this.seedAdmin();
    } catch (err) {
      this.logger.warn(`Seed skipped — database unreachable at startup: ${err.message}`);
    }
  }

  private async seedAdmin() {
    const email = this.config.get<string>('ADMIN_SEED_EMAIL');
    const password = this.config.get<string>('ADMIN_SEED_PASSWORD');

    if (!email || !password) {
      // Env vars not set — skip silently (production may rely on a pre-existing admin)
      return;
    }

    const existing = await this.db.user.findUnique({ where: { email } });
    if (existing) {
      this.logger.log(`Admin seed skipped — ${email} already exists`);
      return;
    }

    const hash = await bcrypt.hash(password, 10);

    await this.db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          password: hash,
          role: 'admin',
          isSuperAdmin: true,
          isActive: true,
        },
      });
      await tx.profile.create({
        data: { userId: user.id, fullName: 'Admin' },
      });
    });

    this.logger.log(`Admin seeded: ${email}`);
  }
}
