import { Injectable, Logger } from '@nestjs/common';
import { CaptionNewsItem, OpenAiResponsePayload } from './dto/threads-bot.dto';

@Injectable()
export class AiCaptionService {
  private readonly logger = new Logger(AiCaptionService.name);
  private openAiCaptionCount = 0;
  private openAiCaptionCountDate = this.getTodayKey();

  // Generates a Threads caption using OpenAI, with local fallback on failure.
  async generateCaption(
    item: CaptionNewsItem,
    isUpdate: boolean,
  ): Promise<string> {
    return this.generateOpenAiCaption(item, isUpdate);
  }

  // Calls OpenAI Responses API and normalizes the generated caption.
  private async generateOpenAiCaption(
    item: CaptionNewsItem,
    isUpdate: boolean,
  ): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      this.logger.log(
        'OPENAI_API_KEY is not configured; using fallback caption',
      );
      return this.buildFallbackCaption(item, isUpdate);
    }

    if (!this.canUseOpenAiCaption()) {
      this.logger.log(
        'OpenAI daily caption limit reached; using fallback caption',
      );
      return this.buildFallbackCaption(item, isUpdate);
    }

    let text: string | undefined;

    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL ?? 'gpt-4.1-nano',
          instructions: this.buildOpenAiInstructions(isUpdate),
          input: this.buildOpenAiInput(item),
          max_output_tokens: this.getOpenAiMaxOutputTokens(),
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI caption request failed: ${response.status}`);
      }

      const payload = (await response.json()) as OpenAiResponsePayload;
      text = this.extractOpenAiText(payload);
      this.markOpenAiCaptionUsed();
    } catch (error) {
      this.logger.error(
        'OpenAI caption generation failed; using fallback caption',
        error,
      );
      return this.buildFallbackCaption(item, isUpdate);
    }

    if (!text) {
      this.logger.log(
        'OpenAI returned an empty caption; using fallback caption',
      );
      return this.buildFallbackCaption(item, isUpdate);
    }

    return this.normalizeCaption(text, item, isUpdate);
  }

  // Builds the system instructions for the OpenAI caption request.
  private buildOpenAiInstructions(
    isUpdate: boolean,
    sourceUrlLength: number = 0,
  ): string {
    // Batas keras Threads adalah 500 karakter.
    // Kita kurangi panjang URL kamu dan space amandemen (25 karakter).
    const maxAiCharacters = 500 - sourceUrlLength - 25;

    return [
      'Kamu adalah bot otomatis yang menulis ringkasan berita MICRO-BLOGGING untuk Threads.',
      'Gaya: Sangat ringkas, padat informasi, natural, langsung ke inti berita (no basa-basi/no clickbait).',
      '',
      '⚠️ ATURAN EMERGENSI & SANGAT KETAT ⚠️',
      `- Total seluruh teks yang kamu hasilkan HARUS DI BAWAH ${maxAiCharacters} KARAKTER!`,
      '- Jika teks yang kamu hasilkan lebih dari batas tersebut, sistem akan error. Jadi tulislah dengan SANGAT RINGKAS.',
      '- CUKUP BUAT 1 SAMPAI 2 PARAGRAF PENDEK SAJA (Maksimal 2-3 kalimat per paragraf).',
      '',
      'FORMAT OBLIGATORI:',
      isUpdate
        ? '- Baris pertama WAJIB diawali: "[UPDATE TERBARU]"'
        : '- Langsung mulai dengan inti berita. JANGAN pakai kata pengantar atau judul lagi.',
      '- JANGAN pernah menulis URL atau link web apa pun di dalam teks!',
      '- Taruh 2 hashtag saja di baris paling akhir (pisahkan dengan enter dari paragraf utama).',
      '',
      'Jangan pernah menambah asumsi atau fakta baru di luar data title & description berita yang diberikan.',
    ].join('\n');
  }

  // Builds compact source context for the caption model.
  private buildOpenAiInput(item: CaptionNewsItem): string {
    return [
      `Title: ${item.title}`,
      `Description: ${item.description}`,
      `Source URL: ${item.sourceUrl}`,
    ].join('\n');
  }

  // Reads text from the supported OpenAI response payload shapes.
  private extractOpenAiText(
    payload: OpenAiResponsePayload,
  ): string | undefined {
    if (payload.output_text?.trim()) {
      return payload.output_text.trim();
    }

    return payload.output
      ?.flatMap((outputItem) => outputItem.content ?? [])
      .map((contentItem) => contentItem.text)
      .find((value): value is string => Boolean(value?.trim()))
      ?.trim();
  }

  // Adds update label when needed and appends the source URL.
  private normalizeCaption(
    caption: string,
    item: CaptionNewsItem,
    isUpdate: boolean,
  ): string {
    const updatePrefix = '[UPDATE TERBARU]';
    const withUpdatePrefix =
      isUpdate && !caption.startsWith(updatePrefix)
        ? `${updatePrefix} ${caption}`
        : caption;

    return this.normalizeHashtagComment(
      this.truncateCaptionWithSource(withUpdatePrefix, item.sourceUrl),
      item,
    );
  }

  // Creates a local caption when OpenAI is unavailable or over limit.
  private buildFallbackCaption(
    item: CaptionNewsItem,
    isUpdate: boolean,
  ): string {
    const prefix = isUpdate ? '[UPDATE TERBARU] ' : '';
    const { headline } = this.cleanHeadline(item.title);
    const description = this.cleanDescription(item.description, headline);

    const context = this.buildFallbackContext(headline);
    const detailBlock = description ? `${description}\n\n${context}` : context;

    return this.normalizeHashtagComment(
      this.truncateCaptionWithSource(
        `${prefix}${headline}\n\n${detailBlock}`,
        item.sourceUrl,
      ),
      item,
    );
  }

  // Selects fallback context based on the headline topic.
  private buildFallbackContext(headline: string): string {
    const lowerHeadline = headline.toLowerCase();

    if (
      /(ekonomi|investasi|bisnis|pasar|industri|perbankan|umkm)/i.test(
        lowerHeadline,
      )
    ) {
      return [
        'Kabar ini menarik karena Jakarta masih sering menjadi barometer utama aktivitas ekonomi nasional. Pergerakan bisnis, kebijakan, dan konsumsi di ibu kota biasanya ikut memengaruhi sentimen pelaku usaha di daerah lain.',
        'Yang perlu dilihat berikutnya adalah apakah perkembangan ini berdampak langsung ke lapangan: arus investasi, pembukaan kerja sama baru, daya beli masyarakat, atau respons sektor usaha. Kalau momentumnya kuat, efeknya bisa terasa bukan cuma di Jakarta, tapi juga ke rantai ekonomi nasional.',
      ].join('\n\n');
    }

    if (
      /(teknologi|digital|ai|startup|internet|data|siber)/i.test(lowerHeadline)
    ) {
      return [
        'Isu teknologi seperti ini penting dipantau karena dampaknya biasanya tidak berhenti di satu sektor saja. Perubahan di layanan digital, infrastruktur, atau regulasi teknologi bisa berpengaruh ke cara masyarakat bekerja, bertransaksi, dan mengakses layanan publik.',
        'Fokus berikutnya ada pada implementasinya: apakah manfaatnya bisa dirasakan pengguna, apakah pelaku usaha siap beradaptasi, dan apakah ada perlindungan yang cukup untuk data serta keamanan masyarakat.',
      ].join('\n\n');
    }

    if (
      /(bencana|banjir|cuaca|hujan|kebakaran|gempa|mitigasi)/i.test(
        lowerHeadline,
      )
    ) {
      return [
        'Topik ini perlu jadi perhatian karena urusan bencana dan mitigasi selalu berkaitan langsung dengan keselamatan warga. Di wilayah padat seperti Jakarta dan sekitarnya, respons cepat, informasi yang jelas, dan kesiapan fasilitas publik bisa menentukan seberapa besar dampak yang dirasakan masyarakat.',
        'Hal yang penting dipantau setelah ini adalah koordinasi antarinstansi, kondisi warga terdampak, serta langkah pencegahan agar kejadian serupa tidak berulang dengan skala yang lebih besar.',
      ].join('\n\n');
    }

    return [
      'Kabar ini layak dipantau karena menyentuh isu publik yang bisa berkembang dalam beberapa arah, mulai dari respons pemerintah, dampak ke masyarakat, sampai tindak lanjut dari pihak terkait.',
      'Untuk pembaca di Jakarta dan wilayah urban lain, isu seperti ini biasanya penting bukan hanya karena peristiwanya, tapi juga karena efek lanjutannya: kebijakan yang berubah, layanan publik yang ikut terdampak, atau munculnya respons dari pelaku usaha dan warga.',
      'Perkembangan berikutnya akan menentukan apakah kabar ini berhenti sebagai informasi singkat atau menjadi isu yang lebih besar dalam beberapa hari ke depan.',
    ].join('\n\n');
  }

  // Removes the source suffix from Google News style titles.
  private cleanHeadline(title: string): {
    headline: string;
    sourceName: string | null;
  } {
    const normalizedTitle = this.normalizeWhitespace(title);
    const sourceMatch = normalizedTitle.match(/\s+-\s+(.+)$/);
    const sourceName = sourceMatch?.[1]?.trim() || null;
    const headline = sourceName
      ? normalizedTitle.slice(0, sourceMatch?.index ?? 0).trim()
      : normalizedTitle;

    return {
      headline,
      sourceName,
    };
  }

  // Removes repeated title text from the RSS description.
  private cleanDescription(description: string, headline: string): string {
    const normalizedDescription = this.normalizeWhitespace(description);

    if (!normalizedDescription || normalizedDescription === headline) {
      return '';
    }

    if (
      normalizedDescription.toLowerCase().includes(headline.toLowerCase()) ||
      headline.toLowerCase().includes(normalizedDescription.toLowerCase())
    ) {
      return '';
    }

    return normalizedDescription;
  }

  // Collapses whitespace so caption text stays clean.
  private normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  // Trims caption text to the configured max length.
  private truncateCaption(caption: string): string {
    const maxLength = this.getMaxCaptionLength();

    if (caption.length <= maxLength) {
      return caption;
    }

    return `${caption.slice(0, maxLength - 3).trimEnd()}...`;
  }

  // Trims caption body while preserving the full source URL line.
  private truncateCaptionWithSource(
    caption: string,
    sourceUrl: string,
  ): string {
    const sourceLine = `\n\nSumber: ${sourceUrl}`;
    const maxLength = this.getMaxCaptionLength();

    if ((caption + sourceLine).length <= maxLength) {
      return `${caption}${sourceLine}`;
    }

    const bodyMaxLength = Math.max(80, maxLength - sourceLine.length - 3);
    return `${caption.slice(0, bodyMaxLength).trimEnd()}...${sourceLine}`;
  }

  // Ensures the final paragraph is a hashtag-only thread comment.
  private normalizeHashtagComment(
    caption: string,
    item: CaptionNewsItem,
  ): string {
    const paragraphs = caption
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    const existingHashtagParagraph = paragraphs.findLast((paragraph) =>
      this.isHashtagOnlyParagraph(paragraph),
    );
    const captionWithoutHashtags = paragraphs
      .filter((paragraph) => !this.isHashtagOnlyParagraph(paragraph))
      .join('\n\n');
    const hashtagComment =
      existingHashtagParagraph ?? this.buildHashtags(item).join(' ');

    return `${captionWithoutHashtags}\n\n${hashtagComment}`;
  }

  // Builds two or three local fallback hashtags from the news topic.
  private buildHashtags(item: CaptionNewsItem): string[] {
    const text = `${item.title} ${item.description}`.toLowerCase();
    const hashtags = ['#BeritaIndonesia'];

    if (/(jakarta|dki|jabodetabek)/i.test(text)) {
      hashtags.push('#Jakarta');
    }

    if (/(ekonomi|bisnis|investasi|ritel|umkm|pasar)/i.test(text)) {
      hashtags.push('#Ekonomi');
    } else if (/(teknologi|digital|ai|startup|internet|siber)/i.test(text)) {
      hashtags.push('#Teknologi');
    } else if (/(bencana|banjir|cuaca|gempa|kebakaran|mitigasi)/i.test(text)) {
      hashtags.push('#InfoPublik');
    } else {
      hashtags.push('#KabarTerkini');
    }

    if (hashtags.length < 3) {
      hashtags.push('#TurtleUpdate');
    }

    return hashtags.slice(0, 3);
  }

  // Detects whether a paragraph only contains two or three hashtags.
  private isHashtagOnlyParagraph(paragraph: string): boolean {
    const tokens = paragraph.split(/\s+/).filter(Boolean);

    return (
      tokens.length >= 2 &&
      tokens.length <= 3 &&
      tokens.every((token) => /^#[\p{L}\p{N}_]+$/u.test(token))
    );
  }

  // Reads the maximum caption length from env with a safe upper bound.
  private getMaxCaptionLength(): number {
    const configuredLength = Number(
      process.env.THREADS_MAX_CAPTION_CHARS ?? 480,
    );

    if (!Number.isInteger(configuredLength) || configuredLength < 80) {
      return 480;
    }

    return Math.min(configuredLength, 900);
  }

  // Reads the OpenAI output token cap from env.
  private getOpenAiMaxOutputTokens(): number {
    const configuredTokens = Number(
      process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 320,
    );

    if (!Number.isInteger(configuredTokens) || configuredTokens < 80) {
      return 320;
    }

    return Math.min(configuredTokens, 500);
  }

  // Checks the in-memory daily OpenAI caption budget.
  private canUseOpenAiCaption(): boolean {
    this.resetOpenAiCounterIfNeeded();
    return this.openAiCaptionCount < this.getOpenAiDailyCaptionLimit();
  }

  // Increments the in-memory OpenAI caption counter.
  private markOpenAiCaptionUsed(): void {
    this.resetOpenAiCounterIfNeeded();
    this.openAiCaptionCount += 1;
  }

  // Resets the daily OpenAI counter when the date changes.
  private resetOpenAiCounterIfNeeded(): void {
    const todayKey = this.getTodayKey();

    if (todayKey !== this.openAiCaptionCountDate) {
      this.openAiCaptionCountDate = todayKey;
      this.openAiCaptionCount = 0;
    }
  }

  // Reads the daily OpenAI request cap from env.
  private getOpenAiDailyCaptionLimit(): number {
    const configuredLimit = Number(
      process.env.OPENAI_DAILY_CAPTION_LIMIT ?? 30,
    );

    if (!Number.isInteger(configuredLimit) || configuredLimit < 0) {
      return 30;
    }

    return Math.min(configuredLimit, 200);
  }

  // Returns the current UTC date key for the daily budget counter.
  private getTodayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
