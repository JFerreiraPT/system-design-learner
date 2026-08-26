import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { InterviewController } from "./interview.controller.js";
import { InterviewService } from "./interview.service.js";

@Module({
  imports: [AiModule],
  controllers: [InterviewController],
  providers: [InterviewService],
  // Voice reuses the interview service wholesale: the same prompt inputs and
  // the same post-turn pipeline, so a spoken turn is indistinguishable from a
  // typed one to everything downstream.
  exports: [InterviewService]
})
export class InterviewModule {}
