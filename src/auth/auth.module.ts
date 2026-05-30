import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { ApiAuthController } from './api-auth.controller';
import { DatabaseModule } from '../database/database.module';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './jwt-auth/jwt-auth.guard';
import { RolesGuard } from './roles/roles.guard';
import { PasswordResetRequestModule } from '../common/password-reset-request/password-reset-request.module';
import { RealtimeModule } from '../common/realtime/realtime.module';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => PasswordResetRequestModule),
    forwardRef(() => RealtimeModule),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const expiry = config.get<string>('ACCESS_TOKEN_EXPIRY') ?? '15m';
        const accessSecret = config.get<string>('JWT_ACCESS_SECRET');
        const refreshSecret = config.get<string>('JWT_REFRESH_SECRET');
        if (!accessSecret || !String(accessSecret).trim()) {
          throw new Error('Missing required env var: JWT_ACCESS_SECRET');
        }
        if (!refreshSecret || !String(refreshSecret).trim()) {
          throw new Error('Missing required env var: JWT_REFRESH_SECRET');
        }
        return {
          secret: String(accessSecret),
          signOptions: { expiresIn: expiry as '15m' },
        };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, RolesGuard],
  controllers: [AuthController, ApiAuthController],
  exports: [JwtModule, JwtAuthGuard, RolesGuard, AuthService],
})
export class AuthModule {}
