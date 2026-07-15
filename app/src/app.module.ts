import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { TasksModule } from './tasks/tasks.module';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        base: { instance: process.env.INSTANCE_NAME ?? 'unknown' },
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined // plain JSON lines in prod - ship these to your log aggregator
            : { target: 'pino-pretty' },
        redact: ['req.headers.authorization'],
      },
    }),
    // Defense-in-depth: nginx also rate-limits at the edge (see
    // nginx/nginx.conf). This catches anything that reaches the app
    // directly, and lets per-route limits (see AuthController) be
    // stricter than the global default.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    DatabaseModule,
    QueueModule,
    TasksModule,
    HealthModule,
    AuthModule,
    MetricsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
