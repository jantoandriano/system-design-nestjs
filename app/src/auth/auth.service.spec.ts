import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

describe('AuthService', () => {
  let service: AuthService;
  const usersService = {
    findByUsername: jest.fn(),
    validatePassword: jest.fn(),
  };
  const jwtService = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('issues an access token for valid credentials', async () => {
    usersService.findByUsername.mockResolvedValue({ id: 'user-1', username: 'alice', passwordHash: 'hash' });
    usersService.validatePassword.mockResolvedValue(true);

    const result = await service.login('alice', 'correct-horse');

    expect(result).toEqual({ accessToken: 'signed.jwt.token' });
    expect(jwtService.signAsync).toHaveBeenCalledWith({ sub: 'user-1', username: 'alice' });
  });

  it('rejects an unknown username', async () => {
    usersService.findByUsername.mockResolvedValue(null);
    await expect(service.login('nobody', 'whatever')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an incorrect password', async () => {
    usersService.findByUsername.mockResolvedValue({ id: 'user-1', username: 'alice', passwordHash: 'hash' });
    usersService.validatePassword.mockResolvedValue(false);
    await expect(service.login('alice', 'wrong')).rejects.toThrow(UnauthorizedException);
  });
});
