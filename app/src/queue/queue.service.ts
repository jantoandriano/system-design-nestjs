import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqp-connection-manager';
import type { ChannelWrapper } from 'amqp-connection-manager';
import { randomUUID } from 'crypto';
import { EXCHANGE, ROUTING_KEY } from './queue.constants';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection: amqp.AmqpConnectionManager;
  private channelWrapper: ChannelWrapper;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const host = this.config.get('RABBITMQ_HOST');
    const port = this.config.get('RABBITMQ_PORT');
    const user = this.config.get('RABBITMQ_USER');
    const pass = this.config.get('RABBITMQ_PASSWORD');

    this.connection = amqp.connect([`amqp://${user}:${pass}@${host}:${port}`]);
    this.connection.on('connect', () =>
      this.logger.log('Connected to RabbitMQ'),
    );
    this.connection.on('disconnect', (err) =>
      this.logger.warn(`Disconnected from RabbitMQ: ${err?.err?.message}`),
    );

    this.channelWrapper = this.connection.createChannel({
      setup: (channel: any) =>
        channel.assertExchange(EXCHANGE, 'direct', { durable: true }),
    });
  }

  /**
   * Publish a "task created" event. The HTTP request returns as soon as
   * this resolves - any slow follow-up work happens asynchronously in
   * the consumer, decoupled from the request/response cycle. Every
   * event gets its own id so the consumer can de-duplicate redeliveries.
   *
   * amqp-connection-manager queues operations until it has a live
   * connection, which is great for resilience but means a publish call
   * has no built-in timeout - if the broker is unreachable, awaiting it
   * directly would hang the caller (and the HTTP request) forever. This
   * bounds that wait so a downed queue degrades the async side effect,
   * not the primary write path.
   */
  async publishTaskCreated(taskId: string): Promise<void> {
    const payload = {
      eventId: randomUUID(),
      eventType: 'task.created',
      taskId,
      timestamp: new Date().toISOString(),
    };

    const publish = this.channelWrapper.publish(
      EXCHANGE,
      ROUTING_KEY,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: 'application/json' },
    );

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('RabbitMQ publish timed out')), 2000),
    );

    await Promise.race([publish, timeout]);
  }

  async onModuleDestroy() {
    // Let in-flight publishes drain before the process exits (SIGTERM).
    await this.channelWrapper?.close();
    await this.connection?.close();
  }
}
