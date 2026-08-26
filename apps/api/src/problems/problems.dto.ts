import { GenerateProblemInputSchema, type Difficulty, type Track } from "@sdl/shared";
import { ValidatedDto } from "../common/validated.dto.js";

export class GenerateProblemDto extends ValidatedDto<typeof GenerateProblemInputSchema> {
  static schema = GenerateProblemInputSchema;
  declare difficulty: Difficulty;
  declare track?: Track;
  declare topic?: string;
}
