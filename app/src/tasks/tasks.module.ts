import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from '../database/entities/task.entity';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Task], 'default'),
    TypeOrmModule.forFeature([Task], 'replica'),
    QueueModule,
  ],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
