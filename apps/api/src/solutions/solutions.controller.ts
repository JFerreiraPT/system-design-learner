import { Body, Controller, Get, Inject, Post, Query } from "@nestjs/common";
import { ValidateSolutionDto } from "./solutions.dto.js";
import { SolutionsService } from "./solutions.service.js";

@Controller("solutions")
export class SolutionsController {
  constructor(@Inject(SolutionsService) private readonly solutionsService: SolutionsService) {}

  @Post()
  validate(@Body() body: ValidateSolutionDto) {
    return this.solutionsService.validate(body);
  }

  @Get()
  list(
    @Query("problemId") problemId: string | undefined,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string
  ) {
    if (problemId) {
      return this.solutionsService.listByProblem(problemId);
    }
    const limit = parseInt(limitRaw ?? "100", 10);
    const offset = parseInt(offsetRaw ?? "0", 10);
    return this.solutionsService.listAll(Number.isFinite(limit) ? limit : 100, Number.isFinite(offset) ? offset : 0);
  }
}
