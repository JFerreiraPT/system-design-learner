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

  @Post("backfill-interview-plans")
  backfillInterviewPlans() {
    return this.problemsService.backfillInterviewPlans();
  }

  @Get()
  list() {
    return this.problemsService.list();
  }

  /* Static paths after list(); dynamic :id routes — put more specific :id/... first */
  @Get(":id/reference")
  async reference(@Param("id") id: string) {
    return this.problemsService.getReference(id);
  }

  @Get(":id")
  async getOne(@Param("id") id: string) {
    const problem = await this.problemsService.getById(id);
    if (!problem) throw new NotFoundException("Problem not found");
    return problem;
  }
}
