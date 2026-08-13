import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RolesService } from './roles.service';
import { Role } from '../database/entities/role.entity';

describe('RolesService', () => {
  let service: RolesService;
  const repo = {
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'role-1', createdAt: new Date(), ...data })),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [RolesService, { provide: getRepositoryToken(Role, 'default'), useValue: repo }],
    }).compile();
    service = module.get(RolesService);
  });

  it('creates a role scoped to a tenant with a permission list', async () => {
    const role = await service.create('tenant-1', 'manager', ['po.approve', 'po.read']);
    expect(role.tenantId).toBe('tenant-1');
    expect(role.permissions).toEqual(['po.approve', 'po.read']);
  });

  it('finds a role by id', async () => {
    repo.findOne.mockResolvedValue({ id: 'role-1', tenantId: 'tenant-1', permissions: ['po.read'] });
    const role = await service.findById('role-1');
    expect(role?.id).toBe('role-1');
  });

  it('returns null for an unknown role id', async () => {
    repo.findOne.mockResolvedValue(null);
    expect(await service.findById('missing')).toBeNull();
  });

  it('hasPermission is true when the permission is in the list', () => {
    const role = { id: 'r1', tenantId: 't1', name: 'clerk', permissions: ['po.create'], createdAt: new Date() } as Role;
    expect(service.hasPermission(role, 'po.create')).toBe(true);
  });

  it('hasPermission is false when the permission is not in the list', () => {
    const role = { id: 'r1', tenantId: 't1', name: 'clerk', permissions: ['po.create'], createdAt: new Date() } as Role;
    expect(service.hasPermission(role, 'po.approve')).toBe(false);
  });
});
