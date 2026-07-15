import { Injectable } from '@nestjs/common';
import * as os from 'os';

@Injectable()
export class AppService {
  getInfo() {
    return {
      message: 'System Design NestJS demo',
      instance: process.env.INSTANCE_NAME ?? 'unknown',
      hostname: os.hostname(),
      timestamp: new Date().toISOString(),
    };
  }
}
