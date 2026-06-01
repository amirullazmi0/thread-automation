import { Injectable, Logger } from '@nestjs/common';
import { Browser, BrowserContext, chromium, Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

@Injectable()
export class ThreadsBrowserService {
  private readonly logger = new Logger(ThreadsBrowserService.name);
  private readonly sessionPath =
    process.env.THREADS_SESSION_PATH ??
    path.join(process.cwd(), 'threads-session.json');

  // Opens Threads, ensures login, fills the composer, and submits the post.
  async postToThreads(
    caption: string,
    imagePath?: string | null,
  ): Promise<void> {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      const browserSession = await this.createBrowserSession();
      browser = browserSession.browser;
      context = browserSession.context;

      if (browserSession.loadedStorageState) {
        this.logger.log('Session loaded');
      }

      const page = await context.newPage();
      await page.goto('https://www.threads.com/intent/post', {
        waitUntil: 'domcontentloaded',
      });

      if (await this.isLoginRequired(page)) {
        this.logger.log('Threads login required');
        await this.login(page);
        await context.storageState({ path: this.sessionPath });
        this.logger.log('Session saved');

        await page.goto('https://www.threads.com/intent/post', {
          waitUntil: 'domcontentloaded',
        });
      }

      await this.submitPost(page, caption, imagePath);
      this.logger.log('Post successful');
    } catch (error) {
      this.logger.error('Failed to post to Threads', error);
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      } else {
        await context?.close();
      }
    }
  }

  // Creates a Playwright browser context using persistent Edge/Chrome profile when configured.
  private async createBrowserSession(): Promise<{
    browser: Browser | null;
    context: BrowserContext;
    loadedStorageState: boolean;
  }> {
    const userDataDir = process.env.THREADS_USER_DATA_DIR;

    if (userDataDir) {
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: this.isHeadless(),
        channel: this.getBrowserChannel(),
      });

      return {
        browser: null,
        context,
        loadedStorageState: false,
      };
    }

    const browser = await chromium.launch({
      headless: this.isHeadless(),
      channel: this.getBrowserChannel(),
    });
    const loadedStorageState = fs.existsSync(this.sessionPath);
    const context = await browser.newContext(
      loadedStorageState ? { storageState: this.sessionPath } : undefined,
    );

    return {
      browser,
      context,
      loadedStorageState,
    };
  }

  // Detects whether Threads redirected to login or is showing login fields.
  private async isLoginRequired(page: Page): Promise<boolean> {
    const currentUrl = page.url();

    if (currentUrl.includes('/login')) {
      return true;
    }

    const loginField = page
      .locator(
        'input[name="username"], input[name="email"], input[type="email"], input[type="password"]',
      )
      .first();

    return loginField.isVisible({ timeout: 5_000 }).catch(() => false);
  }

  // Runs the configured Threads login flow or waits for manual login.
  private async login(page: Page): Promise<void> {
    const email = process.env.THREADS_EMAIL;
    const password = process.env.THREADS_PASSWORD;
    const headless = this.isHeadless();
    const loginProvider = this.getLoginProvider();

    if (this.isManualLogin()) {
      if (headless) {
        throw new Error('THREADS_MANUAL_LOGIN requires THREADS_HEADLESS=false');
      }

      this.logger.log('Complete Threads login manually in the opened browser');
      await this.waitForManualLogin(page);
      return;
    }

    if (loginProvider === 'instagram') {
      await this.loginWithInstagram(page);
      return;
    }

    if (!email || !password) {
      throw new Error(
        'THREADS_EMAIL and THREADS_PASSWORD must be configured for automated login',
      );
    }

    await page.goto('https://www.threads.com/login', {
      waitUntil: 'domcontentloaded',
    });

    const emailInput = page
      .locator(
        'input[name="username"], input[name="email"], input[type="email"], input[placeholder*="Username" i], input[placeholder*="email" i]',
      )
      .first();
    const passwordInput = page.locator('input[type="password"]').first();

    await emailInput.waitFor({ state: 'visible', timeout: 30_000 });
    await this.humanoidType(emailInput, email);
    await this.humanoidType(passwordInput, password);

    await page
      .getByRole('button', { name: /log in|login|continue|submit/i })
      .first()
      .click();

    await page.waitForLoadState('networkidle', { timeout: 60_000 });

    if (await this.isLoginRequired(page)) {
      if (headless) {
        throw new Error(
          'Threads login failed or additional verification is required',
        );
      }

      this.logger.log('Complete Threads verification in the opened browser');
      await this.waitForManualLogin(page);
    }

    if (await this.isLoginRequired(page)) {
      throw new Error('Threads login failed after manual verification');
    }
  }

  // Logs in through the Instagram button when THREADS_LOGIN_PROVIDER=instagram.
  private async loginWithInstagram(page: Page): Promise<void> {
    const username =
      process.env.THREADS_INSTAGRAM_USERNAME || process.env.THREADS_EMAIL;
    const password =
      process.env.THREADS_INSTAGRAM_PASSWORD || process.env.THREADS_PASSWORD;
    const headless = this.isHeadless();

    if (!username || !password) {
      throw new Error(
        'THREADS_INSTAGRAM_USERNAME and THREADS_INSTAGRAM_PASSWORD must be configured for Instagram login',
      );
    }

    await page.goto('https://www.threads.com/login', {
      waitUntil: 'domcontentloaded',
    });

    await page
      .getByRole('button', { name: /instagram/i })
      .or(page.getByRole('link', { name: /instagram/i }))
      .or(page.getByText(/instagram/i))
      .first()
      .click({ timeout: 30_000 });

    await page.waitForLoadState('domcontentloaded');

    const usernameInput = page
      .locator(
        'input[name="username"], input[name="email"], input[type="email"], input[autocomplete="username"], input[placeholder*="username" i], input[placeholder*="phone" i], input[placeholder*="email" i]',
      )
      .first();
    const passwordInput = page.locator('input[type="password"]').first();

    await usernameInput.waitFor({ state: 'visible', timeout: 30_000 });
    await this.humanoidType(usernameInput, username);
    await this.humanoidType(passwordInput, password);

    await page
      .getByRole('button', { name: /log in|login|continue|submit/i })
      .first()
      .click();

    await this.dismissOptionalInstagramPrompt(page);
    await page.waitForLoadState('networkidle', { timeout: 60_000 });

    if (await this.isLoginRequired(page)) {
      if (headless) {
        throw new Error(
          'Instagram login failed or additional verification is required',
        );
      }

      this.logger.log('Complete Instagram verification in the opened browser');
      await this.waitForManualLogin(page);
    }

    if (await this.isLoginRequired(page)) {
      throw new Error('Instagram login failed after manual verification');
    }
  }

  // Dismisses common Instagram post-login prompts when they appear.
  private async dismissOptionalInstagramPrompt(page: Page): Promise<void> {
    const promptButton = page
      .getByRole('button', {
        name: /not now|save info|continue|allow|ok/i,
      })
      .first();

    await promptButton.click({ timeout: 10_000 }).catch(() => undefined);
  }

  // Fills all thread parts, attaches an image if available, and clicks Post.
  private async submitPost(
    page: Page,
    caption: string,
    imagePath?: string | null,
  ): Promise<void> {
    const parts = this.splitCaptionForThreads(caption);

    await this.fillComposer(page, 0, parts[0]);

    for (let index = 1; index < parts.length; index += 1) {
      await this.addThreadPart(page, index, parts[index]);
    }

    await this.attachImageIfConfigured(page, imagePath);

    const postButton = page
      .getByRole('button', { name: /^post$/i })
      .or(page.getByText(/^post$/i))
      .first();

    await postButton.waitFor({ state: 'visible', timeout: 100_000 });

    if (await postButton.isDisabled().catch(() => false)) {
      throw new Error(
        'Threads post button is disabled; caption may exceed limit or composer is invalid',
      );
    }

    // MEMPERBAIKI TIMEOUT: Menggunakan { force: true } untuk mengabaikan interseptor / overlay dari Threads
    await postButton.click({ force: true });

    await this.waitForPostSubmission(page);
  }

  // Fills one composer textbox by index.
  private async fillComposer(
    page: Page,
    index: number,
    text: string,
  ): Promise<void> {
    const composer = page
      .locator(
        'textarea, [contenteditable="true"], div[role="textbox"], [aria-label*="post" i]',
      )
      .nth(index);

    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    await composer.click();
    await composer.fill(text).catch(async () => {
      await page.keyboard.insertText(text);
    });
  }

  // Adds and fills an additional thread reply part.
  private async addThreadPart(
    page: Page,
    index: number,
    text: string,
  ): Promise<void> {
    const addButton = page
      .getByRole('button', {
        name: /add to thread|add another|tambah|tambahkan/i,
      })
      .or(page.getByText(/add to thread|add another|tambah|tambahkan/i))
      .first();

    await addButton.click({ timeout: 30_000 });
    await this.fillComposer(page, index, text);
  }

  // Waits after submit and throws if Threads keeps the composer open or shows an error.
  private async waitForPostSubmission(page: Page): Promise<void> {
    await page.waitForTimeout(15_000);

    const errorMessage = await page
      .getByText(/couldn't post|try again|failed|gagal|coba lagi|tidak dapat/i)
      .first()
      .textContent({ timeout: 2_000 })
      .catch(() => null);

    if (errorMessage) {
      throw new Error(`Threads rejected the post: ${errorMessage}`);
    }
  }

  // Splits long captions into thread parts without exceeding Threads limits.
  private splitCaptionForThreads(caption: string): string[] {
    const maxPartLength = Number(process.env.THREADS_MAX_PART_CHARS ?? 450);
    const safeMaxPartLength =
      Number.isInteger(maxPartLength) && maxPartLength >= 120
        ? Math.min(maxPartLength, 480)
        : 450;
    const paragraphs = caption
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    const hashtagComment = this.extractTrailingHashtagComment(paragraphs);
    const parts: string[] = [];
    let currentPart = '';

    for (const paragraph of paragraphs) {
      if (!currentPart) {
        currentPart = paragraph;
        continue;
      }

      const nextPart = `${currentPart}\n\n${paragraph}`;

      if (nextPart.length <= safeMaxPartLength) {
        currentPart = nextPart;
        continue;
      }

      parts.push(currentPart);
      currentPart = paragraph;
    }

    if (currentPart) {
      parts.push(currentPart);
    }

    const splitParts = parts.flatMap((part) =>
      this.splitLongPart(part, safeMaxPartLength),
    );

    return hashtagComment ? [...splitParts, hashtagComment] : splitParts;
  }

  // Pulls a hashtag-only tail paragraph so it becomes its own Threads reply.
  private extractTrailingHashtagComment(paragraphs: string[]): string | null {
    const lastParagraph = paragraphs.at(-1);

    if (!lastParagraph || !this.isHashtagOnlyParagraph(lastParagraph)) {
      return null;
    }

    paragraphs.pop();
    return lastParagraph;
  }

  // Detects paragraphs that only contain two or three hashtags.
  private isHashtagOnlyParagraph(paragraph: string): boolean {
    const tokens = paragraph.split(/\s+/).filter(Boolean);

    return (
      tokens.length >= 2 &&
      tokens.length <= 3 &&
      tokens.every((token) => /^#[\p{L}\p{N}_]+$/u.test(token))
    );
  }

  // Splits a single long paragraph into safe-sized chunks.
  private splitLongPart(part: string, maxLength: number): string[] {
    if (part.length <= maxLength) {
      return [part];
    }

    const chunks: string[] = [];
    let remainingText = part;

    while (remainingText.length > maxLength) {
      const splitAt = Math.max(
        remainingText.lastIndexOf('. ', maxLength),
        remainingText.lastIndexOf(' ', maxLength),
      );
      const chunkEnd = splitAt > 120 ? splitAt + 1 : maxLength;
      chunks.push(remainingText.slice(0, chunkEnd).trim());
      remainingText = remainingText.slice(chunkEnd).trim();
    }

    if (remainingText) {
      chunks.push(remainingText);
    }

    return chunks;
  }

  // Attaches either the article image or a configured static image.
  private async attachImageIfConfigured(
    page: Page,
    postImagePath?: string | null,
  ): Promise<void> {
    const imagePath = postImagePath ?? this.getImagePath();

    if (!imagePath) {
      return;
    }

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(imagePath, { timeout: 30_000 });
    this.logger.log(`Attached image: ${imagePath}`);
  }

  // Resolves THREADS_IMAGE_PATH when a static image is configured.
  private getImagePath(): string | null {
    const configuredPath = process.env.THREADS_IMAGE_PATH?.trim();

    if (!configuredPath) {
      return null;
    }

    const imagePath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.join(process.cwd(), configuredPath);

    if (!fs.existsSync(imagePath)) {
      throw new Error(`THREADS_IMAGE_PATH does not exist: ${imagePath}`);
    }

    return imagePath;
  }

  // Types login credentials with small random delays.
  private async humanoidType(
    locator: ReturnType<Page['locator']>,
    text: string,
  ): Promise<void> {
    await locator.click();
    await locator.type(text, {
      delay: this.randomDelay(35, 115),
    });
  }

  // Returns a random delay for human-like typing.
  private randomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // Reads whether Playwright should run headless.
  private isHeadless(): boolean {
    return process.env.THREADS_HEADLESS !== 'false';
  }

  // Reads the requested Playwright browser channel.
  private getBrowserChannel(): 'chrome' | 'msedge' | undefined {
    const channel = process.env.THREADS_BROWSER_CHANNEL;

    if (channel === 'chrome' || channel === 'msedge') {
      return channel;
    }

    return undefined;
  }

  // Reads whether login should be completed manually in the visible browser.
  private isManualLogin(): boolean {
    return process.env.THREADS_MANUAL_LOGIN === 'true';
  }

  // Reads whether login should use direct Threads login or Instagram.
  private getLoginProvider(): 'threads' | 'instagram' {
    return process.env.THREADS_LOGIN_PROVIDER === 'instagram'
      ? 'instagram'
      : 'threads';
  }

  // Waits until the manual login flow leaves the login page.
  private async waitForManualLogin(page: Page): Promise<void> {
    await page.waitForURL(
      (url) =>
        url.hostname.endsWith('threads.com') &&
        !url.pathname.includes('/login'),
      { timeout: 600_000 },
    );
    await page.waitForLoadState('domcontentloaded');
  }
}
