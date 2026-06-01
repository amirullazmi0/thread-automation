import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { AiCaptionService } from './ai-caption.service';
import { ThreadsBotController } from './threads-bot.controller';
import { ThreadsBotService } from './threads-bot.service';
import { ThreadsBrowserService } from './threads-browser.service';

@Module({
  imports: [ScheduleModule.forRoot(), HttpModule, PrismaModule],
  controllers: [ThreadsBotController],
  providers: [ThreadsBotService, ThreadsBrowserService, AiCaptionService],
  exports: [ThreadsBotService],
})
export class ThreadsBotModule {}
