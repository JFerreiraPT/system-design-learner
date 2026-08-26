import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCriteriaPrompt,
  buildInterviewerPrompt,
  buildValidationPrompt,
  hasEstimationPhase
} from "./index.js";
import type { InterviewerPlaybook, RubricCriterion } from "@sdl/shared";

const criteria: RubricCriterion[] = [
  {
    id: "tenant_isolation",
    text: "Tenant data is isolated across every API and storage path.",
    dimension: "security",
    importance: "core",
    visibility: "hidden",
    discoveryHints: ["How should tenant boundaries be enforced?"],
    satisfiedBy: ["tenant_id scoped queries"]
  }
];

const playbook: InterviewerPlaybook = {
  areasToProbe: [
    {
      id: "auth_and_isolation",
      label: "Auth & Isolation",
      phaseRefs: ["clarify"],
      criterionRefs: ["tenant_isolation"],
      sampleQuestions: ["Walk me through the React login to API authorization flow."],
      progressiveNudges: [
        "Who can manage tenant users?",
        "Where is tenant authorization enforced?",
        "Show the exact guard against cross-tenant reads."
      ],
      greenFlags: ["Separates authentication from tenant-scoped authorization."],
      redFlags: ["Trusts tenantId from the client without server-side checks."]
    },
    {
      id: "audit_logs",
      label: "Audit Logs",
      phaseRefs: ["deep_dive"],
      criterionRefs: ["tenant_isolation"],
      sampleQuestions: ["Where do audit logs live?"],
      progressiveNudges: [
        "What must be audited?",
        "How are audit entries protected?",
        "Show the write path for tamper-resistant audit logs."
      ],
      greenFlags: ["Treats audit logs as append-only records."],
      redFlags: ["Allows hard deletes without audit history."]
    }
  ],
  scoreRubric: {
    "1": "Cannot structure the design.",
    "2": "Misses important constraints.",
    "3": "Covers core trade-offs.",
    "4": "Drives the conversation with operational depth."
  }
};

test("interviewer prompt injects only the playbook areas for the current phase", () => {
  const prompt = buildInterviewerPrompt("standard", {
    criteria,
    playbook,
    currentPhaseId: "clarify"
  });

  assert.match(prompt, /PRIVATE INTERVIEWER PLAYBOOK FOR THIS PHASE/);
  assert.match(prompt, /Auth & Isolation/);
  assert.match(prompt, /Walk me through the React login/);
  assert.doesNotMatch(prompt, /Audit Logs/);
  assert.match(prompt, /Score rubric language to keep in mind/);
});

test("interviewer prompt omits the playbook block for legacy rows", () => {
  const prompt = buildInterviewerPrompt("standard", { criteria });
  assert.doesNotMatch(prompt, /PRIVATE INTERVIEWER PLAYBOOK FOR THIS PHASE/);
});

test("guided interviewer prompt requires informative and consistent scope answers", () => {
  const prompt = buildInterviewerPrompt("guided", { criteria });

  assert.match(prompt, /direct answer → v1 decision\/assumption → impact on the design or board/);
  assert.match(prompt, /what do I need \/ what should I do next/);
  assert.match(prompt, /Treat prior interviewer answers in the chat history as binding scope/);
  assert.match(prompt, /make only the smallest scope commitment needed/);
});

const VALIDATION_SCOPE = {
  constraints: ["Support up to 10K daily active users."],
  criteria
};

test("validation prompt omits the flags block when there is no playbook", () => {
  const prompt = buildValidationPrompt("medium", "", VALIDATION_SCOPE);

  assert.doesNotMatch(prompt, /OBSERVABLE FLAGS/);
  assert.doesNotMatch(prompt, /flagObservations/);
});

test("validation prompt is byte-identical with an absent vs undefined playbook", () => {
  const withoutKey = buildValidationPrompt("medium", "", VALIDATION_SCOPE);
  const withUndefined = buildValidationPrompt("medium", "", {
    ...VALIDATION_SCOPE,
    playbook: undefined
  });

  assert.equal(withUndefined, withoutKey);
});

