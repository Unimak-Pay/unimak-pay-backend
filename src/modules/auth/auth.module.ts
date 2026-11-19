import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { AdminAuthenticator } from './application/admin-authenticator';
import { AUTH_INVITER } from './application/auth-inviter.port';
import { JwksKeyResolver } from './infrastructure/jwks-key-resolver';
import { DisabledAuthInviter, SupabaseAuthInviter } from './infrastructure/supabase-auth-inviter';
import { AdminAuthGuard } from './interface/admin-auth.guard';

@Module({
  providers: [
    JwksKeyResolver,
    AdminAuthenticator,
    AdminAuthGuard,
    {
      provide: AUTH_INVITER,
      inject: [AppConfig],
      useFactory: (cfg: AppConfig) => {
        const url = cfg.get('SUPABASE_URL');
        const serviceKey = cfg.get('SUPABASE_SERVICE_ROLE_KEY');
        return url && serviceKey
          ? new SupabaseAuthInviter({ url, serviceKey, redirectTo: cfg.get('ADMIN_INVITE_REDIRECT_URL') })
          : new DisabledAuthInviter();
      },
    },
  ],
  exports: [AdminAuthenticator, AdminAuthGuard, AUTH_INVITER],
})
export class AuthModule {}
