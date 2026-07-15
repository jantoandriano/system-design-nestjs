import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.use(helmet());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Lets Nest call onModuleDestroy/beforeApplicationShutdown hooks (e.g.
  // draining the RabbitMQ channel, closing DB pools) when the process
  // receives SIGTERM - the signal Docker/Kubernetes send before killing
  // a container. Without this, in-flight requests and queue acks can be
  // cut off mid-operation during a deploy or scale-down.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
