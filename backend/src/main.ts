import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { trustProxy } from './main.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxy(process.env.TRUST_PROXY));
  const appOrigin = process.env.APP_ORIGIN ?? process.env.FRONTEND_ORIGIN ?? 'http://localhost:11200';
  if (!appOrigin.startsWith('https://')) app.enableCors({ origin: appOrigin });
  await app.listen(Number(process.env.PORT) || 3000, '0.0.0.0');
}

void bootstrap();
