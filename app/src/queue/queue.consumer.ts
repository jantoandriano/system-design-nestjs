import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as amqp from 'amqp-connection-manager';
import type { ConsumeMessage } from 'amqplib';
import { ProcessedEvent } from '../database/entities/processed-event.entity';
import {
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_QUEUE,
  EXCHANGE,
  MAX_DELIVERY_ATTEMPTS,
  QUEUE,
  ROUTING_KEY,
} from './queue.constants';

@Injectable()
export class QueueConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueConsumerService.name);
  private connection: amqp.AmqpConnectionManager;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(ProcessedEvent, 'default')
    private readonly processedEvents: Repository<ProcessedEvent>,
  ) {}

  onModuleInit() {
    const host = this.config.get('RABBITMQ_HOST');
    const port = this.config.get('RABBITMQ_PORT');
    const user = this.config.get('RABBITMQ_USER');
    const pass = this.config.get('RABBITMQ_PASSWORD');

    this.connection = amqp.connect([`amqp://${user}:${pass}@${host}:${port}`]);

    this.connection.createChannel({
      setup: (channel: any) =>
        Promise.all([
          // Main topology
          channel.assertExchange(EXCHANGE, 'direct', { durable: true }),

          // Dead-letter topology - anything that fails MAX_DELIVERY_ATTEMPTS
          // times lands here instead of looping forever or being silently
          // dropped. Someone (a human, or a reprocessing job) has to look
          // at this queue.
          channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', {
            durable: true,
          }),
          channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true }),
          channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, ''),

          // Main queue: a "quorum" queue replicates across RabbitMQ
          // cluster nodes (the RabbitMQ equivalent of the Postgres
          // primary/replica setup), and its x-delivery-limit means
          // RabbitMQ itself counts redelivery attempts and auto
          // dead-letters after MAX_DELIVERY_ATTEMPTS - no manual retry
          // counter needed in application code.
          channel
            .assertQueue(QUEUE, {
              durable: true,
              arguments: {
                'x-queue-type': 'quorum',
                'x-delivery-limit': MAX_DELIVERY_ATTEMPTS,
                'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
              },
            })
            .then(() => channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY)),
        ]).then(() =>
          channel.consume(QUEUE, (msg: ConsumeMessage | null) =>
            this.handleMessage(channel, msg),
          ),
        ),
    });
  }

  private async handleMessage(channel: any, msg: ConsumeMessage | null) {
    if (!msg) return;

    let payload: { eventId: string; eventType: string; taskId: string };
    try {
      payload = JSON.parse(msg.content.toString());
    } catch (err) {
      // Malformed payload will never parse correctly no matter how many
      // times we retry it - drop it straight to the DLQ instead of
      // burning through delivery attempts.
      this.logger.error('Unparseable message, dead-lettering', err as Error);
      channel.nack(msg, false, false);
      return;
    }

    // Idempotency check: has this exact event already been handled? A
    // redelivery (after a crash between "did the work" and "acked the
    // message") should be a safe no-op, not a repeat of the side effect.
    const alreadyProcessed = await this.processedEvents.findOne({
      where: { eventId: payload.eventId },
    });

    if (alreadyProcessed) {
      this.logger.log(`Skipping already-processed event ${payload.eventId}`);
      channel.ack(msg);
      return;
    }

    try {
      this.logger.log(
        `[${process.env.INSTANCE_NAME ?? 'app'}] processing: ${JSON.stringify(payload)}`,
      );
      // Real side effects go here - send a notification, update a
      // search index, generate a thumbnail, etc.

      await this.processedEvents.save({
        eventId: payload.eventId,
        eventType: payload.eventType,
      });

      channel.ack(msg);
    } catch (err) {
      this.logger.error(
        `Failed to process event ${payload.eventId}, will retry`,
        err as Error,
      );
      // requeue: true - RabbitMQ's x-delivery-limit on the quorum queue
      // caps how many times this happens before it's auto-routed to the
      // dead-letter queue instead of retried again.
      channel.nack(msg, false, true);
    }
  }

  async onModuleDestroy() {
    await this.connection?.close();
  }
}
