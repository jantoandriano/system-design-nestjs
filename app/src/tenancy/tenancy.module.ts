import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantScopedSubscriber } from './tenant-scoped.subscriber';

@Module({
  providers: [
    TenantScopedSubscriber,
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class TenancyModule {}
