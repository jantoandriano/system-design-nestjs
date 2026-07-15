import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Records every queue message we've successfully processed, keyed by a
 * unique event id. RabbitMQ (like every "at-least-once" broker) can
 * redeliver a message - after a consumer crash, a network blip, or a
 * missed ack - so the consumer checks this table before doing any real
 * work, and writes to it in the same transaction as that work.
 */
@Entity('processed_events')
export class ProcessedEvent {
  @PrimaryColumn('uuid')
  eventId: string;

  @Column()
  eventType: string;

  @CreateDateColumn()
  processedAt: Date;
}
