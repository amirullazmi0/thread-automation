import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { firstValueFrom } from 'rxjs';
import {
  ArticleMetadata,
  GoogleNewsDecodeParams,
  GoogleNewsRss,
  GoogleNewsRssItem,
  NEWS_CATEGORIES,
  NewsCategory,
  NewsFeedDocument,
  NewsFeedItem,
  RawNewsItem,
} from './dto/threads-bot.dto';

@Injectable()
export class ThreadsBotRepository {
  private readonly logger = new Logger(ThreadsBotRepository.name);
  private readonly xmlParser = new XMLParser({
    ignoreAttributes: false,
  });

  constructor(private readonly httpService: HttpService) {}

  // Loads news from a custom endpoint when set, otherwise falls back to Google News RSS.
  async fetchLatestNews(
    category?: NewsCategory,
    maxItemsOverride?: number,
  ): Promise<RawNewsItem[]> {
    const endpoint = process.env.NEWS_SOURCE_URL;

    if (endpoint) {
      const response = await firstValueFrom(
        this.httpService.get<string>(endpoint, {
          proxy: false,
          responseType: 'text',
        }),
      );

      return this.parseConfiguredNewsSource(response.data, endpoint, category);
    }

    return this.fetchGoogleNewsRss(category, maxItemsOverride);
  }

