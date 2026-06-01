import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AiCaptionService } from './ai-caption.service';
import { RawNewsItem } from './dto/threads-bot.dto';
import { ThreadsBotRepository } from './threads-bot.repository';
import { ThreadsBrowserService } from './threads-browser.service';

@Injectable()
export class ThreadsBotService {
  private readonly logger = new Logger(ThreadsBotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly threadsBrowserService: ThreadsBrowserService,
    private readonly aiCaptionService: AiCaptionService,
    private readonly threadsBotRepository: ThreadsBotRepository,
  ) {}

  // Runs the scheduled posting loop when THREADS_AUTO_SCHEDULE is enabled.
  @Cron(CronExpression.EVERY_30_MINUTES)
  async runHourlyTrendLoop(): Promise<void> {
    if (process.env.THREADS_AUTO_SCHEDULE !== 'true') {
      this.logger.log(
        'Hourly trends scan skipped; THREADS_AUTO_SCHEDULE is not true',
      );
      return;
    }

    this.logger.log('Starting hourly trends scan');

    try {
      const latestNews = await this.threadsBotRepository.fetchLatestNews();
      const maxPosts = Number(process.env.THREADS_SCHEDULE_MAX_POSTS ?? 1);
      let postedCount = 0;

      for (const item of latestNews) {
        const posted = await this.processNewsItem(item);

        if (posted) {
          postedCount += 1;
        }

        if (postedCount >= maxPosts) {
          break;
        }
      }
    } catch (error) {
      this.logger.error('Hourly trends scan failed', error);
      throw error;
    }
  }

  // Runs a manual one-shot scan and returns the number of successful posts.
  async runOnce(maxPosts = 1): Promise<number> {
    this.logger.log(`Starting one-time trends scan, max posts: ${maxPosts}`);

    const latestNews = await this.threadsBotRepository.fetchLatestNews();
    let postedCount = 0;

    for (const item of latestNews) {
      const posted = await this.processNewsItem(item);

      if (posted) {
        postedCount += 1;
      }

      if (postedCount >= maxPosts) {
        break;
      }
    }

    this.logger.log(`One-time trends scan finished, posted: ${postedCount}`);
    return postedCount;
  }

  // Handles duplicate detection, caption generation, browser posting, and DB save.
  private async processNewsItem(item: RawNewsItem): Promise<boolean> {
    const contentHash = this.generateContentHash(item);
    const existingPost = await this.prisma.newsPost.findUnique({
      where: { sourceUrl: item.sourceUrl },
    });

    if (!existingPost) {
      this.logger.log(`New post detected: ${item.sourceUrl}`);

      const caption = await this.aiCaptionService.generateCaption(item, false);
      const imagePath = await this.threadsBotRepository.downloadPostImage(item);

      try {
        await this.threadsBrowserService.postToThreads(caption, imagePath);
      } finally {
        await this.threadsBotRepository.cleanupDownloadedImage(imagePath);
      }

      await this.prisma.newsPost.create({
        data: {
          title: item.title,
          sourceUrl: item.sourceUrl,
          contentHash,
          isUpdate: false,
        },
      });

      return true;
    }

    if (existingPost.contentHash !== contentHash) {
      this.logger.log(`Update detected: ${item.sourceUrl}`);

      const caption = await this.aiCaptionService.generateCaption(item, true);
      const imagePath = await this.threadsBotRepository.downloadPostImage(item);

      try {
        await this.threadsBrowserService.postToThreads(caption, imagePath);
      } finally {
        await this.threadsBotRepository.cleanupDownloadedImage(imagePath);
      }

      await this.prisma.newsPost.update({
        where: { sourceUrl: item.sourceUrl },
        data: {
          title: item.title,
          contentHash,
          isUpdate: true,
          postedAt: new Date(),
        },
      });

      return true;
    }

    this.logger.log(`Skipping duplication: ${item.sourceUrl}`);
    return false;
  }

  // Builds a stable hash to detect whether a known source has changed.
  private generateContentHash(item: RawNewsItem): string {
    return createHash('md5')
      .update(`${item.title}:${item.description}`)
      .digest('hex');
  }
}
