import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Res
} from "@nestjs/common";
import type { Response } from "express";
import { AddConstraintDto, InterviewMessageDto, PatchInterviewDto, StartInterviewDto } from "./interview.dto.js";
import { InterviewService } from "./interview.service.js";

@Controller("interviews")
export class InterviewController {
  constructor(@Inject(InterviewService) private readonly interviewService: InterviewService) {}

  @Post()
  start(@Body() body: StartInterviewDto) {
    return this.interviewService.start(body);
  }

  /** Bulk backfill: regenerate criteria for any interview where
   * criteria_json IS NULL (legacy sessions started before the column existed).
   * Mirrors `/problems/backfill-tags`. */
  @Post("backfill-criteria")
  backfillCriteria() {
    return this.interviewService.backfillCriteria();
  }

  @Patch(":id")
  patch(@Param("id") id: string, @Body() body: PatchInterviewDto) {
    return this.interviewService.updateLevel(id, body.interviewerLevel);
  }

  @Post(":id/messages")
  async message(@Param("id") id: string, @Body() body: InterviewMessageDto, @Res() res: Response) {
    const stream = await this.interviewService.sendMessage(id, body.content, body.workspaceContext);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullText = "";
    for await (const chunk of stream.textStream) {
      fullText += chunk;
      res.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
    }

    await this.interviewService.saveAssistantMessage(id, fullText);
    res.write("event: done\\ndata: done\\n\\n");
    res.end();
  }

  @Get(":id/messages")
  listMessages(@Param("id") id: string) {
    return this.interviewService.listMessages(id);
  }

  /** Snapshot of the live constraint set + pending AI proposals. */
  @Get(":id/constraints")
  getConstraints(@Param("id") id: string) {
    return this.interviewService.getConstraintState(id);
  }

  /** Candidate-driven manual add (origin=candidate). */
  @Post(":id/constraints")
  addConstraint(@Param("id") id: string, @Body() body: AddConstraintDto) {
    return this.interviewService.addConstraint(id, body.text);
  }

  /** Soft-remove (status=removed). */
  @Delete(":id/constraints/:constraintId")
  removeConstraint(@Param("id") id: string, @Param("constraintId") constraintId: string) {
    return this.interviewService.removeConstraint(id, constraintId);
  }

  @Post(":id/proposals/:proposalId/apply")
  applyProposal(@Param("id") id: string, @Param("proposalId") proposalId: string) {
    return this.interviewService.applyProposal(id, proposalId);
  }

  @Post(":id/proposals/:proposalId/dismiss")
  dismissProposal(@Param("id") id: string, @Param("proposalId") proposalId: string) {
    return this.interviewService.dismissProposal(id, proposalId);
  }

  /** Progress-only snapshot of the per-interview rubric (counts + discovered
   * IDs). Safe to call any time — does NOT leak hidden criterion text. The
   * Problem rail's discovery indicator binds to this. */
  @Get(":id/criteria")
  getCriteriaProgress(@Param("id") id: string) {
    return this.interviewService.getCriteriaProgress(id);
  }

  /** Full reveal of the rubric (including hidden criterion bodies). Gated
   * behind "must have submitted at least one validation" — same rule as
   * `/problems/:id/reference`. Used by the Validate panel for the
   * post-mortem covered / missed / never-asked breakdown. */
  @Get(":id/criteria/reveal")
  revealCriteria(@Param("id") id: string) {
    return this.interviewService.revealCriteria(id);
  }

  /** Backfill / regenerate. Useful for legacy interviews that started
   * before per-interview criteria existed (criteria_json IS NULL). */
  @Post(":id/criteria/regenerate")
  regenerateCriteria(@Param("id") id: string) {
    return this.interviewService.regenerateCriteria(id);
  }
}
