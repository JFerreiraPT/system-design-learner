import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { InterviewController } from "./interview.controller.js";
import { InterviewService } from "./interview.service.js";

@Module({
  imports: [AiModule],
  controllers: [InterviewController],
  providers: [InterviewService]
})
export class InterviewModule {}
