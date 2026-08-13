import { AsyncLocalStorage } from 'async_hooks';

interface TenantStore {
  tenantId: string;
}

const als = new AsyncLocalStorage<TenantStore>();

export class TenantContext {
  static run<T>(tenantId: string, fn: () => T): T {
    return als.run({ tenantId }, fn);
  }

  static getTenantId(): string {
    const store = als.getStore();
    if (!store) {
      throw new Error('TenantContext.getTenantId() called outside of a bound request context');
    }
    return store.tenantId;
  }

  static tryGetTenantId(): string | undefined {
    return als.getStore()?.tenantId;
  }
}
