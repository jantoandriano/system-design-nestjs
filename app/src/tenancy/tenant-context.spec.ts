import { TenantContext } from './tenant-context';

describe('TenantContext', () => {
  it('returns the bound tenantId inside run()', () => {
    TenantContext.run('tenant-1', () => {
      expect(TenantContext.getTenantId()).toBe('tenant-1');
      expect(TenantContext.tryGetTenantId()).toBe('tenant-1');
    });
  });

  it('throws from getTenantId() outside any run()', () => {
    expect(() => TenantContext.getTenantId()).toThrow();
  });

  it('returns undefined from tryGetTenantId() outside any run()', () => {
    expect(TenantContext.tryGetTenantId()).toBeUndefined();
  });

  it('isolates concurrent contexts', async () => {
    const results: string[] = [];
    await Promise.all([
      TenantContext.run('tenant-a', async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(TenantContext.getTenantId());
      }),
      TenantContext.run('tenant-b', async () => {
        results.push(TenantContext.getTenantId());
      }),
    ]);
    expect(results.sort()).toEqual(['tenant-a', 'tenant-b']);
  });
});
