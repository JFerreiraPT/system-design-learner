import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { InterviewModule } from "../interview/interview.module.js";
import { VoiceController } from "./voice.controller.js";
import { VoiceService } from "./voice.service.js";

@Module({
  imports: [AiModule, InterviewModule],
  controllers: [VoiceController],
  providers: [VoiceService]
})
export class VoiceModule {}
