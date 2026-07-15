import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Task } from '../database/entities/task.entity';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(Task, 'default') private readonly writeRepo: Repository<Task>,
    @InjectRepository(Task, 'replica') private readonly readRepo: Repository<Task>,
    private readonly queueService: QueueService,
  ) {}

  async create(title: string): Promise<Task> {
    const task = this.writeRepo.create({ title });
    const saved = await this.writeRepo.save(task); // write path -> primary

    // Fire-and-forget side effect, decoupled from the request via the queue.
    await this.queueService.publishTaskCreated(saved.id);

    return saved;
  }

  async findAll(): Promise<Task[]> {
    return this.readRepo.find(); // read path -> replica
  }
}
