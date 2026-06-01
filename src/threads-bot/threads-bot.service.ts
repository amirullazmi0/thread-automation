import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { AiCaptionService } from './ai-caption.service';
import { ThreadsBrowserService } from './threads-browser.service';

interface RawNewsItem {
  title: string;
  description: string;
  sourceUrl: string;
}

interface GoogleNewsRss {
  rss?: {
    channel?: {
      item?: GoogleNewsRssItem | GoogleNewsRssItem[];
    };
  };
}

interface GoogleNewsRssItem {
  title?: string;
  link?: string;
  description?: string;
}

@Injectable()
export class ThreadsBotService {
  private readonly logger = new Logger(ThreadsBotService.name);
  private readonly xmlParser = new XMLParser({
    ignoreAttributes: false,
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly threadsBrowserService: ThreadsBrowserService,
    private readonly httpService: HttpService,
    private readonly aiCaptionService: AiCaptionService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async runHourlyTrendLoop(): Promise<void> {
    this.logger.log('Starting hourly trends scan');

    try {
      const latestNews = await this.fetchLatestNews();

      for (const item of latestNews) {
        await this.processNewsItem(item);
      }
    } catch (error) {
      this.logger.error('Hourly trends scan failed', error);
      throw error;
    }
  }

  async runOnce(maxPosts = 1): Promise<number> {
    this.logger.log(`Starting one-time trends scan, max posts: ${maxPosts}`);

    const latestNews = await this.fetchLatestNews();
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

  private async processNewsItem(item: RawNewsItem): Promise<boolean> {
    const contentHash = this.generateContentHash(item);
    const existingPost = await this.prisma.newsPost.findUnique({
      where: { sourceUrl: item.sourceUrl },
    });

    if (!existingPost) {
      this.logger.log(`New post detected: ${item.sourceUrl}`);

      const caption = await this.aiCaptionService.generateCaption(item, false);
      await this.threadsBrowserService.postToThreads(caption);

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
      await this.threadsBrowserService.postToThreads(caption);

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

  private generateContentHash(item: RawNewsItem): string {
    return createHash('md5')
      .update(`${item.title}:${item.description}`)
      .digest('hex');
  }

  private async fetchLatestNews(): Promise<RawNewsItem[]> {
    const endpoint = process.env.NEWS_SOURCE_URL;

    if (endpoint) {
      const response = await firstValueFrom(
        this.httpService.get<RawNewsItem[]>(endpoint, { proxy: false }),
      );

      return response.data;
    }

    return this.fetchGoogleNewsRss();
  }

  private async fetchGoogleNewsRss(): Promise<RawNewsItem[]> {
    const queries = this.getGoogleNewsQueries();
    const maxItems = Number(process.env.GOOGLE_NEWS_MAX_ITEMS ?? 20);
    const newsByUrl = new Map<string, RawNewsItem>();

    for (const query of queries) {
      const items = await this.fetchGoogleNewsQuery(query);

      for (const item of items) {
        newsByUrl.set(item.sourceUrl, item);
      }
    }

    const latestNews = [...newsByUrl.values()].slice(0, maxItems);
    this.logger.log(`Fetched ${latestNews.length} Google News RSS items`);

    return latestNews;
  }

  private async fetchGoogleNewsQuery(query: string): Promise<RawNewsItem[]> {
    const response = await firstValueFrom(
      this.httpService.get<string>(this.buildGoogleNewsRssUrl(query), {
        proxy: false,
        responseType: 'text',
      }),
    );
    const parsed = this.xmlParser.parse(response.data) as GoogleNewsRss;
    const rssItems = parsed.rss?.channel?.item ?? [];
    const items = Array.isArray(rssItems) ? rssItems : [rssItems];

    return items
      .map((item) => this.toRawNewsItem(item))
      .filter((item): item is RawNewsItem => Boolean(item));
  }

  private buildGoogleNewsRssUrl(query: string): string {
    const params = new URLSearchParams({
      q: query,
      hl: 'id',
      gl: 'ID',
      ceid: 'ID:id',
    });

    return `https://news.google.com/rss/search?${params.toString()}`;
  }

  private getGoogleNewsQueries(): string[] {
    const configuredQueries = process.env.GOOGLE_NEWS_QUERIES;

    if (!configuredQueries) {
      return ['berita terkini Indonesia'];
    }

    return configuredQueries
      .split(',')
      .map((query) => query.trim())
      .filter(Boolean);
  }

  private toRawNewsItem(item: GoogleNewsRssItem): RawNewsItem | null {
    if (!item.title || !item.link) {
      return null;
    }

    return {
      title: this.stripHtml(item.title),
      description: this.stripHtml(item.description ?? item.title),
      sourceUrl: item.link,
    };
  }

  private stripHtml(value: string): string {
    return value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
}
