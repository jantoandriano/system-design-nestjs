import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  username: string;

  @Column()
  passwordHash: string;

  @Column('uuid')
  tenantId: string;

  @Column({ type: 'uuid', nullable: true })
  roleId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
