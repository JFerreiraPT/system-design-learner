import {
  AddConstraintInputSchema,
  InterviewMessageSchema,
  InterviewPatchSchema,
  InterviewStartSchema,
  PhaseEventInputSchema
} from "@sdl/shared";
import type {
  InterviewerLevel,
  PhaseEventKind,
  PhaseRuntimeInfo,
  SceneSummary
} from "@sdl/shared";
import { ValidatedDto } from "../common/validated.dto.js";

export class StartInterviewDto extends ValidatedDto<typeof InterviewStartSchema> {
  static schema = InterviewStartSchema;
  declare problemId: string;
  declare interviewerLevel: InterviewerLevel;
}

export class PatchInterviewDto extends ValidatedDto<typeof InterviewPatchSchema> {
  static schema = InterviewPatchSchema;
  declare interviewerLevel: InterviewerLevel;
  declare regenerateCriteria?: boolean;
}

export class InterviewMessageDto extends ValidatedDto<typeof InterviewMessageSchema> {
  static schema = InterviewMessageSchema;
  declare content: string;
  declare workspaceContext?: {
    problemId?: string;
    problemTitle?: string;
    problemStatement?: string;
    constraints?: string[];
    sceneSummary?: SceneSummary;
    imageBase64?: string;
    notes?: string;
    phase?: PhaseRuntimeInfo;
    estimation?: Record<string, unknown>;
    estimationChecklist?: {
      intro?: string;
      fields: Array<{ key: string; label: string; hint?: string }>;
    };
  };
}

export class AddConstraintDto extends ValidatedDto<typeof AddConstraintInputSchema> {
  static schema = AddConstraintInputSchema;
  declare text: string;
}

export class PhaseEventDto extends ValidatedDto<typeof PhaseEventInputSchema> {
  static schema = PhaseEventInputSchema;
  declare phaseId: string;
  declare phaseIndex: number;
  declare kind: PhaseEventKind;
  declare elapsedSec: number;
}
