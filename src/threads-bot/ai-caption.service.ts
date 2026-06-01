import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';

export interface CaptionNewsItem {
  title: string;
  description: string;
  sourceUrl: string;
}

@Injectable()
export class AiCaptionService {
  private readonly logger = new Logger(AiCaptionService.name);

  async generateCaption(
    item: CaptionNewsItem,
    isUpdate: boolean,
  ): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      this.logger.log('GEMINI_API_KEY is not configured; using fallback caption');
      return this.buildFallbackCaption(item, isUpdate);
    }

    let text: string | undefined;

    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
        contents: this.buildPrompt(item, isUpdate),
      });

      text = response.text?.trim();
    } catch (error) {
      this.logger.error('Gemini caption generation failed; using fallback caption', error);
      return this.buildFallbackCaption(item, isUpdate);
    }

    if (!text) {
      this.logger.log('Gemini returned an empty caption; using fallback caption');
      return this.buildFallbackCaption(item, isUpdate);
    }

    return this.normalizeCaption(text, item.sourceUrl, isUpdate);
  }

  private buildPrompt(item: CaptionNewsItem, isUpdate: boolean): string {
    return [
      'Buat caption Threads bahasa Indonesia dari berita berikut.',
      'Gaya akun: info terkini, singkat, natural, netral, tidak clickbait.',
      'Maksimal 500 karakter.',
      'Jangan menambahkan fakta baru di luar title dan description.',
      'Jangan gunakan hashtag berlebihan. Maksimal 2 hashtag jika relevan.',
      'Jangan tulis label "Source:" kecuali diminta sistem.',
      isUpdate
        ? 'Ini adalah update berita. Awali caption dengan "[UPDATE TERBARU]".'
        : 'Ini adalah berita baru. Jangan awali dengan label update.',
      '',
      `Title: ${item.title}`,
      `Description: ${item.description}`,
      `Source URL: ${item.sourceUrl}`,
    ].join('\n');
  }

  private normalizeCaption(
    caption: string,
    sourceUrl: string,
    isUpdate: boolean,
  ): string {
    const updatePrefix = '[UPDATE TERBARU]';
    const withUpdatePrefix =
      isUpdate && !caption.startsWith(updatePrefix)
        ? `${updatePrefix} ${caption}`
        : caption;

    const withSource = withUpdatePrefix.includes(sourceUrl)
      ? withUpdatePrefix
      : `${withUpdatePrefix}\n\nSumber: ${sourceUrl}`;

    return withSource.slice(0, 1_000);
  }

  private buildFallbackCaption(
    item: CaptionNewsItem,
    isUpdate: boolean,
  ): string {
    const prefix = isUpdate ? '[UPDATE TERBARU] ' : '';

    return `${prefix}${item.title}\n\n${item.description}\n\nSumber: ${item.sourceUrl}`;
  }
}
