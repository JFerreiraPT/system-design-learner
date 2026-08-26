import { Body, Controller, Inject, Param, Post } from "@nestjs/common";
import { VoiceSessionDto, VoiceTurnsDto } from "./voice.dto.js";
import { VoiceService } from "./voice.service.js";

@Controller("interviews")
export class VoiceController {
  constructor(@Inject(VoiceService) private readonly voiceService: VoiceService) {}

  /** Mint a short-lived realtime credential for this interview.
   *
   * The interviewer prompt — hidden rubric included — is baked into the
   * credential server-side and is NOT part of the response. See
   * `VoiceSessionResponseSchema` for why that matters. */
  @Post(":id/voice/session")
  createSession(@Param("id") id: string, @Body() body: VoiceSessionDto) {
    return this.voiceService.createSession(id, body?.workspaceContext);
  }

  /** Record completed spoken turns. Idempotent on `externalId`: reconnects and
   * retries replay turns, and a duplicated answer skews the debrief. */
  @Post(":id/voice/turns")
  recordTurns(@Param("id") id: string, @Body() body: VoiceTurnsDto) {
    return this.voiceService.recordTurns(id, body.turns, body.audioSecondsTotal);
  }
}
