import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  // Helps you see, in the docker-compose logs, which instance handled startup
  // (and later, in responses, which instance handled a given request).
  console.log(
    `[${process.env.INSTANCE_NAME ?? 'app'}] listening on port ${port}`,
  );
}

bootstrap();
