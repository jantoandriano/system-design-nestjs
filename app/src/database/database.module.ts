import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from './entities/task.entity';

@Module({
  imports: [
    // Primary database - all writes go here. This is the "default"
    // TypeORM connection name.
    TypeOrmModule.forRootAsync({
      name: 'default',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('POSTGRES_PRIMARY_HOST'),
        port: config.get<number>('POSTGRES_PRIMARY_PORT'),
        username: config.get('POSTGRES_USER'),
        password: config.get('POSTGRES_PASSWORD'),
        database: config.get('POSTGRES_DB'),
        entities: [Task],
        // synchronize is fine for this learning project; never use it
        // against a real production database.
        synchronize: true,
      }),
    }),

    // Replica database - reads that can tolerate slight staleness go
    // here instead, taking load off the primary. Schema is inherited
    // from the primary via streaming replication, so synchronize is off.
    TypeOrmModule.forRootAsync({
      name: 'replica',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('POSTGRES_REPLICA_HOST'),
        port: config.get<number>('POSTGRES_REPLICA_PORT'),
        username: config.get('POSTGRES_USER'),
        password: config.get('POSTGRES_PASSWORD'),
        database: config.get('POSTGRES_DB'),
        entities: [Task],
        synchronize: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
