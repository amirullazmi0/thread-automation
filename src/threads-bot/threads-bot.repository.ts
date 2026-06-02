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
  async fetchLatestNews(category?: NewsCategory): Promise<RawNewsItem[]> {
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

    return this.fetchGoogleNewsRss(category);
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
    } catch (error) {
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
  ): Promise<RawNewsItem[]> {
    const queries = this.getGoogleNewsQueries(category);
    const maxItems = Number(process.env.GOOGLE_NEWS_MAX_ITEMS ?? 20);
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

        newsByUrl.set(enrichedItem.sourceUrl, enrichedItem);
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
      .filter((item) => this.isAllowedNewsItem(item, sourceHint));
  }

  // Fetches and parses one Google News RSS query.
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
      .filter((item): item is RawNewsItem => Boolean(item))
      .filter((item) => this.isAllowedNewsItem(item));
  }

  // Builds the Google News RSS search URL for one keyword query.
  private buildGoogleNewsRssUrl(query: string): string {
    const params = new URLSearchParams({
      q: query,
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
      NATIONAL: ['berita nasional Indonesia terkini'],
      INTERNATIONAL: ['berita internasional terkini dunia'],
      SPORT: ['berita olahraga Indonesia sepak bola badminton'],
      EVENT: ['event konser festival pameran Indonesia terbaru'],
      ZODIAC: ['zodiak hari ini ramalan bintang'],
      ROMANCE: ['relationship asmara percintaan tips hubungan'],
      COMEDY: ['komedi viral lucu hiburan Indonesia'],
      OTHER: ['berita viral Indonesia terkini'],
    };

    return queriesByCategory[category];
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
    };
  }

  // Resolves the publisher URL and pulls article metadata such as og:image.
  private async enrichNewsItem(item: RawNewsItem): Promise<RawNewsItem> {
    let articleUrl: string;

    try {
      articleUrl = await this.resolveArticleUrl(item.sourceUrl);
    } catch (error) {
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
      };
    } catch (error) {
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
    const decodeParams = await this.fetchGoogleNewsDecodeParams(url);

    if (!decodeParams) {
      return null;
    }

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
        'https://news.google.com/_/DotsSplashUi/data/batchexecute',
        `f.req=${encodeURIComponent(batchPayload)}`,
        {
          proxy: false,
          responseType: 'text',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
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

    const response = await firstValueFrom(
      this.httpService.get<string>(
        `https://news.google.com/articles/${articleId}`,
        {
          proxy: false,
          responseType: 'text',
          timeout: 15_000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        },
      ),
    );

    const signature = this.extractHtmlAttribute(response.data, 'data-n-a-sg');
    const timestamp = this.extractHtmlAttribute(response.data, 'data-n-a-ts');

    if (!signature || !timestamp) {
      return null;
    }

    return {
      articleId,
      signature,
      timestamp,
    };
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

    const payload = JSON.parse(payloadLine) as Array<Array<string>>;
    const encodedResult = payload[0]?.[2];

    if (!encodedResult) {
      return null;
    }

    const decodedResult = JSON.parse(encodedResult) as unknown[];
    const publisherUrl = decodedResult[1];

    return typeof publisherUrl === 'string' ? publisherUrl : null;
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
    };
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

    const excludedTerms = this.getExcludedTerms();

    if (excludedTerms.length === 0) {
      return true;
    }

    const searchableText = `${item.title} ${item.description}`.toLowerCase();
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
