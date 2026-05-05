export {
  DEFAULT_INTERVIEW_PLAN,
  InterviewPlanSchema,
  timerPhasesFromPlan,
  WORKSPACE_PHASES,
  type InterviewPlan,
  type InterviewPlanPhase,
  type PhaseDefinition
} from "@sdl/shared";

/** @deprecated use PhaseDefinition */
export type PhaseDef = import("@sdl/shared").PhaseDefinition;

export type PhasePersistState = {
  phaseIndex: number;
  elapsedSecInPhase: number;
  running: boolean;
};
