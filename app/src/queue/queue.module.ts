import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueService } from './queue.service';
import { QueueConsumerService } from './queue.consumer';
import { ProcessedEvent } from '../database/entities/processed-event.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ProcessedEvent], 'default')],
  providers: [QueueService, QueueConsumerService],
  exports: [QueueService],
})
export class QueueModule {}
