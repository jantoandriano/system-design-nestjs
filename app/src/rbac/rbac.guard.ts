import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from './require-permission.decorator';
import { RolesService } from './roles.service';
import { UsersService } from '../users/users.service';

interface RequestUser {
  userId: string;
  username: string;
  tenantId: string;
}

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly usersService: UsersService,
    private readonly rolesService: RolesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermission = this.reflector.getAllAndOverride<string | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermission) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const requestUser = request.user as RequestUser;

    const user = await this.usersService.findById(requestUser.userId);
    if (!user?.roleId) {
      throw new ForbiddenException('No role assigned');
    }

    const role = await this.rolesService.findById(user.roleId);
    if (!role || role.tenantId !== requestUser.tenantId) {
      throw new ForbiddenException('Role not valid for this tenant');
    }

    if (!this.rolesService.hasPermission(role, requiredPermission)) {
      throw new ForbiddenException(`Missing permission: ${requiredPermission}`);
    }

    return true;
  }
}
