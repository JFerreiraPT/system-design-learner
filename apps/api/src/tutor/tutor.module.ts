import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { TutorController } from "./tutor.controller.js";
import { TutorService } from "./tutor.service.js";

@Module({
  imports: [AiModule],
  controllers: [TutorController],
  providers: [TutorService]
})
export class TutorModule {}
