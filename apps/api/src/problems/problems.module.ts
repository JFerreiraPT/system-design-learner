import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { ProblemsController } from "./problems.controller.js";
import { ProblemsService } from "./problems.service.js";

@Module({
  imports: [AiModule],
  controllers: [ProblemsController],
  providers: [ProblemsService],
  exports: [ProblemsService]
})
export class ProblemsModule {}
