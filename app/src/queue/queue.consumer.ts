import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqp-connection-manager';
import type { ConsumeMessage } from 'amqplib';

@Injectable()
export class QueueConsumerService implements OnModuleInit {
  private readonly logger = new Logger(QueueConsumerService.name);

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const host = this.config.get('RABBITMQ_HOST');
    const port = this.config.get('RABBITMQ_PORT');
    const user = this.config.get('RABBITMQ_USER');
    const pass = this.config.get('RABBITMQ_PASSWORD');
    const queueName = this.config.get('RABBITMQ_QUEUE') ?? 'tasks_queue';

    const connection = amqp.connect([`amqp://${user}:${pass}@${host}:${port}`]);

    const channelWrapper = connection.createChannel({
      setup: (channel: any) =>
        Promise.all([
          channel.assertQueue(queueName, { durable: true }),
          channel.prefetch(10),
          channel.consume(queueName, (msg: ConsumeMessage | null) => {
            if (!msg) return;
            try {
              const payload = JSON.parse(msg.content.toString());
              this.logger.log(
                `[${process.env.INSTANCE_NAME ?? 'app'}] consumed: ${JSON.stringify(payload)}`,
              );
              // Do the slow/async work here: send an email, update a
              // search index, generate a thumbnail, etc.
              channelWrapper.ack(msg);
            } catch (err) {
              this.logger.error('Failed to process message', err as Error);
              channelWrapper.nack(msg, false, false);
            }
          }),
        ]),
    });
  }
}
