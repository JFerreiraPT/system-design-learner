import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { SolutionsController } from "./solutions.controller.js";
import { SolutionsService } from "./solutions.service.js";

@Module({
  imports: [AiModule],
  controllers: [SolutionsController],
  providers: [SolutionsService]
})
export class SolutionsModule {}