test("validation prompt lists every playbook flag with a resolvable address", () => {
  const prompt = buildValidationPrompt("medium", "", { ...VALIDATION_SCOPE, playbook });

  assert.match(prompt, /OBSERVABLE FLAGS/);

  for (const area of playbook.areasToProbe) {
    area.greenFlags.forEach((flag, index) => {
      assert.ok(
        prompt.includes(`areaId=${area.id} kind=green index=${index} :: ${flag}`),
        `missing green flag ${area.id}#${index}`
      );
    });
    area.redFlags.forEach((flag, index) => {
      assert.ok(
        prompt.includes(`areaId=${area.id} kind=red index=${index} :: ${flag}`),
        `missing red flag ${area.id}#${index}`
      );
    });
  }

  // The flags block is phase-independent: unlike the interviewer playbook
  // block, validation grades the whole attempt, so every area is listed.
  assert.match(prompt, /Auth & Isolation/);
  assert.match(prompt, /Audit Logs/);
});

test("validation prompt asks for flagObservations only when flags were listed", () => {
  const withFlags = buildValidationPrompt("medium", "", { ...VALIDATION_SCOPE, playbook });
  assert.match(withFlags, /- flagObservations: array of \{ areaId, kind, index, text, fired, evidence\? \}/);

  const withoutFlags = buildValidationPrompt("medium", "", VALIDATION_SCOPE);
  assert.doesNotMatch(withoutFlags, /- flagObservations: array of/);
});

test("validation prompt tells the grader flags are reported, not scored", () => {
  const prompt = buildValidationPrompt("medium", "", { ...VALIDATION_SCOPE, playbook });

  assert.match(prompt, /REPORTED to the candidate, not scored/);
  assert.match(prompt, /INDEPENDENT observations, not two ends of one axis/);
  assert.match(prompt, /Do NOT infer a red flag purely from absence/);
});

test("hasEstimationPhase matches the vocabulary plans actually use", () => {
  assert.ok(hasEstimationPhase([{ id: "estimate", label: "Estimate" }]));
  assert.ok(hasEstimationPhase([{ id: "capacity_math", label: "Capacity math" }]));
  assert.ok(hasEstimationPhase([{ id: "sizing", label: "Sizing" }]));
  assert.ok(hasEstimationPhase([{ id: "napkin", label: "Back-of-envelope" }]));
  assert.ok(
    hasEstimationPhase([
      { id: "clarify", label: "Clarify" },
      { id: "scale_math", label: "Scale math" }
    ])
  );

  assert.equal(hasEstimationPhase([]), false);
  assert.equal(
    hasEstimationPhase([
      { id: "clarify", label: "Clarify" },
      { id: "high_level", label: "High-level" },
      { id: "deep_dive", label: "Deep dive" }
    ]),
    false
  );
});

const CRITERIA_INPUT = {
  difficulty: "medium" as const,
  interviewerLevel: "standard" as const,
  title: "Design a chat backend",
  statement: "Users exchange messages in rooms.",
  seedConstraints: ["Support up to 10K daily active users."]
};

test("criteria prompt demands a capacityEstimation criterion when the plan estimates", () => {
  const prompt = buildCriteriaPrompt({
    ...CRITERIA_INPUT,
    phases: [
      { id: "clarify", label: "Clarify" },
      { id: "estimate", label: "Estimate" }
    ]
  });

  assert.match(prompt, /ESTIMATION IS IN SCOPE/);
  assert.match(prompt, /At least ONE criterion MUST target dimension "capacityEstimation"/);
});

test("criteria prompt stays silent about estimation when no phase covers it", () => {
  const prompt = buildCriteriaPrompt({
    ...CRITERIA_INPUT,
    phases: [
      { id: "clarify", label: "Clarify" },
      { id: "high_level", label: "High-level" }
    ]
  });

  assert.doesNotMatch(prompt, /ESTIMATION IS IN SCOPE/);
});

test("capacityEstimation is offered as a dimension in the criteria prompt", () => {
  const prompt = buildCriteriaPrompt({
    ...CRITERIA_INPUT,
    phases: [{ id: "clarify", label: "Clarify" }]
  });
  assert.match(prompt, /operability, capacityEstimation/);
});
