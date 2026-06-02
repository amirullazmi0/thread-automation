import { AiCaptionService } from './ai-caption.service';
import { CaptionNewsItem } from './dto/threads-bot.dto';

describe('AiCaptionService', () => {
  let service: AiCaptionService;

  beforeEach(() => {
    service = new AiCaptionService();
  });

  it('adds engagement mode guidance to OpenAI instructions', () => {
    const item: CaptionNewsItem = {
      title: 'Artis A klarifikasi isu putus yang viral',
      description:
        'Netizen ramai membahas hubungan Artis A setelah unggahan baru.',
      sourceUrl: 'https://example.com/news',
    };

    const instructions = service['buildOpenAiInstructions'](item, false);

    expect(instructions).toContain('STRATEGI ENGAGEMENT');
    expect(instructions).toContain('Mode post hari ini: debate');
    expect(instructions).toContain('Akhiri paragraf utama dengan pertanyaan');
  });

  it('keeps fallback captions comment-oriented when OpenAI is unavailable', () => {
    const item: CaptionNewsItem = {
      title: 'Kabar seleb viral jadi bahan obrolan netizen',
      description: '',
      sourceUrl: 'https://example.com/source',
    };

    const caption = service['buildFallbackCaption'](item, false);

    expect(caption).toContain('Menurut lo');
    expect(caption).toContain('Sumber: https://example.com/source');
    expect(caption).toContain('#GosipTerkini');
  });
});
