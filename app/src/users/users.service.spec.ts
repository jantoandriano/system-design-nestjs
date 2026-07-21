import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { User } from '../database/entities/user.entity';

describe('UsersService', () => {
  let service: UsersService;
  const repo = {
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'user-1', createdAt: new Date(), ...data })),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User, 'default'), useValue: repo },
      ],
    }).compile();
    service = module.get(UsersService);
  });

  it('hashes the password before saving', async () => {
    const user = await service.create('alice', 'correct-horse');
    expect(user.username).toBe('alice');
    expect(user.passwordHash).toBeDefined();
    expect(user.passwordHash).not.toBe('correct-horse');
  });

  it('finds a user by username', async () => {
    repo.findOne.mockResolvedValue({ id: 'user-1', username: 'alice' });
    const user = await service.findByUsername('alice');
    expect(repo.findOne).toHaveBeenCalledWith({ where: { username: 'alice' } });
    expect(user?.username).toBe('alice');
  });

  it('returns null when the username does not exist', async () => {
    repo.findOne.mockResolvedValue(null);
    const user = await service.findByUsername('nobody');
    expect(user).toBeNull();
  });

  it('validates a correct password against the stored hash', async () => {
    const created = await service.create('bob', 'hunter2');
    const ok = await service.validatePassword(created, 'hunter2');
    expect(ok).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const created = await service.create('bob', 'hunter2');
    const ok = await service.validatePassword(created, 'wrong-password');
    expect(ok).toBe(false);
  });
});
