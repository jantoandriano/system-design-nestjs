import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContext } from './tenant-context';

interface RequestUser {
  userId: string;
  username: string;
  tenantId: string;
}

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as RequestUser | undefined;

    if (!user?.tenantId) {
      return next.handle();
    }

    // Do NOT simplify to `return TenantContext.run(tenantId, () => next.handle())`.
    // `next.handle()` must be *called* synchronously inside run()'s callback
    // for AsyncLocalStorage (which Nest's InterceptorsConsumer binds via
    // AsyncResource.bind) to capture the right context for later async
    // continuations - only assigning the resulting Observable and returning
    // it afterward preserves that, even though the two look equivalent.
    let result$!: Observable<unknown>;
    TenantContext.run(user.tenantId, () => {
      result$ = next.handle();
    });
    return result$;
  }
}
