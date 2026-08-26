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
import { openSseStream, pumpTextStream } from "../common/sse.js";
import {
  AddConstraintDto,
  InterviewMessageDto,
  PatchInterviewDto,
  PhaseEventDto,
  StartInterviewDto
} from "./interview.dto.js";
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

  /** Change the interviewer level. `regenerateCriteria: true` also rebuilds the
   * rubric for the new level in the same request — see `updateLevel` for why
   * that is opt-in. Returns `rubricStale` so the client can keep offering it. */
  @Patch(":id")
  patch(@Param("id") id: string, @Body() body: PatchInterviewDto) {
    return this.interviewService.updateLevel(
      id,
      body.interviewerLevel,
      body.regenerateCriteria === true
    );
  }

  @Post(":id/messages")
  async message(@Param("id") id: string, @Body() body: InterviewMessageDto, @Res() res: Response) {
    const stream = await this.interviewService.sendMessage(id, body.content, body.workspaceContext);

    openSseStream(res);
    const { text } = await pumpTextStream(res, stream.textStream);

    // Persist whatever the candidate actually saw, including a partial answer
    // from a stream they aborted — the user turn is already saved, so dropping
    // the assistant turn would leave the transcript lopsided.
    if (text) {
      await this.interviewService.saveAssistantMessage(id, text, body.workspaceContext?.phase);
    }
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

  /** Close out the interview: lifecycle + `endedAt` + a persisted debrief.
   * Idempotent — a second call returns the stored debrief. */
  @Post(":id/end")
  end(@Param("id") id: string) {
    return this.interviewService.end(id);
  }

  /** Lifecycle snapshot (status, endedAt, stored debrief). Lets a workspace
   * restored from localStorage know whether the interview still accepts
   * messages. */
  @Get(":id/status")
  getStatus(@Param("id") id: string) {
    return this.interviewService.getStatus(id);
  }

  /** Factual tutor-usage summary for this interview. Reported, never scored,
   * and never a gate — see `getTutorUsage`. Zeros (not a 404) when the tutor
   * was never opened. */
  @Get(":id/tutor-usage")
  getTutorUsage(@Param("id") id: string) {
    return this.interviewService.getTutorUsage(id);
  }

  /** Live phase-transition offer, plus the phases already answered for. The
   * workspace polls this after each interviewer turn. */
  @Get(":id/phase-proposal")
  getPhaseProposal(@Param("id") id: string) {
    return this.interviewService.getPhaseProposal(id);
  }

  /** Candidate accepted the offer. Clears it and suppresses re-proposal for
   * that phase; the client performs the actual advance, because the timer is
   * client-owned and the server never moves the candidate. */
  @Post(":id/phase-proposal/apply")
  applyPhaseProposal(@Param("id") id: string) {
    return this.interviewService.resolvePhaseProposal(id);
  }

  /** Candidate chose to stay. Same server-side effect as apply — closing the
   * question — which is why both routes share one method. */
  @Post(":id/phase-proposal/dismiss")
  dismissPhaseProposal(@Param("id") id: string) {
    return this.interviewService.resolvePhaseProposal(id);
  }

  /** Append-only pacing telemetry. Called fire-and-forget by the workspace on
   * phase start / advance / reset — the live timer stays client-owned. */
  @Post(":id/phase-events")
  recordPhaseEvent(@Param("id") id: string, @Body() body: PhaseEventDto) {
    return this.interviewService.recordPhaseEvent(id, body);
  }

  /** Per-phase actual vs suggested budget, reduced from the event log. */
  @Get(":id/phase-timeline")
  getPhaseTimeline(@Param("id") id: string) {
    return this.interviewService.getPhaseTimeline(id);
  }

  /** Progress-only snapshot of the per-interview rubric (counts + surfaced
   * hidden texts once discovered). Undiscovered expectations stay opaque. */
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
