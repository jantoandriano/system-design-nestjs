import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntitySubscriberInterface, EventSubscriber } from 'typeorm';
import { TenantContext } from './tenant-context';

@Injectable()
@EventSubscriber()
export class TenantScopedSubscriber implements EntitySubscriberInterface {
  constructor(
    @InjectDataSource('default') defaultDataSource: DataSource,
    @InjectDataSource('replica') replicaDataSource: DataSource,
  ) {
    defaultDataSource.subscribers.push(this);
    replicaDataSource.subscribers.push(this);
  }

  afterLoad(entity: unknown): void {
    if (
      entity != null &&
      typeof entity === 'object' &&
      'tenantId' in entity &&
      typeof (entity as { tenantId: unknown }).tenantId === 'string'
    ) {
      const currentTenantId = TenantContext.tryGetTenantId();
      if (currentTenantId && (entity as { tenantId: string }).tenantId !== currentTenantId) {
        throw new ForbiddenException('Cross-tenant access blocked');
      }
    }
  }
}
