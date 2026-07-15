import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * This checks against a single credential pair from env vars, which is
   * enough to demonstrate protecting routes with a real JWT flow. Swap
   * this for a lookup against a users table (with per-user bcrypt hashes)
   * before this handles real accounts.
   */
  async login(username: string, password: string) {
    const expectedUsername = this.config.get<string>('AUTH_USERNAME');
    const expectedHash = this.config.get<string>('AUTH_PASSWORD_HASH');

    const usernameMatches = username === expectedUsername;
    const passwordMatches =
      expectedHash != null && (await bcrypt.compare(password, expectedHash));

    if (!usernameMatches || !passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: username, username };
    return {
      accessToken: await this.jwtService.signAsync(payload),
    };
  }
}
