import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AiCaptionService } from './ai-caption.service';
import {
  NEWS_CATEGORIES,
  NewsCategory,
  RawNewsItem,
} from './dto/threads-bot.dto';
import { ThreadsBotRepository } from './threads-bot.repository';
import { ThreadsBrowserService } from './threads-browser.service';

@Injectable()
export class ThreadsBotService {
  private readonly logger = new Logger(ThreadsBotService.name);
  private activeRun: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly threadsBrowserService: ThreadsBrowserService,
    private readonly aiCaptionService: AiCaptionService,
    private readonly threadsBotRepository: ThreadsBotRepository,
  ) {}

  // Runs the scheduled posting loop when THREADS_AUTO_SCHEDULE is enabled.
  @Cron(CronExpression.EVERY_2_HOURS)
  async runScheduledTrendLoop(): Promise<void> {
    if (process.env.THREADS_AUTO_SCHEDULE !== 'true') {
      this.logger.log(
        'Scheduled trends scan skipped; THREADS_AUTO_SCHEDULE is not true',
      );
      return;
    }

    this.logger.log('Starting scheduled trends scan');

    try {
      const maxPosts = Number(process.env.THREADS_SCHEDULE_MAX_POSTS ?? 1);
      await this.runPostingLoop(maxPosts);
    } catch (error) {
      this.logger.error('Scheduled trends scan failed', error);
      throw error;
    }
  }

  // Runs a manual one-shot scan and returns the number of successful posts.
  async runOnce(maxPosts = 1): Promise<number> {
    if (this.activeRun) {
      this.logger.warn('Trends scan already running; skipping new trigger');
      return 0;
    }

    this.logger.log(`Starting one-time trends scan, max posts: ${maxPosts}`);

    this.activeRun = this.runPostingLoop(maxPosts).finally(() => {
      this.activeRun = null;
    });

    const postedCount = await this.activeRun;

    this.logger.log(`One-time trends scan finished, posted: ${postedCount}`);
    return postedCount;
  }

  private async runPostingLoop(maxPosts: number): Promise<number> {
    const categories = this.getConfiguredCategories();
    let category = await this.getNextPostCategory(categories);
    let postedCount = 0;
    let emptyCategoryCount = 0;

    while (postedCount < maxPosts && emptyCategoryCount < categories.length) {
      this.logger.log(`Scanning category: ${category}`);
      const latestNews = await this.threadsBotRepository.fetchLatestNews(
        category,
        this.getCandidateLimitPerCategory(maxPosts),
      );
      let postedInCategory = false;

      for (const item of latestNews) {
        const posted = await this.processNewsItem(item, category);

        if (!posted) {
          continue;
        }

        postedCount += 1;
        postedInCategory = true;
        break;
      }

      emptyCategoryCount = postedInCategory ? 0 : emptyCategoryCount + 1;
      category = this.getNextCategory(category, categories);
    }

    return postedCount;
  }

  // Handles duplicate detection, caption generation, browser posting, and DB save.
  private async processNewsItem(
    item: RawNewsItem,
    category: NewsCategory,
  ): Promise<boolean> {
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
          category,
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
          category,
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

  private async getNextPostCategory(
    categories: NewsCategory[],
  ): Promise<NewsCategory> {
    const lastPost = await this.prisma.newsPost.findFirst({
      orderBy: { postedAt: 'desc' },
      select: { category: true },
    });

    if (!lastPost) {
      return categories[0];
    }

    return this.getNextCategory(lastPost.category, categories);
  }

  private getNextCategory(
    currentCategory: NewsCategory,
    categories: NewsCategory[],
  ): NewsCategory {
    const currentIndex = categories.indexOf(currentCategory);
    const nextIndex = currentIndex >= 0 ? currentIndex + 1 : 0;

    return categories[nextIndex % categories.length];
  }

  private getConfiguredCategories(): NewsCategory[] {
    const configuredCategories = process.env.THREADS_CATEGORY_ROTATION;

    if (!configuredCategories) {
      return ['OTHER', 'INTERNATIONAL', 'COMEDY', 'ROMANCE', 'EVENT'];
    }

    const categories = configuredCategories
      .split(',')
      .map((category) => category.trim().toUpperCase())
      .filter((category): category is NewsCategory =>
        NEWS_CATEGORIES.some((knownCategory) => knownCategory === category),
      );

    return categories.length > 0 ? categories : ['NATIONAL'];
  }

  private getCandidateLimitPerCategory(maxPosts: number): number {
    const configuredLimit = Number(
      process.env.THREADS_SCAN_CANDIDATES_PER_CATEGORY ?? maxPosts * 3,
    );

    if (!Number.isInteger(configuredLimit) || configuredLimit < 1) {
      return Math.max(3, maxPosts);
    }

    return Math.min(configuredLimit, 20);
  }
}
