import { of } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantContext } from './tenant-context';

function makeContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('TenantContextInterceptor', () => {
  const interceptor = new TenantContextInterceptor();

  it('binds TenantContext from req.user.tenantId when present', (done) => {
    const handler: CallHandler = {
      handle: () => {
        expect(TenantContext.getTenantId()).toBe('tenant-1');
        return of('result');
      },
    };
    interceptor
      .intercept(makeContext({ userId: 'u1', tenantId: 'tenant-1' }), handler)
      .subscribe(() => done());
  });

  it('passes through without binding when req.user is absent', (done) => {
    const handler: CallHandler = {
      handle: () => {
        expect(TenantContext.tryGetTenantId()).toBeUndefined();
        return of('result');
      },
    };
    interceptor.intercept(makeContext(undefined), handler).subscribe(() => done());
  });
});
