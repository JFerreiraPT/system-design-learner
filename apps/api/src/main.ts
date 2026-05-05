import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { ZodValidationPipe } from "./common/zod-validation.pipe.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.useGlobalPipes(new ZodValidationPipe());
  await app.listen(3001);
}

bootstrap();
