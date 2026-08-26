import { Body, Controller, Get, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { openSseStream, pumpTextStream } from "../common/sse.js";
import { StartTutorSessionDto, TutorMessageDto } from "./tutor.dto.js";
import { TutorService } from "./tutor.service.js";

@Controller("tutor")
export class TutorController {
  constructor(@Inject(TutorService) private readonly tutorService: TutorService) {}

  /** `interviewId` in the body links this session to a live interview so tutor
   * usage shows up in the debrief. Optional — standalone tutor sessions from
   * the Tutor page pass nothing. */
  @Post("sessions")
  createSession(@Body() body: StartTutorSessionDto) {
    return this.tutorService.createSession(body);
  }

  @Get("sessions")
  listSessions() {
    return this.tutorService.listSessions();
  }

  @Get("sessions/:id/messages")
  listMessages(@Param("id") id: string) {
    return this.tutorService.listMessages(id);
  }

  @Post("sessions/:id/messages")
  async message(@Param("id") id: string, @Body() body: TutorMessageDto, @Res() res: Response) {
    const stream = await this.tutorService.sendMessage(id, body.content, body.workspaceContext);

    openSseStream(res);
    const { text } = await pumpTextStream(res, stream.textStream);

    // Persist whatever the candidate actually saw, including a partial answer
    // from a stream they aborted — the user turn is already saved, so dropping
    // the assistant turn would leave the transcript lopsided.
    if (text) await this.tutorService.saveAssistantMessage(id, text);
  }
}
