import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  await app.listen(3000);
  // eslint-disable-next-line no-console
  console.log('agent-demo listening on http://localhost:3000 (POST /agent/chat)');
}

void bootstrap();
