import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Role } from '../database/entities/role.entity';
import { RolesService } from './roles.service';
import { RbacGuard } from './rbac.guard';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [TypeOrmModule.forFeature([Role], 'default'), UsersModule],
  providers: [RolesService, RbacGuard],
  exports: [RolesService, RbacGuard],
})
export class RbacModule {}
