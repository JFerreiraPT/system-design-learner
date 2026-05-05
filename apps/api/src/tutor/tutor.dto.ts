import { TutorMessageSchema, TutorStartSchema } from "@sdl/shared";
import type { SceneSummary } from "@sdl/shared";
import { ValidatedDto } from "../common/validated.dto.js";

export class StartTutorSessionDto extends ValidatedDto<typeof TutorStartSchema> {
  static schema = TutorStartSchema;
  declare title?: string;
}

export class TutorMessageDto extends ValidatedDto<typeof TutorMessageSchema> {
  static schema = TutorMessageSchema;
  declare content: string;
  declare workspaceContext?: {
    problemId?: string;
    problemTitle?: string;
    problemStatement?: string;
    constraints?: string[];
    sceneSummary?: SceneSummary;
    imageBase64?: string;
    notes?: string;
    currentPhase?: string;
    estimation?: Record<string, unknown>;
    estimationChecklist?: {
      intro?: string;
      fields: Array<{ key: string; label: string; hint?: string }>;
    };
  };
}
