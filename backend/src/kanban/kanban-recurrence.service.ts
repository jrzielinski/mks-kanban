// src/kanban/kanban-recurrence.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { KanbanCardEntity, KanbanRecurrence } from './entities/kanban-card.entity';

@Injectable()
export class KanbanRecurrenceService {
  private readonly logger = new Logger(KanbanRecurrenceService.name);

  constructor(
    @InjectRepository(KanbanCardEntity) private cardRepo: Repository<KanbanCardEntity>,
  ) {}

  /** Runs daily at 00:05 to clone recurring cards */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async processRecurringCards(): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const cards = await this.cardRepo.find({
      where: { isArchived: false, recurrence: Not(IsNull()) },
    });

    for (const card of cards) {
      if (!card.recurrence) continue;
      const nextRun = card.recurrence.nextRun ? new Date(card.recurrence.nextRun) : null;
      if (!nextRun) {
        // First time — set nextRun and skip
        await this.cardRepo.update(card.id, {
          recurrence: { ...card.recurrence, nextRun: this.computeNextRun(card.recurrence, today).toISOString() },
        });
        continue;
      }

      const runDay = new Date(nextRun);
      runDay.setHours(0, 0, 0, 0);
      if (runDay.getTime() > today.getTime()) continue;

      // Clone card
      try {
        const { id: _id, createdAt: _ca, updatedAt: _ua, ...rest } = card as any;
        const clone = this.cardRepo.create({
          ...rest,
          title: card.title,
          position: 0, // will be placed at top
          dueDate: null,
          startDate: null,
          recurrence: null,
          isArchived: false,
        });

        // Shift existing cards down
        await this.cardRepo.increment({ listId: card.listId, tenantId: card.tenantId }, 'position', 1);
        await this.cardRepo.save(clone);

        // Update nextRun
        const next = this.computeNextRun(card.recurrence, today);
        await this.cardRepo.update(card.id, {
          recurrence: { ...card.recurrence, nextRun: next.toISOString() },
        });

        this.logger.log(`Cloned recurring card "${card.title}" (${card.id}) → next: ${next.toISOString()}`);
      } catch (err) {
        this.logger.error(`Failed to clone recurring card ${card.id}: ${err}`);
      }
    }
  }

  private computeNextRun(rec: KanbanRecurrence, from: Date): Date {
    const next = new Date(from);
    if (rec.frequency === 'daily') {
      next.setDate(next.getDate() + 1);
    } else if (rec.frequency === 'weekly') {
      next.setDate(next.getDate() + 7);
    } else if (rec.frequency === 'monthly') {
      next.setMonth(next.getMonth() + 1);
      if (rec.dayOfMonth) {
        next.setDate(Math.min(rec.dayOfMonth, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
      }
    }
    return next;
  }
}
