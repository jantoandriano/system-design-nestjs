import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';
import { QueueConsumerService } from './queue.consumer';

@Module({
  providers: [QueueService, QueueConsumerService],
  exports: [QueueService],
})
export class QueueModule {}
