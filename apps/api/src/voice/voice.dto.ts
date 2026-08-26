import { VoiceSessionRequestSchema, VoiceTurnsRequestSchema } from "@sdl/shared";
import type { PhaseRuntimeInfo, SceneSummary, VoiceTurn } from "@sdl/shared";
import { ValidatedDto } from "../common/validated.dto.js";

export class VoiceTurnsDto extends ValidatedDto<typeof VoiceTurnsRequestSchema> {
  static schema = VoiceTurnsRequestSchema;
  declare turns: VoiceTurn[];
  declare audioSecondsDelta?: number;
}

export class VoiceSessionDto extends ValidatedDto<typeof VoiceSessionRequestSchema> {
  static schema = VoiceSessionRequestSchema;
  declare workspaceContext?: {
    sceneSummary?: SceneSummary;
    notes?: string;
    phase?: PhaseRuntimeInfo;
    estimation?: Record<string, unknown>;
  };
}
