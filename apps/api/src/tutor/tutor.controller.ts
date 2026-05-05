import { Body, Controller, Get, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { StartTutorSessionDto, TutorMessageDto } from "./tutor.dto.js";
import { TutorService } from "./tutor.service.js";

@Controller("tutor")
export class TutorController {
  constructor(@Inject(TutorService) private readonly tutorService: TutorService) {}

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

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullText = "";
    for await (const chunk of stream.textStream) {
      fullText += chunk;
      res.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
    }

    await this.tutorService.saveAssistantMessage(id, fullText);
    res.write("event: done\\ndata: done\\n\\n");
    res.end();
  }
}
