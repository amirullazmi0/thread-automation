import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ThreadsBotModule } from './threads-bot/threads-bot.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ThreadsBotModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
