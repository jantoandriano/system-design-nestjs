import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from './entities/task.entity';
import { ProcessedEvent } from './entities/processed-event.entity';

const ENTITIES = [Task, ProcessedEvent];

@Module({
  imports: [
    // Primary database - all writes go here. This is the "default"
    // TypeORM connection name. Goes through PgBouncer (APP_DB_WRITE_*),
    // not directly at Postgres - see docker-compose.yml. Schema changes
    // come from migrations (see database/migrations), run explicitly
    // against Postgres directly - never from synchronize, which is
    // only safe for local prototyping.
    TypeOrmModule.forRootAsync({
      name: 'default',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('APP_DB_WRITE_HOST'),
        port: config.get<number>('APP_DB_WRITE_PORT'),
        username: config.get('POSTGRES_USER'),
        password: config.get('POSTGRES_PASSWORD'),
        database: config.get('POSTGRES_DB'),
        entities: ENTITIES,
        synchronize: false,
        migrations: [__dirname + '/migrations/*.js'],
      }),
    }),

    // Replica database - reads that can tolerate slight staleness go
    // here instead, taking load off the primary. Also pooled, through
    // pgbouncer-replica. Schema is inherited from the primary via
    // streaming replication - migrations never run against this
    // connection.
    TypeOrmModule.forRootAsync({
      name: 'replica',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('APP_DB_READ_HOST'),
        port: config.get<number>('APP_DB_READ_PORT'),
        username: config.get('POSTGRES_USER'),
        password: config.get('POSTGRES_PASSWORD'),
        database: config.get('POSTGRES_DB'),
        entities: ENTITIES,
        synchronize: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
