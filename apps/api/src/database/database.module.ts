import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new PrismaService(config.getOrThrow<string>('DATABASE_URL')),
    },
  ],
  exports: [PrismaService],
})
export class DatabaseModule {}
