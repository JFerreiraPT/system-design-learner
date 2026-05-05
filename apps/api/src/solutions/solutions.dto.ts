import { ValidateSolutionInputSchema } from "@sdl/shared";
import { ValidatedDto } from "../common/validated.dto.js";

export class ValidateSolutionDto extends ValidatedDto<typeof ValidateSolutionInputSchema> {
  static schema = ValidateSolutionInputSchema;
  declare problemId: string;
  declare sceneJson: string;
  declare notes?: string;
  declare imageBase64?: string;
  declare estimation?: Record<string, unknown>;
  declare interviewId?: string;
}
