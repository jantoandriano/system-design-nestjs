import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqp-connection-manager';
import type { ChannelWrapper } from 'amqp-connection-manager';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection: amqp.AmqpConnectionManager;
  private channelWrapper: ChannelWrapper;
  private queueName: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const host = this.config.get('RABBITMQ_HOST');
    const port = this.config.get('RABBITMQ_PORT');
    const user = this.config.get('RABBITMQ_USER');
    const pass = this.config.get('RABBITMQ_PASSWORD');
    this.queueName = this.config.get('RABBITMQ_QUEUE') ?? 'tasks_queue';

    this.connection = amqp.connect([`amqp://${user}:${pass}@${host}:${port}`]);
    this.connection.on('connect', () =>
      this.logger.log('Connected to RabbitMQ'),
    );
    this.connection.on('disconnect', (err) =>
      this.logger.warn(`Disconnected from RabbitMQ: ${err?.err?.message}`),
    );

    this.channelWrapper = this.connection.createChannel({
      setup: (channel: any) =>
        channel.assertQueue(this.queueName, { durable: true }),
    });
  }

  /**
   * Publish a "task created" event. The HTTP request returns immediately
   * after this resolves - any slow follow-up work (sending a notification,
   * updating a search index, etc.) happens asynchronously in the consumer,
   * decoupled from the request/response cycle.
   */
  async publishTaskCreated(taskId: string): Promise<void> {
    const payload = {
      event: 'task.created',
      taskId,
      timestamp: new Date().toISOString(),
    };

    await this.channelWrapper.sendToQueue(
      this.queueName,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true },
    );
  }

  async onModuleDestroy() {
    await this.channelWrapper?.close();
    await this.connection?.close();
  }
}
