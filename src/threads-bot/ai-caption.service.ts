import { Injectable, Logger } from '@nestjs/common';
import { CaptionNewsItem, OpenAiResponsePayload } from './dto/threads-bot.dto';

type EngagementMode = 'debate' | 'hot_take' | 'dilemma' | 'relatable_question';

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
        signal: AbortSignal.timeout(this.getOpenAiTimeoutMs()),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL ?? 'gpt-4.1-nano',
          instructions: this.buildOpenAiInstructions(item, isUpdate),
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
    item: CaptionNewsItem,
    isUpdate: boolean,
    sourceUrlLength: number = 0,
  ): string {
    // Batas keras Threads adalah 500 karakter.
    // Kita kurangi panjang URL kamu dan space amandemen (25 karakter).
    const maxAiCharacters = 500 - sourceUrlLength - 25;
    const engagementMode = this.selectEngagementMode(item);

    return [
      'Kamu adalah bot gosip hiburan yang menulis caption MICRO-BLOGGING untuk Threads.',
      'Gaya: gosip banget, rame, natural, kayak lagi spill di tongkrongan. Pakai hook yang bikin orang pengin nimbrung, boleh pakai ekspresi seperti "yall", "waduh", "serius deh", atau "ini rame banget" secukupnya.',
      'Tetap akurat: jangan memfitnah, jangan menuduh, jangan menghakimi, dan jangan menambah drama/fakta baru di luar data berita.',
      '',
      'STRATEGI ENGAGEMENT:',
      `- Mode post hari ini: ${engagementMode}.`,
      `- ${this.describeEngagementMode(engagementMode)}`,
      '- Caption harus punya sudut pandang yang jelas, bukan ringkasan datar.',
      '- Akhiri paragraf utama dengan pertanyaan yang bikin orang ingin komentar.',
      '- Pertanyaan boleh bikin audiens memilih kubu, tapi tetap aman dan tidak menyerang individu/kelompok.',
      '',
      'ATURAN EMERGENSI & SANGAT KETAT',
      `- Total seluruh teks yang kamu hasilkan HARUS DI BAWAH ${maxAiCharacters} KARAKTER!`,
      '- Jika teks yang kamu hasilkan lebih dari batas tersebut, sistem akan error. Jadi tulislah dengan SANGAT RINGKAS.',
      '- CUKUP BUAT 1 SAMPAI 2 PARAGRAF PENDEK SAJA (Maksimal 2-3 kalimat per paragraf).',
      '',
      'FORMAT OBLIGATORI:',
      isUpdate
        ? '- Baris pertama WAJIB diawali: "[UPDATE TERBARU]"'
        : '- Langsung mulai dengan hook gosip dari inti berita. JANGAN pakai kata pengantar atau judul lagi.',
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
      /(artis|seleb|selebriti|aktor|aktris|penyanyi|influencer|youtuber|tiktoker|viral|hiburan|film|sinetron|konser|musik|drama|klarifikasi|pacar|nikah|cerai|putus|selingkuh)/i.test(
        lowerHeadline,
      )
    ) {
      return [
        'Yall, ini langsung jadi bahan omongan karena nama yang kebawa lumayan menarik perhatian publik. Detail resminya masih harus ngikut sumber, tapi respons netizen biasanya cepat banget kalau urusannya dunia hiburan.',
        'Menurut lo, ini bakal melebar jadi drama panjang atau kelar setelah ada klarifikasi?',
      ].join('\n\n');
    }

    if (
      /(ekonomi|investasi|bisnis|pasar|industri|perbankan|umkm)/i.test(
        lowerHeadline,
      )
    ) {
      return [
        'Kabar ini menarik karena Jakarta masih sering menjadi barometer utama aktivitas ekonomi nasional. Pergerakan bisnis, kebijakan, dan konsumsi di ibu kota biasanya ikut memengaruhi sentimen pelaku usaha di daerah lain.',
        'Menurut lo, efeknya bakal terasa beneran ke masyarakat atau cuma ramai di level headline?',
      ].join('\n\n');
    }

    if (
      /(teknologi|digital|ai|startup|internet|data|siber)/i.test(lowerHeadline)
    ) {
      return [
        'Isu teknologi seperti ini penting dipantau karena dampaknya biasanya tidak berhenti di satu sektor saja. Perubahan di layanan digital, infrastruktur, atau regulasi teknologi bisa berpengaruh ke cara masyarakat bekerja, bertransaksi, dan mengakses layanan publik.',
        'Lo lebih lihat ini sebagai peluang besar atau justru risiko baru buat pengguna?',
      ].join('\n\n');
    }

    if (
      /(bencana|banjir|cuaca|hujan|kebakaran|gempa|mitigasi)/i.test(
        lowerHeadline,
      )
    ) {
      return [
        'Topik ini perlu jadi perhatian karena urusan bencana dan mitigasi selalu berkaitan langsung dengan keselamatan warga. Di wilayah padat seperti Jakarta dan sekitarnya, respons cepat, informasi yang jelas, dan kesiapan fasilitas publik bisa menentukan seberapa besar dampak yang dirasakan masyarakat.',
        'Menurut lo, yang paling krusial sekarang respons cepat atau pencegahan jangka panjang?',
      ].join('\n\n');
    }

    return [
      'Yall, kabar ini lumayan rame karena bisa jadi bahan obrolan publik dari beberapa sisi. Detailnya tetap perlu ngikut sumber resmi, tapi momentumnya cukup menarik buat dipantau.',
      'Menurut lo, ini bakal lanjut jadi pembahasan serius atau cuma lewat sebentar di timeline?',
    ].join('\n\n');
  }

  // Picks a caption angle that nudges comments without making every post feel identical.
  private selectEngagementMode(item: CaptionNewsItem): EngagementMode {
    const text = `${item.title} ${item.description}`.toLowerCase();

    if (
      /(pacar|nikah|cerai|putus|selingkuh|asmara|relationship|klarifikasi)/i.test(
        text,
      )
    ) {
      return 'debate';
    }

    if (/(viral|drama|kontroversi|ramai|netizen|heboh)/i.test(text)) {
      return 'hot_take';
    }

    if (
      /(ekonomi|bisnis|teknologi|digital|ai|aturan|kebijakan|jakarta)/i.test(
        text,
      )
    ) {
      return 'dilemma';
    }

    return 'relatable_question';
  }

  private describeEngagementMode(mode: EngagementMode): string {
    const descriptions: Record<EngagementMode, string> = {
      debate:
        'Buat audiens merasa harus memilih kubu, misalnya setuju vs tidak setuju atau Tim A vs Tim B.',
      hot_take:
        'Ambil opini tajam yang masih aman, lalu undang pembaca membantah atau menambahkan angle lain.',
      dilemma:
        'Tampilkan dua sisi yang sama-sama masuk akal, tanpa memberi jawaban final.',
      relatable_question:
        'Tarik topik ke pengalaman sehari-hari audiens dan tutup dengan pertanyaan personal yang gampang dijawab.',
    };

    return descriptions[mode];
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
    const hashtags = ['#GosipTerkini'];

    if (
      /(artis|seleb|selebriti|aktor|aktris|penyanyi|influencer|youtuber|tiktoker|hiburan)/i.test(
        text,
      )
    ) {
      hashtags.push('#DuniaHiburan');
    } else if (/(viral|netizen|klarifikasi|drama)/i.test(text)) {
      hashtags.push('#LagiRame');
    } else if (/(film|sinetron|series|konser|musik|lagu)/i.test(text)) {
      hashtags.push('#Entertainment');
    } else if (/(pacar|nikah|cerai|putus|asmara|relationship)/i.test(text)) {
      hashtags.push('#GosipArtis');
    } else if (/(jakarta|dki|jabodetabek)/i.test(text)) {
      hashtags.push('#Jakarta');
    } else {
      hashtags.push('#SpillBerita');
    }

    if (hashtags.length < 3) {
      hashtags.push('#TurtleSpill');
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

  private getOpenAiTimeoutMs(): number {
    const configuredTimeout = Number(process.env.OPENAI_TIMEOUT_MS ?? 20_000);

    if (!Number.isInteger(configuredTimeout) || configuredTimeout < 1_000) {
      return 20_000;
    }

    return Math.min(configuredTimeout, 60_000);
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
