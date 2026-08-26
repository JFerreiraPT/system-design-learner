import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query
} from "@nestjs/common";
import { GenerateProblemDto } from "./problems.dto.js";
import { ProblemsService } from "./problems.service.js";

@Controller("problems")
export class ProblemsController {
  constructor(@Inject(ProblemsService) private readonly problemsService: ProblemsService) {}

  @Post("generate")
  generate(@Body() body: GenerateProblemDto) {
    return this.problemsService.generate(body);
  }

  @Post("backfill-tags")
  backfillTags() {
    return this.problemsService.backfillTags();
  }

  /** `?force=true` also refreshes problems that already have a spec — needed
   * after the spec shape gains fields (units, expected magnitudes), since the
   * default only fills in NULLs. */
  @Post("backfill-estimation-specs")
  backfillEstimationSpecs(@Query("force") force?: string) {
    return this.problemsService.backfillEstimationSpecs({ force: force === "true" });
  }

  /** Adds the interviewer-facing narrative (framing script, signature
   * challenge, stall ladder) to problems generated before it existed.
   * `?force=true` also refreshes problems that already have one. */
  /** Infers the role archetype for problems generated before tracks existed.
   * Problems the classifier is unsure about stay unspecified. */
  @Post("backfill-tracks")
  backfillTracks() {
    return this.problemsService.backfillTracks();
  }

  @Post("backfill-narrative")
  backfillNarrative(@Query("force") force?: string) {
    return this.problemsService.backfillNarrative({ force: force === "true" });
  }

  @Post("backfill-interview-plans")
  backfillInterviewPlans() {
    return this.problemsService.backfillInterviewPlans();
  }

  @Get()
  list() {
    return this.problemsService.list();
  }

  /* Static paths after list(); dynamic :id routes — put more specific :id/... first */
  /** `?interviewId=` builds the answer from that interview's live scope and
   * rubric, so it cannot contradict the grade. Without it, behaviour is the
   * generic per-problem reference. */
  @Get(":id/reference")
  async reference(@Param("id") id: string, @Query("interviewId") interviewId?: string) {
    return this.problemsService.getReference(id, interviewId);
  }

  @Get(":id")
  async getOne(@Param("id") id: string) {
    const problem = await this.problemsService.getById(id);
    if (!problem) throw new NotFoundException("Problem not found");
    return problem;
  }
}
