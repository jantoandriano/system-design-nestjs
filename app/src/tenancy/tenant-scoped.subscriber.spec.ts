import { ForbiddenException } from '@nestjs/common';
import { TenantScopedSubscriber } from './tenant-scoped.subscriber';
import { TenantContext } from './tenant-context';

describe('TenantScopedSubscriber', () => {
  const dataSourceStub = { subscribers: [] as unknown[] };
  let subscriber: TenantScopedSubscriber;

  beforeEach(() => {
    dataSourceStub.subscribers = [];
    subscriber = new TenantScopedSubscriber(dataSourceStub as any, dataSourceStub as any);
  });

  it('registers itself on both datasources passed in', () => {
    expect(dataSourceStub.subscribers).toContain(subscriber);
  });

  it('allows a load matching the current tenant context', () => {
    TenantContext.run('tenant-1', () => {
      expect(() => subscriber.afterLoad({ tenantId: 'tenant-1' })).not.toThrow();
    });
  });

  it('throws on a load that does not match the current tenant context', () => {
    TenantContext.run('tenant-1', () => {
      expect(() => subscriber.afterLoad({ tenantId: 'tenant-2' })).toThrow(ForbiddenException);
    });
  });

  it('does nothing when no tenant context is bound', () => {
    expect(() => subscriber.afterLoad({ tenantId: 'tenant-2' })).not.toThrow();
  });

  it('does nothing for entities without a tenantId field', () => {
    TenantContext.run('tenant-1', () => {
      expect(() => subscriber.afterLoad({ id: 'task-1', title: 'unrelated' })).not.toThrow();
    });
  });
});
