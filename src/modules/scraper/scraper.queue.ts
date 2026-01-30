import { Injectable, Logger } from '@nestjs/common';
import type { ScraperResult } from './scraper.types';

interface QueuedTask {
  id: string;
  name: string;
  execute: () => Promise<ScraperResult>;
  resolve: (value: ScraperResult) => void;
  reject: (error: Error) => void;
}

/**
 * Queue for managing scraper tasks to prevent concurrency issues.
 * Only one scraper task can run at a time.
 */
@Injectable()
export class ScraperQueue {
  private readonly logger = new Logger(ScraperQueue.name);
  private queue: QueuedTask[] = [];
  private isProcessing = false;
  private currentTask: QueuedTask | null = null;
  private lastResult: ScraperResult | null = null;

  /**
   * Add a task to the queue. Tasks are processed sequentially.
   */
  async enqueue(name: string, execute: () => Promise<ScraperResult>): Promise<ScraperResult> {
    return new Promise((resolve, reject) => {
      const task: QueuedTask = {
        id: `${name}-${Date.now()}`,
        name,
        execute,
        resolve,
        reject,
      };

      this.queue.push(task);
      this.logger.log(`Task "${name}" added to queue. Queue size: ${this.queue.length}`);

      this.processNext();
    });
  }

  isRunning(): boolean {
    return this.isProcessing;
  }

  getStatus() {
    return {
      isProcessing: this.isProcessing,
      currentTask: this.currentTask?.name || null,
      queueLength: this.queue.length,
      queuedTasks: this.queue.map(t => t.name),
      lastResult: this.lastResult,
    };
  }

  clear() {
    const cleared = this.queue.length;
    this.queue.forEach(task => {
      task.reject(new Error('Queue cleared'));
    });
    this.queue = [];
    this.logger.log(`Queue cleared. Removed ${cleared} pending tasks.`);
    return cleared;
  }

  /**
   * Force reset the queue state. Use with caution - only when the queue is stuck.
   */
  forceReset() {
    const wasProcessing = this.isProcessing;
    const currentTaskName = this.currentTask?.name;

    // Clear everything
    this.queue.forEach(task => {
      task.reject(new Error('Queue force reset'));
    });
    this.queue = [];
    this.isProcessing = false;
    this.currentTask = null;

    this.logger.warn(`Queue force reset. Was processing: ${wasProcessing}, Task: ${currentTaskName}`);

    return {
      wasProcessing,
      currentTaskName,
      message: 'Queue has been force reset',
    };
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    this.currentTask = this.queue.shift()!;

    this.logger.log(`Starting task "${this.currentTask.name}"`);

    try {
      const result = await this.currentTask.execute();
      this.lastResult = result;
      this.logger.log(`Task "${this.currentTask.name}" completed successfully`);
      this.currentTask.resolve(result);
    } catch (error) {
      this.logger.error(`Task "${this.currentTask.name}" failed: ${error}`);
      this.lastResult = {
        comics: 0,
        chapters: 0,
        errors: [String(error)],
      };
      this.currentTask.reject(error as Error);
    } finally {
      this.currentTask = null;
      this.isProcessing = false;
      this.processNext();
    }
  }
}
