import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Task } from '../database/entities/task.entity';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    @InjectRepository(Task, 'default') private readonly writeRepo: Repository<Task>,
    @InjectRepository(Task, 'replica') private readonly readRepo: Repository<Task>,
    private readonly queueService: QueueService,
  ) {}

  async create(title: string): Promise<Task> {
    const task = this.writeRepo.create({ title });
    const saved = await this.writeRepo.save(task); // write path -> primary

    // The DB write is the operation the caller actually asked for, and
    // it already succeeded. A broker outage shouldn't turn a successful
    // write into a failed request - so a publish failure here is logged,
    // not thrown. The trade-off: if this fails, the event is dropped
    // (no queue outage means "eventually delivered", just "not this
    // time"). The fix for that is a transactional outbox - write the
    // event to an `outbox` table in the same DB transaction as the task,
    // and have a separate relay process publish from there with retries
    // - which guarantees delivery without blocking the request. Worth
    // adding if losing an occasional event during a broker outage isn't
    // acceptable for what this evolves into.
    try {
      await this.queueService.publishTaskCreated(saved.id);
    } catch (err) {
      this.logger.warn(
        `Failed to publish task.created for ${saved.id}: ${(err as Error).message}`,
      );
    }

    return saved;
  }

  async findAll(): Promise<Task[]> {
    return this.readRepo.find(); // read path -> replica
  }
}
