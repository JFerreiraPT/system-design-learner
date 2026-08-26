import { defineSeedProblem } from "../types.js";

export const canaryDeploymentPlatform = defineSeedProblem({
  slug: "canary-deployment-platform",
  title: "Design a Canary Deployment Platform",
  difficulty: "hard",
  track: "devops",
  tags: ["observability", "multi-tenant", "api-design", "cost-optimization"],
  statement: [
    "Design the deployment platform for a large microservice fleet. A team pushes a new version; the platform rolls it out progressively, watches its health against the current version, and either continues or rolls back automatically.",
    "",
    "In scope: the rollout state machine, traffic shifting, the metric collection and comparison that produces a verdict, automated rollback, database migration ordering, and the multi-tenant control plane that runs many rollouts at once.",
    "",
    "Out of scope: building container images, the service mesh internals (assume you can set traffic weights), and secret management.",
    "",
    "The fleet is heterogeneous: some services take a hundred thousand requests a second, others take three requests a minute. The platform must give a defensible verdict for both, and it must never leave a service in a half-deployed state."
  ].join("\n"),
  constraints: [
    "A rollout must be abortable at any point, returning 100% of traffic to the previous version within 60 seconds.",
    "The canary verdict must be based on a comparison against a concurrent baseline, not against yesterday's numbers.",
    "A rollback must never run backwards through a database migration that is not backward-compatible.",
    "A low-traffic service may not accumulate enough requests to reach statistical confidence, and the platform must say so rather than guess.",
    "One team's failing rollout must not block or delay another team's.",
    "Every rollout decision must be auditable: who deployed what, which metrics were compared, and why the verdict was reached.",
    "The platform must keep working when the metrics backend is degraded — a rollout may pause, but it may not silently pass."
  ],
  narrative: {
    framingScript:
      "We deploy a few thousand times a day across a few hundred services, and right now every team writes their own rollout script. I want a platform that does progressive delivery for all of them: shift a little traffic, watch, decide, continue or roll back. The part I care most about is the decision — how you know a canary is actually bad, and what you do when you cannot tell. Start wherever you like.",
    signatureChallenge:
      "Automated rollback is unsafe once a release has applied a schema change the old version cannot read, so migrations must be sequenced separately and rollback refused across an irreversible one. The candidate separates by also handling low traffic honestly: a 1% canary on a near-idle service must return insufficient-data, not a false pass.",
    progressiveReveals: [
      "Assume 400 services, 3,000 deploys a day, and the biggest service running 2,000 instances.",
      "Your metrics backend goes blind for ten minutes in the middle of forty concurrent rollouts. What happens to each of them?",
      "A team says a bad version reached 100% of traffic and the platform never flagged it. How do you find out why the verdict passed?"
    ]
  },
  estimationSpec: {
    intro:
      "The decisive quantity is the canary sample size: how many requests the canary actually serves during its observation window. That is what determines whether a verdict is meaningful.",
    fields: [
      {
        key: "services",
        label: "Services on the platform",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10,
          max: 10_000,
          rationale: "Hundreds of services in a mature microservice fleet"
        }
      },
      {
        key: "instances_per_service",
        label: "Average instances per service",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 2,
          max: 2_000,
          rationale: "A handful for most services, hundreds for the busiest"
        }
      },
      {
        key: "deploys_per_day",
        label: "Deploys / day",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10,
          max: 100_000,
          rationale: "Thousands a day when every team ships continuously"
        }
      },
      {
        key: "service_requests_per_sec",
        label: "Requests / sec for the service under test",
        type: "number",
        unitKind: "count",
        hint: "Pick a typical service, then consider the low-traffic case separately",
        expectedMagnitude: {
          min: 1,
          max: 1_000_000,
          rationale: "The fleet spans six orders of magnitude; this is the crux of the problem"
        }
      },
      {
        key: "canary_fraction",
        label: "Traffic fraction sent to the canary",
        type: "number",
        unitKind: "ratio",
        expectedMagnitude: {
          min: 0.001,
          max: 0.5,
          rationale: "Small enough to limit blast radius, large enough to observe"
        }
      },
      {
        key: "observation_seconds",
        label: "Observation window per rollout step",
        type: "number",
        unitKind: "seconds",
        displayUnit: "minutes",
        displayMultiplier: 60,
        expectedMagnitude: {
          min: 60,
          max: 7_200,
          rationale: "Long enough for a real signal, short enough that deploys still feel fast"
        }
      },
      {
        key: "metric_series_per_instance",
        label: "Metric series per instance",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10,
          max: 10_000,
          rationale: "Latency histograms and per-endpoint counters add up fast"
        }
      },
      {
        key: "metric_bytes_per_sample",
        label: "Bytes per metric sample",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        expectedMagnitude: {
          min: 10,
          max: 1_000,
          rationale: "A timestamp, a value, and series identity after compression"
        }
      },
      {
        key: "insufficient_data_policy",
        label: "What does the platform do when the canary cannot reach confidence?",
        type: "text"
      }
    ],
    derivedHints: [
      "Canary sample size is the number that matters. Compute it, then recompute it for a service doing three requests a minute — that second number is why 'just use 1%' is not a policy.",
      "Compare error-budget arithmetic against your sample: if the baseline error rate is one in a thousand, a sample of two hundred requests cannot detect a doubling of it.",
      "Metrics ingest is the platform's own scaling problem. If it is large, the comparison has to run against pre-aggregated series, not raw samples.",
      "Total observation time across all deploys tells you how much concurrency the control plane needs. Serial rollouts do not fit in a day."
    ],
    derivedFormulas: [
      {
        id: "canary_requests_per_sec",
        label: "Canary request rate",
        expression: "service_requests_per_sec * canary_fraction",
        unitKind: "count",
        displayUnit: "req/s"
      },
      {
        id: "canary_sample_size",
        label: "Canary requests observed per step",
        expression: "service_requests_per_sec * canary_fraction * observation_seconds",
        unitKind: "count",
        displayUnit: "requests"
      },
      {
        id: "total_instances",
        label: "Total instances under management",
        expression: "services * instances_per_service",
        unitKind: "count",
        displayUnit: "instances"
      },
      {
        id: "metrics_ingest_bytes_per_sec",
        label: "Metrics ingest throughput",
        expression:
          "services * instances_per_service * metric_series_per_instance * metric_bytes_per_sample",
        unitKind: "bytes",
        displayUnit: "B/s"
      },
      {
        id: "observation_seconds_per_day",
        label: "Total observation time / day",
        expression: "deploys_per_day * observation_seconds",
        unitKind: "seconds",
        displayUnit: "s/day"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Six phases. The verdict phase is the heart of it — a design that shifts traffic but cannot justify its pass/fail decision has not solved this problem.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope it. **Interact with:** **Problem** tab — note two constraints that most designs miss: migrations, and the low-traffic service. **Interviewer** tab — ask me about the deployment substrate, whether traffic weighting is available, who owns SLOs, and whether teams may opt out of automation."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 420,
        candidateGuide:
          "Compute the sample size. **Interact with:** **Estimation** tab — fill every field, then read canary sample size. Now mentally redo it for a service at 0.05 requests/sec. **Interviewer** tab — tell me both numbers and what they imply about a one-size-fits-all canary policy."
      },
      {
        id: "rollout_model",
        label: "Rollout state machine",
        durationSec: 600,
        candidateGuide:
          "Model the rollout. **Interact with:** **Board** — the states a rollout moves through, the traffic weights at each step, and how the desired state is reconciled against the actual fleet. Mark where the 60-second abort is enforced. **Interviewer** tab — tell me what happens if the control plane itself restarts mid-rollout; the answer should not be 'the rollout is lost'."
      },
      {
        id: "verdict",
        label: "Canary verdict",
        durationSec: 720,
        candidateGuide:
          "The decisive phase. **Interact with:** **Board** — how baseline and canary are compared: which metrics, how they are aggregated, over what window, and what makes the comparison fair (same instance class, same time window, same traffic mix). **Interviewer** tab — tell me the rule that produces pass, fail, or insufficient-data, and defend it for both a high-traffic and a low-traffic service. Use **Tutor** for statistical terms if you want, then commit to a concrete rule."
      },
      {
        id: "migrations_and_rollback",
        label: "Migrations and rollback",
        durationSec: 600,
        candidateGuide:
          "Handle the unsafe case. **Interact with:** **Board** — how schema changes are sequenced relative to code rollout, how the platform knows a migration is not backward-compatible, and what it does when a rollback would cross one. **Interviewer** tab — walk me through a rollout that must be aborted after the migration has already applied. Say plainly what the platform does and what it asks a human to do."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 420,
        candidateGuide:
          "Close it out. **Interact with:** **Board** — mark the trade-offs: rollout speed against confidence, blast radius against sample size, automation against human judgement. Note how tenants are isolated. **Interviewer** tab — summarise, then answer unprompted: what breaks first at 10x deploy volume, and what would you record so a passed-but-bad rollout is explainable afterwards? Then **Validate**, then **End interview**."
      }
    ]
  }
});
