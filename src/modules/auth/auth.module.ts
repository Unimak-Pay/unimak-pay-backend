import { Module } from '@nestjs/common';
import { AdminAuthenticator } from './application/admin-authenticator';
import { JwksKeyResolver } from './infrastructure/jwks-key-resolver';
import { AdminAuthGuard } from './interface/admin-auth.guard';

@Module({
  providers: [JwksKeyResolver, AdminAuthenticator, AdminAuthGuard],
  exports: [AdminAuthenticator, AdminAuthGuard],
})
export class AuthModule {}