  // Downloads the article image to a temporary local file for Playwright upload.
  async downloadPostImage(item: RawNewsItem): Promise<string | null> {
    if (!item.imageUrl) {
      return null;
    }

    try {
      const imagesDir = path.join(os.tmpdir(), 'thread-automation-images');
      await mkdir(imagesDir, { recursive: true });

      const imageUrl = new URL(item.imageUrl);
      const extension = this.getImageExtension(imageUrl.pathname);
      const imagePath = path.join(
        imagesDir,
        `${Date.now()}-${this.generateContentHash(item)}${extension}`,
      );

      const response = await firstValueFrom(
        this.httpService.get<Readable>(item.imageUrl, {
          proxy: false,
          responseType: 'stream',
          timeout: 20_000,
          maxContentLength: 8 * 1024 * 1024,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        }),
      );

      await new Promise<void>((resolve, reject) => {
        const writer = createWriteStream(imagePath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      this.logger.log(`Downloaded source image: ${item.imageUrl}`);
      return imagePath;
    } catch {
      this.logger.warn(`Failed to download source image: ${item.imageUrl}`);
      return null;
    }
  }

  // Removes any temporary image file after the post attempt finishes.
  async cleanupDownloadedImage(imagePath: string | null): Promise<void> {
    if (!imagePath) {
      return;
    }

    await rm(imagePath, { force: true }).catch(() => undefined);
  }

  // Fetches all configured Google News queries and returns deduped resolved articles.
  private async fetchGoogleNewsRss(
    category: NewsCategory = 'NATIONAL',
    maxItemsOverride?: number,
  ): Promise<RawNewsItem[]> {
    const queries = this.getGoogleNewsQueries(category);
    const maxItems = this.getGoogleNewsMaxItems(maxItemsOverride);
    const newsByUrl = new Map<string, RawNewsItem>();

    for (const query of queries) {
      const items = await this.fetchGoogleNewsQuery(query);

      for (const item of items) {
        const enrichedItem = await this.enrichNewsItem({
          ...item,
          category,
        });

        if (this.isGoogleNewsUrl(enrichedItem.sourceUrl)) {
          this.logger.warn(
            `Skipping news item because Google News URL could not be resolved: ${item.sourceUrl}`,
          );
          continue;
        }

        if (!this.isFreshNewsItem(enrichedItem)) {
          continue;
        }

        newsByUrl.set(enrichedItem.sourceUrl, enrichedItem);

        if (newsByUrl.size >= maxItems) {
          break;
        }
      }

      if (newsByUrl.size >= maxItems) {
        break;
      }
    }

    const latestNews = [...newsByUrl.values()].slice(0, maxItems);
    this.logger.log(
      `Fetched ${latestNews.length} Google News RSS items for ${category}`,
    );

    return latestNews;
  }

  // Parses a configured publisher feed or JSON endpoint into the internal news shape.
  private parseConfiguredNewsSource(
    payload: string,
    endpoint: string,
    category?: NewsCategory,
  ): RawNewsItem[] {
    const trimmedPayload = payload.trim();

    if (!trimmedPayload) {
      return [];
    }

    if (trimmedPayload.startsWith('<')) {
      return this.parseRssFeed(trimmedPayload, endpoint, category);
    }

    try {
      const parsed = JSON.parse(trimmedPayload) as
        | RawNewsItem[]
        | NewsFeedDocument;

      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => this.normalizeRawNewsItem(item))
          .filter((item): item is RawNewsItem => Boolean(item))
          .map((item) => this.applyRequestedCategory(item, category))
          .filter((item) => this.matchesRequestedCategory(item, category))
          .filter((item) => this.isFreshNewsItem(item))
          .filter((item) => this.isAllowedNewsItem(item));
      }

      return this.extractFeedItems(parsed, endpoint, category);
    } catch {
      this.logger.warn(
        `Configured news source is neither JSON nor RSS XML: ${endpoint}`,
      );
      return [];
    }
  }

  // Parses RSS XML from a configured endpoint into news items.
  private parseRssFeed(
    payload: string,
    endpoint: string,
    category?: NewsCategory,
  ): RawNewsItem[] {
    const parsed = this.xmlParser.parse(payload) as NewsFeedDocument;
    return this.extractFeedItems(parsed, endpoint, category);
  }

  // Normalizes RSS or JSON feed items into the internal raw news shape.
  private extractFeedItems(
    document: NewsFeedDocument,
    endpoint: string,
    category?: NewsCategory,
  ): RawNewsItem[] {
    const sourceHint = this.getSourceNameFromEndpoint(endpoint);
    const rssItems = document.rss?.channel?.item ?? document.feed?.entry ?? [];
    const items = Array.isArray(rssItems) ? rssItems : [rssItems];

    return items
      .map((item) => this.toRawNewsItemFromFeed(item, endpoint, category))
      .filter((item): item is RawNewsItem => Boolean(item))
      .filter((item) => this.matchesRequestedCategory(item, category))
      .filter((item) => this.isFreshNewsItem(item))
      .filter((item) => this.isAllowedNewsItem(item, sourceHint));
  }

  // Fetches and parses one Google News RSS query.
  private async fetchGoogleNewsQuery(query: string): Promise<RawNewsItem[]> {
    const response = await firstValueFrom(
      this.httpService.get<string>(this.buildGoogleNewsRssUrl(query), {
        proxy: false,
        responseType: 'text',
        timeout: 15_000,
      }),
    );
    const parsed = this.xmlParser.parse(response.data) as GoogleNewsRss;
    const rssItems = parsed.rss?.channel?.item ?? [];
    const items = Array.isArray(rssItems) ? rssItems : [rssItems];

    return items
      .map((item) => this.toRawNewsItem(item))
      .filter((item): item is RawNewsItem => Boolean(item))
      .filter((item) => this.isFreshNewsItem(item))
      .filter((item) => this.isAllowedNewsItem(item));
  }

  // Builds the Google News RSS search URL for one keyword query.
  private buildGoogleNewsRssUrl(query: string): string {
    const freshQuery = this.withGoogleNewsFreshnessOperator(query);
    const params = new URLSearchParams({
      q: freshQuery,
      hl: 'id',
      gl: 'ID',
      ceid: 'ID:id',
    });

    return `https://news.google.com/rss/search?${params.toString()}`;
  }

  // Reads comma-separated Google News queries from env.
  private getGoogleNewsQueries(category: NewsCategory): string[] {
    const categoryQueries = process.env[`GOOGLE_NEWS_${category}_QUERIES`];
    const configuredQueries =
      categoryQueries ??
      (category === 'NATIONAL' ? process.env.GOOGLE_NEWS_QUERIES : undefined);

    if (!configuredQueries) {
      return this.getDefaultGoogleNewsQueries(category);
    }

    return configuredQueries
      .split(',')
      .map((query) => query.trim())
      .filter(Boolean);
  }

  private getDefaultGoogleNewsQueries(category: NewsCategory): string[] {
    const queriesByCategory: Record<NewsCategory, string[]> = {
      NATIONAL: ['gosip artis Indonesia terbaru'],
      INTERNATIONAL: [
        'celebrity gossip terbaru dunia',
        'Hollywood celebrity gossip terbaru',
        'K-pop idol scandal news',
        'drama selebriti internasional terbaru',
      ],
      SPORT: ['gosip atlet selebriti olahraga viral'],
      EVENT: ['gosip konser festival artis Indonesia terbaru'],
      ZODIAC: ['zodiak selebriti ramalan bintang viral'],
      ROMANCE: ['gosip artis pacaran nikah cerai putus terbaru'],
      COMEDY: ['drama seleb viral lucu hiburan Indonesia'],
      OTHER: ['gosip artis viral Indonesia terbaru', 'celebrity gossip viral'],
    };

    return queriesByCategory[category];
  }

  private getGoogleNewsMaxItems(maxItemsOverride?: number): number {
    if (
      Number.isInteger(maxItemsOverride) &&
      maxItemsOverride !== undefined &&
      maxItemsOverride > 0
    ) {
      return maxItemsOverride;
    }

    const configuredMaxItems = Number(process.env.GOOGLE_NEWS_MAX_ITEMS ?? 20);

    if (!Number.isInteger(configuredMaxItems) || configuredMaxItems < 1) {
      return 20;
    }

    return configuredMaxItems;
  }

  // Converts one RSS item into the internal news item shape.
  private toRawNewsItem(item: GoogleNewsRssItem): RawNewsItem | null {
    if (!item.title || !item.link) {
      return null;
    }

    return {
      title: this.stripHtml(item.title),
      description: this.stripHtml(item.description ?? item.title),
      sourceUrl: item.link,
      imageUrl: null,
      category: null,
      publishedAt: this.normalizePublishedAt(item.pubDate),
    };
  }

  // Converts a publisher RSS or Atom item into the internal news item shape.
  private toRawNewsItemFromFeed(
    item: NewsFeedItem,
    baseUrl: string,
    category?: NewsCategory,
  ): RawNewsItem | null {
    const title = this.stripHtml(item.title ?? '');
    const sourceUrl = this.extractFeedItemUrl(item, baseUrl);

    if (!title || !sourceUrl) {
      return null;
    }

    return {
      title,
      description: this.stripHtml(
        item.description ?? item.summary ?? item.content ?? title,
      ),
      sourceUrl,
      imageUrl: this.extractFeedItemImageUrl(item, baseUrl),
      category,
      publishedAt: this.extractFeedItemPublishedAt(item),
    };
  }

  // Resolves the publisher URL and pulls article metadata such as og:image.
  private async enrichNewsItem(item: RawNewsItem): Promise<RawNewsItem> {
    let articleUrl: string;

    try {
      articleUrl = await this.resolveArticleUrl(item.sourceUrl);
    } catch {
      this.logger.warn(
        `Failed to resolve news URL; using RSS link: ${item.sourceUrl}`,
      );
      return item;
    }

    try {
      const articleMetadata = await this.fetchArticleMetadata(articleUrl);

      return {
        ...item,
        sourceUrl: articleUrl,
        imageUrl: articleMetadata.imageUrl,
        publishedAt: item.publishedAt ?? articleMetadata.publishedAt,
      };
    } catch {
      this.logger.warn(
        `Failed to fetch article metadata; using article URL without image: ${articleUrl}`,
      );
      return {
        ...item,
        sourceUrl: articleUrl,
        imageUrl: null,
      };
    }
  }

  // Resolves Google News wrapper links into direct publisher links.
  private async resolveArticleUrl(url: string): Promise<string> {
    if (!this.isGoogleNewsUrl(url)) {
      return url;
    }

    const decodedUrl = await this.decodeGoogleNewsUrl(url);

    if (decodedUrl && !this.isGoogleNewsUrl(decodedUrl)) {
      return decodedUrl;
    }

    const response = await firstValueFrom(
      this.httpService.get<string>(url, {
        maxRedirects: 5,
        proxy: false,
        responseType: 'text',
        timeout: 15_000,
        validateStatus: (status) => status >= 200 && status < 400,
      }),
    );

    const responseUrl =
      response.request?.res?.responseUrl ||
      response.request?.responseURL ||
      url;

    if (!this.isGoogleNewsUrl(responseUrl)) {
      return responseUrl;
    }

    const canonicalUrl = this.extractCanonicalUrl(response.data, responseUrl);
    const resolvedUrl = canonicalUrl ?? responseUrl;

    return this.isGoogleNewsUrl(resolvedUrl) ? url : resolvedUrl;
  }

  // Calls Google News' internal resolver endpoint for RSS article IDs.
  private async decodeGoogleNewsUrl(url: string): Promise<string | null> {
    const articleId = this.getGoogleNewsArticleId(url);

    if (!articleId) {
      return null;
    }

    const decodeParams = await this.fetchGoogleNewsDecodeParams(url).catch(
      () => null,
    );

    if (decodeParams) {
      try {
        const decodedUrl = await this.decodeGoogleNewsSignedUrl(decodeParams);

        if (decodedUrl) {
          return decodedUrl;
        }
      } catch {
        // Fall back to the generic article ID flow below.
      }
    }

    try {
      const decodedUrl = await this.decodeGoogleNewsArticleId(articleId);

      if (decodedUrl) {
        return decodedUrl;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async decodeGoogleNewsSignedUrl(
    decodeParams: GoogleNewsDecodeParams,
  ): Promise<string | null> {
    // Google News RSS links are wrappers. This internal RPC is the only
    // reliable way we found to get the publisher URL before scraping og:image.
    const batchPayload = JSON.stringify([
      [
        [
          'Fbv4je',
          JSON.stringify([
            'garturlreq',
            [
              [
                'X',
                'X',
                ['X', 'X'],
                null,
                null,
                1,
                1,
                'US:en',
                null,
                1,
                null,
                null,
                null,
                null,
                null,
                0,
                1,
              ],
              'X',
              'X',
              1,
              [1, 1, 1],
              1,
              1,
              null,
              0,
              0,
              null,
              0,
            ],
            decodeParams.articleId,
            Number(decodeParams.timestamp),
            decodeParams.signature,
          ]),
        ],
      ],
    ]);

    const response = await firstValueFrom(
      this.httpService.post<string>(
        'https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je',
        `f.req=${encodeURIComponent(batchPayload)}`,
        {
          proxy: false,
          responseType: 'text',
          timeout: 10_000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
            Referer: 'https://news.google.com/',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        },
      ),
    );

    return this.extractDecodedGoogleNewsUrl(response.data);
  }

  private async decodeGoogleNewsArticleId(
    articleId: string,
  ): Promise<string | null> {
    const batchPayload = JSON.stringify([
      [
        [
          'Fbv4je',
          JSON.stringify([
            'garturlreq',
            [
              [
                'en-US',
                'US',
                ['FINANCE_TOP_INDICES', 'WEB_TEST_1_0_0'],
                null,
                null,
                1,
                1,
                'US:en',
                null,
                180,
                null,
                null,
                null,
                null,
                null,
                0,
                null,
                null,
                [1608992183, 723341000],
              ],
              'en-US',
              'US',
              1,
              [2, 3, 4, 8],
              1,
              0,
              '655000234',
              0,
              0,
              null,
              0,
            ],
            articleId,
          ]),
          null,
          'generic',
        ],
      ],
    ]);

    const response = await firstValueFrom(
      this.httpService.post<string>(
        'https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je',
        `f.req=${encodeURIComponent(batchPayload)}`,
        {
          proxy: false,
          responseType: 'text',
          timeout: 10_000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
            Referer: 'https://news.google.com/',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        },
      ),
    );

    return this.extractDecodedGoogleNewsUrl(response.data);
  }

  // Fetches the Google News wrapper page to get decode signature and timestamp.
  private async fetchGoogleNewsDecodeParams(
    url: string,
  ): Promise<GoogleNewsDecodeParams | null> {
    const articleId = this.getGoogleNewsArticleId(url);

    if (!articleId) {
      return null;
    }

    const decodeParamUrls = [
      `https://news.google.com/articles/${articleId}`,
      `https://news.google.com/rss/articles/${articleId}`,
    ];

    for (const decodeParamUrl of decodeParamUrls) {
      const response = await firstValueFrom(
        this.httpService.get<string>(decodeParamUrl, {
          proxy: false,
          responseType: 'text',
          timeout: 15_000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        }),
      ).catch(() => null);

      if (!response) {
        continue;
      }

      const signature = this.extractHtmlAttribute(response.data, 'data-n-a-sg');
      const timestamp = this.extractHtmlAttribute(response.data, 'data-n-a-ts');

      if (signature && timestamp) {
        return {
          articleId,
          signature,
          timestamp,
        };
      }
    }

    return null;
  }

  // Extracts the opaque article ID from a Google News RSS URL.
  private getGoogleNewsArticleId(url: string): string | null {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\/(?:rss\/)?articles\/([^/?]+)/);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  // Parses the resolver response and returns the decoded publisher URL.
  private extractDecodedGoogleNewsUrl(response: string): string | null {
    const payloadLine = response
      .split('\n')
      .find((line) => line.trim().startsWith('[['));

    if (!payloadLine) {
      return null;
    }

    const payload = JSON.parse(payloadLine) as Array<Array<unknown>>;
    const encodedResult = payload[0]?.[2];

    if (typeof encodedResult !== 'string') {
      return null;
    }

    const decodedResult = JSON.parse(encodedResult) as unknown;

    return this.findPublisherUrl(decodedResult);
  }

  private findPublisherUrl(value: unknown): string | null {
    if (typeof value === 'string') {
      return value.startsWith('http') && !this.isGoogleNewsUrl(value)
        ? value
        : null;
    }

    if (!Array.isArray(value)) {
      return null;
    }

    for (const item of value) {
      const publisherUrl = this.findPublisherUrl(item);

      if (publisherUrl) {
        return publisherUrl;
      }
    }

    return null;
  }

  // Fetches an article page and returns metadata needed for posting.
  private async fetchArticleMetadata(url: string): Promise<ArticleMetadata> {
    const response = await firstValueFrom(
      this.httpService.get<string>(url, {
        maxRedirects: 5,
        proxy: false,
        responseType: 'text',
        timeout: 15_000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }),
    );

    return {
      imageUrl: this.extractImageUrl(response.data, url),
      publishedAt: this.extractArticlePublishedAt(response.data),
    };
  }

  // Extracts a canonical article URL from HTML metadata.
  private extractCanonicalUrl(html: string, baseUrl: string): string | null {
    const url =
      this.extractMetaContent(html, 'property', 'og:url') ||
      this.extractLinkHref(html, 'canonical');

    return url ? this.toAbsoluteUrl(url, baseUrl) : null;
  }

  // Extracts the best available image URL from Open Graph/Twitter metadata.
  private extractImageUrl(html: string, baseUrl: string): string | null {
    const imageUrl =
      this.extractMetaContent(html, 'property', 'og:image') ||
      this.extractMetaContent(html, 'name', 'twitter:image') ||
      this.extractMetaContent(html, 'property', 'twitter:image');

    return imageUrl ? this.toAbsoluteUrl(imageUrl, baseUrl) : null;
  }

  // Extracts a usable link from RSS or Atom feed items.
  private extractFeedItemUrl(
    item: NewsFeedItem,
    baseUrl: string,
  ): string | null {
    if (typeof item.link === 'string') {
      return this.toAbsoluteUrl(item.link, baseUrl);
    }

    const href = item.link?.['@_href'];
    return href ? this.toAbsoluteUrl(href, baseUrl) : null;
  }

  // Extracts an image URL from RSS media/enclosure fields when present.
  private extractFeedItemImageUrl(
    item: NewsFeedItem,
    baseUrl: string,
  ): string | null {
    const mediaContent = Array.isArray(item['media:content'])
      ? item['media:content'][0]
      : item['media:content'];
    const enclosure = Array.isArray(item.enclosure)
      ? item.enclosure[0]
      : item.enclosure;
    const imageUrl = mediaContent?.['@_url'] ?? enclosure?.['@_url'] ?? null;

    return imageUrl ? this.toAbsoluteUrl(imageUrl, baseUrl) : null;
  }

  // Normalizes a JSON item returned by a custom endpoint.
  private normalizeRawNewsItem(item: RawNewsItem): RawNewsItem | null {
    if (!item.title || !item.sourceUrl) {
      return null;
    }

    return {
      title: this.stripHtml(item.title),
      description: this.stripHtml(item.description ?? item.title),
      sourceUrl: item.sourceUrl,
      imageUrl: item.imageUrl ?? null,
      category: this.normalizeCategory(item.category),
      publishedAt: this.normalizePublishedAt(item.publishedAt),
    };
  }

  private isFreshNewsItem(item: RawNewsItem): boolean {
    const maxAgeDays = this.getMaxNewsAgeDays();

    if (maxAgeDays <= 0) {
      return true;
    }

    if (!item.publishedAt) {
      this.logger.log(`Skipping undated news item: ${item.title}`);
      return false;
    }

    const publishedAt = Date.parse(item.publishedAt);

    if (Number.isNaN(publishedAt)) {
      this.logger.log(`Skipping news item with invalid date: ${item.title}`);
      return false;
    }

    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const ageMs = Date.now() - publishedAt;
    const isFresh = ageMs >= 0 && ageMs <= maxAgeMs;

    if (!isFresh) {
      this.logger.log(
        `Skipping stale news item older than ${maxAgeDays} day(s): ${item.title}`,
      );
    }

    return isFresh;
  }

  private getMaxNewsAgeDays(): number {
    const configuredDays = Number(process.env.THREADS_MAX_NEWS_AGE_DAYS ?? 2);

    if (!Number.isInteger(configuredDays) || configuredDays < 0) {
      return 2;
    }

    return Math.min(configuredDays, 30);
  }

  private withGoogleNewsFreshnessOperator(query: string): string {
    if (/\bwhen:\d+[dhm]\b/i.test(query)) {
      return query;
    }

    return `${query} when:${this.getMaxNewsAgeDays()}d`;
  }

  private extractFeedItemPublishedAt(item: NewsFeedItem): string | null {
    return this.normalizePublishedAt(
      item.pubDate ??
        item.published ??
        item.updated ??
        item['dc:date'] ??
        item.isoDate,
    );
  }

  private extractArticlePublishedAt(html: string): string | null {
    return this.normalizePublishedAt(
      this.extractMetaContent(html, 'property', 'article:published_time') ||
        this.extractMetaContent(html, 'property', 'og:published_time') ||
        this.extractMetaContent(html, 'name', 'pubdate') ||
        this.extractMetaContent(html, 'name', 'publishdate') ||
        this.extractMetaContent(html, 'name', 'timestamp') ||
        this.extractMetaContent(html, 'itemprop', 'datePublished'),
    );
  }

  private normalizePublishedAt(value?: string | null): string | null {
    if (!value) {
      return null;
    }

    const parsedDate = new Date(value);

    if (Number.isNaN(parsedDate.getTime())) {
      return null;
    }

    return parsedDate.toISOString();
  }

  private applyRequestedCategory(
    item: RawNewsItem,
    category?: NewsCategory,
  ): RawNewsItem {
    if (!category || item.category) {
      return item;
    }

    return {
      ...item,
      category,
    };
  }

  private matchesRequestedCategory(
    item: RawNewsItem,
    category?: NewsCategory,
  ): boolean {
    if (!category) {
      return true;
    }

    return !item.category || item.category === category;
  }

  private normalizeCategory(category?: string | null): NewsCategory | null {
    const normalizedCategory = category?.trim().toUpperCase();

    if (!normalizedCategory) {
      return null;
    }

    return NEWS_CATEGORIES.find((item) => item === normalizedCategory) ?? null;
  }

  // Reads a specific meta tag content value from HTML.
  private extractMetaContent(
    html: string,
    attributeName: string,
    attributeValue: string,
  ): string | null {
    const pattern = new RegExp(
      `<meta[^>]+${attributeName}=["']${this.escapeRegExp(attributeValue)}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+${attributeName}=["']${this.escapeRegExp(attributeValue)}["'][^>]*>`,
      'i',
    );
    const match = html.match(pattern);
    return match?.[1] || match?.[2] || null;
  }

  // Reads a specific link tag href value from HTML.
  private extractLinkHref(html: string, rel: string): string | null {
    const pattern = new RegExp(
      `<link[^>]+rel=["']${this.escapeRegExp(rel)}["'][^>]+href=["']([^"']+)["'][^>]*>|<link[^>]+href=["']([^"']+)["'][^>]+rel=["']${this.escapeRegExp(rel)}["'][^>]*>`,
      'i',
    );
    const match = html.match(pattern);
    return match?.[1] || match?.[2] || null;
  }

  // Reads an HTML attribute value by name.
  private extractHtmlAttribute(
    html: string,
    attributeName: string,
  ): string | null {
    const pattern = new RegExp(
      `${this.escapeRegExp(attributeName)}=["']([^"']+)["']`,
      'i',
    );
    const match = html.match(pattern);
    return match?.[1] ?? null;
  }

  // Applies source allowlist and excluded-term filters before enrichment.
  private isAllowedNewsItem(
    item: RawNewsItem,
    sourceHint?: string | null,
  ): boolean {
    const sourceName = this.getSourceName(item.title) ?? sourceHint ?? null;
    const allowedSources = this.getAllowedSources();

    if (allowedSources.length > 0) {
      const matchedSource = allowedSources.find(
        (source) => sourceName?.toLowerCase() === source.toLowerCase(),
      );

      if (!matchedSource) {
        this.logger.log(
          `Skipping news item from unlisted source "${sourceName ?? 'unknown'}": ${item.title}`,
        );
        return false;
      }
    }

    const searchableText = `${item.title} ${item.description}`.toLowerCase();

    if (this.hasStaleYearReference(searchableText)) {
      this.logger.log(
        `Skipping news item with stale year reference: ${item.title}`,
      );
      return false;
    }

    const excludedTerms = this.getExcludedTerms();

    if (excludedTerms.length === 0) {
      return true;
    }

    const excludedTerm = excludedTerms.find((term) =>
      searchableText.includes(term.toLowerCase()),
    );

    if (excludedTerm) {
      this.logger.log(
        `Skipping news item matching excluded term "${excludedTerm}": ${item.title}`,
      );
      return false;
    }

    return true;
  }

  private hasStaleYearReference(text: string): boolean {
    const currentYear = new Date().getFullYear();
    const years = text.match(/\b20\d{2}\b/g) ?? [];

    return years.some((year) => Number(year) < currentYear);
  }

  // Builds a stable hash for image file naming and content tracking.
  private generateContentHash(item: RawNewsItem): string {
    return createHash('md5')
      .update(`${item.title}:${item.description}`)
      .digest('hex');
  }

  // Pulls the publisher/source name suffix from Google News titles.
  private getSourceName(title: string): string | null {
    const sourceMatch = title.match(/\s+-\s+(.+)$/);
    return sourceMatch?.[1]?.trim() || null;
  }

  // Derives a publisher name from a configured feed URL so source filtering still works.
  private getSourceNameFromEndpoint(endpoint: string): string | null {
    try {
      const hostname = new URL(endpoint).hostname.toLowerCase();

      if (hostname.includes('tempo.co')) {
        return 'Tempo.co';
      }

      if (hostname.includes('cnnindonesia.com')) {
        return 'CNN Indonesia';
      }

      if (hostname.includes('cnbcindonesia.com')) {
        return 'CNBC Indonesia';
      }

      if (hostname.includes('kompas.com')) {
        return 'Kompas.com';
      }

      if (hostname.includes('detik.com')) {
        return 'detikcom';
      }

      return null;
    } catch {
      return null;
    }
  }

  // Reads comma-separated allowed source names from env.
  private getAllowedSources(): string[] {
    const configuredSources = process.env.GOOGLE_NEWS_ALLOWED_SOURCES;

    if (!configuredSources) {
      return [];
    }

    return configuredSources
      .split(',')
      .map((source) => source.trim())
      .filter(Boolean);
  }

  // Reads comma-separated terms that should never be posted.
  private getExcludedTerms(): string[] {
    const configuredTerms = process.env.GOOGLE_NEWS_EXCLUDED_TERMS;

    if (!configuredTerms) {
      return [];
    }

    return configuredTerms
      .split(',')
      .map((term) => term.trim())
      .filter(Boolean);
  }

  // Removes simple HTML markup/entities from RSS title and description fields.
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

  // Detects whether a URL still points to Google News instead of a publisher.
  private isGoogleNewsUrl(url: string): boolean {
    try {
      return new URL(url).hostname.endsWith('news.google.com');
    } catch {
      return false;
    }
  }

  // Converts relative metadata URLs into absolute URLs.
  private toAbsoluteUrl(url: string, baseUrl: string): string {
    return new URL(url, baseUrl).toString();
  }

  // Chooses a safe image extension for downloaded article images.
  private getImageExtension(pathname: string): string {
    const extension = path.extname(pathname).toLowerCase();
    const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);

    return allowedExtensions.has(extension) ? extension : '.jpg';
  }

  // Escapes values before embedding them inside RegExp patterns.
  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
