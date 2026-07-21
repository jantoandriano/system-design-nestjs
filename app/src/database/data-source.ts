import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { Task } from './entities/task.entity';
import { ProcessedEvent } from './entities/processed-event.entity';
import { User } from './entities/user.entity';

config();

/**
 * This DataSource is used ONLY by the TypeORM CLI (migration:generate,
 * migration:run, migration:revert). The app itself connects via
 * database.module.ts, not this file.
 *
 * It always points at the primary (write) database - migrations run
 * once against the primary and replicate to the replica automatically
 * via streaming replication, the same way any other write does.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_PRIMARY_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PRIMARY_PORT ?? 5432),
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  entities: [Task, ProcessedEvent, User],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
});
