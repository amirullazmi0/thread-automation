export const NEWS_CATEGORIES = [
  'NATIONAL',
  'INTERNATIONAL',
  'SPORT',
  'EVENT',
  'ZODIAC',
  'ROMANCE',
  'COMEDY',
  'OTHER',
] as const;

export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export interface RawNewsItem {
  title: string;
  description: string;
  sourceUrl: string;
  imageUrl?: string | null;
  category?: NewsCategory | null;
  publishedAt?: string | null;
}

export interface CaptionNewsItem {
  title: string;
  description: string;
  sourceUrl: string;
}

export interface GoogleNewsRss {
  rss?: {
    channel?: {
      item?: GoogleNewsRssItem | GoogleNewsRssItem[];
    };
  };
}

export interface GoogleNewsRssItem {
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
}

export interface NewsFeedDocument {
  rss?: {
    channel?: {
      item?: NewsFeedItem | NewsFeedItem[];
    };
  };
  feed?: {
    entry?: NewsFeedItem | NewsFeedItem[];
  };
}

export interface NewsFeedItem {
  title?: string;
  link?: string | { '@_href'?: string };
  description?: string;
  summary?: string;
  content?: string;
  pubDate?: string;
  published?: string;
  updated?: string;
  'dc:date'?: string;
  isoDate?: string;
  'media:content'?: { '@_url'?: string } | Array<{ '@_url'?: string }>;
  enclosure?: { '@_url'?: string } | Array<{ '@_url'?: string }>;
}

export interface ArticleMetadata {
  imageUrl: string | null;
  publishedAt: string | null;
}

export interface GoogleNewsDecodeParams {
  articleId: string;
  signature: string;
  timestamp: string;
}

export interface OpenAiResponsePayload {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
    }>;
  }>;
}
