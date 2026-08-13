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

    let result$!: Observable<unknown>;
    TenantContext.run(user.tenantId, () => {
      result$ = next.handle();
    });
    return result$;
  }
}
