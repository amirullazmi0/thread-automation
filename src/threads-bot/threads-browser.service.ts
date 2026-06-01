import { Injectable, Logger } from '@nestjs/common';
import { chromium, Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

@Injectable()
export class ThreadsBrowserService {
  private readonly logger = new Logger(ThreadsBrowserService.name);
  private readonly sessionPath =
    process.env.THREADS_SESSION_PATH ??
    path.join(process.cwd(), 'threads-session.json');

  async postToThreads(caption: string): Promise<void> {
    const browser = await chromium.launch({
      headless: this.isHeadless(),
    });

    try {
      const context = await browser.newContext(
        fs.existsSync(this.sessionPath)
          ? { storageState: this.sessionPath }
          : undefined,
      );

      if (fs.existsSync(this.sessionPath)) {
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

      await this.submitPost(page, caption);
      this.logger.log('Post successful');
    } catch (error) {
      this.logger.error('Failed to post to Threads', error);
      throw error;
    } finally {
      await browser.close();
    }
  }

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

  private async login(page: Page): Promise<void> {
    const email = process.env.THREADS_EMAIL;
    const password = process.env.THREADS_PASSWORD;
    const headless = this.isHeadless();

    if (this.isManualLogin()) {
      if (headless) {
        throw new Error('THREADS_MANUAL_LOGIN requires THREADS_HEADLESS=false');
      }

      this.logger.log('Complete Threads login manually in the opened browser');
      await this.waitForManualLogin(page);
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

  private async submitPost(page: Page, caption: string): Promise<void> {
    const composer = page
      .locator(
        'textarea, [contenteditable="true"], div[role="textbox"], [aria-label*="post" i]',
      )
      .first();

    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    await this.humanoidType(composer, caption);

    await page
      .getByRole('button', { name: /^post$/i })
      .or(page.getByText(/^post$/i))
      .first()
      .click();

    await page.waitForLoadState('networkidle', { timeout: 60_000 });
  }

  private async humanoidType(
    locator: ReturnType<Page['locator']>,
    text: string,
  ): Promise<void> {
    await locator.click();
    await locator.type(text, {
      delay: this.randomDelay(35, 115),
    });
  }

  private randomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private isHeadless(): boolean {
    return process.env.THREADS_HEADLESS !== 'false';
  }

  private isManualLogin(): boolean {
    return process.env.THREADS_MANUAL_LOGIN === 'true';
  }

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
