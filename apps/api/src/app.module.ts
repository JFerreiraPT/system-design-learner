import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DbModule } from "./db/db.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { AiModule } from "./ai/ai.module.js";
import { ProblemsModule } from "./problems/problems.module.js";
import { SolutionsModule } from "./solutions/solutions.module.js";
import { InterviewModule } from "./interview/interview.module.js";
import { TutorModule } from "./tutor/tutor.module.js";
import { AppController } from "./app.controller.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: join(repoRoot, ".env")
    }),
    DbModule,
    RedisModule,
    AiModule,
    ProblemsModule,
    SolutionsModule,
    InterviewModule,
    TutorModule
  ],
  controllers: [AppController]
})
export class AppModule {}
