import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ThreadsBotService } from './threads-bot.service';

@Controller('threads-bot')
export class ThreadsBotController {
  constructor(private readonly threadsBotService: ThreadsBotService) {}

  // Manual trigger endpoint for posting up to maxPosts items.
  @Post('run-once')
  async runOnce(
    @Query('maxPosts') maxPostsQuery?: string,
    @Headers('x-manual-trigger-token') triggerToken?: string,
  ): Promise<{ posted: number }> {
    const expectedToken = process.env.MANUAL_TRIGGER_TOKEN;

    if (expectedToken && triggerToken !== expectedToken) {
      throw new UnauthorizedException('Invalid manual trigger token');
    }

    const maxPosts = this.parseMaxPosts(maxPostsQuery);
    const posted = await this.threadsBotService.runOnce(maxPosts);

    return { posted };
  }

  // Parses and bounds the manual trigger maxPosts query parameter.
  private parseMaxPosts(value?: string): number {
    if (!value) {
      return 1;
    }

    const maxPosts = Number(value);

    if (!Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > 10) {
      throw new BadRequestException('maxPosts must be an integer from 1 to 10');
    }

    return maxPosts;
  }
}
