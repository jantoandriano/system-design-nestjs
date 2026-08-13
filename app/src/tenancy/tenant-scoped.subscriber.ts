import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntitySubscriberInterface } from 'typeorm';
import { TenantContext } from './tenant-context';

// Deliberately NOT decorated with TypeORM's @EventSubscriber(). That
// decorator only matters for glob-based auto-discovery (a `subscribers`
// array in TypeOrmModule's connection options), which neither the
// `default` nor `replica` connection sets in database.module.ts.
// Registration here is manual instead: Nest constructs this class via DI
// (both DataSources injected) and the constructor pushes itself onto
// each DataSource's `subscribers` array. If a `subscribers` glob is ever
// added to database.module.ts, do NOT re-add @EventSubscriber() -
// TypeORM's auto-discovery calls getFromContainer() with a zero-arg
// constructor and would crash here, which expects two injected DataSources.
@Injectable()
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
