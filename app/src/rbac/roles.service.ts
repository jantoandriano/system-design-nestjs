import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from '../database/entities/role.entity';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role, 'default')
    private readonly repo: Repository<Role>,
  ) {}

  async create(tenantId: string, name: string, permissions: string[]): Promise<Role> {
    const role = this.repo.create({ tenantId, name, permissions });
    return this.repo.save(role);
  }

  async findById(id: string): Promise<Role | null> {
    return this.repo.findOne({ where: { id } });
  }

  hasPermission(role: Role, permission: string): boolean {
    return role.permissions.includes(permission);
  }
}
