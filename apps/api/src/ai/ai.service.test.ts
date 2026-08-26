import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeGeneratedPlaybook } from "./ai.service.js";
import type { RubricCriterion } from "@sdl/shared";

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

test("sanitizeGeneratedPlaybook filters invalid phase and criterion refs", () => {
  const playbook = sanitizeGeneratedPlaybook({
    criteria,
    phases: [{ id: "clarify", label: "Clarify" }],
    raw: {
      areasToProbe: [
        {
          id: "Auth & Isolation",
          label: "Auth & Isolation",
          phaseRefs: ["clarify", "made_up_phase"],
          criterionRefs: ["tenant_isolation", "missing_criterion"],
          sampleQuestions: ["Walk me through auth."],
          progressiveNudges: ["Who can access this?", "Where is it checked?", "Show the guard."],
          greenFlags: ["Names server-side tenant authorization."],
          redFlags: ["Trusts tenantId from the client."]
        }
      ],
      scoreRubric: {
        "1": "Cannot structure the design.",
        "2": "Misses important constraints.",
        "3": "Covers core trade-offs.",
        "4": "Drives the conversation with operational depth."
      }
    }
  });

  assert.equal(playbook.areasToProbe[0]?.id, "auth_isolation");
  assert.deepEqual(playbook.areasToProbe[0]?.phaseRefs, ["clarify"]);
  assert.deepEqual(playbook.areasToProbe[0]?.criterionRefs, ["tenant_isolation"]);
});
