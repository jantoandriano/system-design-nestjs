import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacGuard } from './rbac.guard';
import { RolesService } from './roles.service';
import { UsersService } from '../users/users.service';

function makeContext(user: unknown, permission: string | undefined) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(permission) };
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => {},
    getClass: () => {},
  } as unknown as ExecutionContext;
  return { context, reflector };
}

describe('RbacGuard', () => {
  const usersService = { findById: jest.fn() };
  const rolesService = { findById: jest.fn(), hasPermission: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('allows access when no permission is required on the route', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    const guard = new RbacGuard(reflector as unknown as Reflector, usersService as unknown as UsersService, rolesService as unknown as RolesService);
    const context = { switchToHttp: () => ({ getRequest: () => ({ user: undefined }) }), getHandler: () => {}, getClass: () => {} } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('denies access when the user has no role', async () => {
    usersService.findById.mockResolvedValue({ id: 'u1', tenantId: 't1', roleId: null });
    const { context, reflector } = makeContext({ userId: 'u1', tenantId: 't1' }, 'po.create');
    const guard = new RbacGuard(reflector as unknown as Reflector, usersService as unknown as UsersService, rolesService as unknown as RolesService);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('denies access when the role belongs to a different tenant', async () => {
    usersService.findById.mockResolvedValue({ id: 'u1', tenantId: 't1', roleId: 'r1' });
    rolesService.findById.mockResolvedValue({ id: 'r1', tenantId: 't2', permissions: ['po.create'] });
    const { context, reflector } = makeContext({ userId: 'u1', tenantId: 't1' }, 'po.create');
    const guard = new RbacGuard(reflector as unknown as Reflector, usersService as unknown as UsersService, rolesService as unknown as RolesService);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('denies access when the role lacks the required permission', async () => {
    usersService.findById.mockResolvedValue({ id: 'u1', tenantId: 't1', roleId: 'r1' });
    rolesService.findById.mockResolvedValue({ id: 'r1', tenantId: 't1', permissions: ['po.read'] });
    rolesService.hasPermission.mockReturnValue(false);
    const { context, reflector } = makeContext({ userId: 'u1', tenantId: 't1' }, 'po.create');
    const guard = new RbacGuard(reflector as unknown as Reflector, usersService as unknown as UsersService, rolesService as unknown as RolesService);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('allows access when the role has the required permission', async () => {
    usersService.findById.mockResolvedValue({ id: 'u1', tenantId: 't1', roleId: 'r1' });
    rolesService.findById.mockResolvedValue({ id: 'r1', tenantId: 't1', permissions: ['po.create'] });
    rolesService.hasPermission.mockReturnValue(true);
    const { context, reflector } = makeContext({ userId: 'u1', tenantId: 't1' }, 'po.create');
    const guard = new RbacGuard(reflector as unknown as Reflector, usersService as unknown as UsersService, rolesService as unknown as RolesService);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
