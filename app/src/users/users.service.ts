import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../database/entities/user.entity';

const SALT_ROUNDS = 10;

// Fixed, precomputed bcrypt hash with no corresponding real account. Used
// solely to burn a real bcrypt.compare cost when the username doesn't
// exist, so an unknown-username login takes the same time as a
// wrong-password login for a real user — otherwise the missing compare
// call lets response timing leak which case occurred. The plaintext this
// hashes is irrelevant; it will never be typed as a password.
const DUMMY_HASH = '$2b$10$BCW6AdDYjzrLtC.a9xiTy.tq0M99F5cm8KK.BWzKFR5OBm780hQNO';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User, 'default')
    private readonly repo: Repository<User>,
  ) {}

  async create(username: string, password: string): Promise<User> {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = this.repo.create({ username, passwordHash });
    return this.repo.save(user);
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.repo.findOne({ where: { username } });
  }

  async validatePassword(user: User | null, password: string): Promise<boolean> {
    if (user == null) {
      // Still pay the bcrypt cost so this doesn't return faster than the
      // real-user path (see DUMMY_HASH comment above).
      await bcrypt.compare(password, DUMMY_HASH);
      return false;
    }
    return bcrypt.compare(password, user.passwordHash);
  }
}
