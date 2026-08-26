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
  },
  rubric: {
    criteria: [
      {
        id: "migration_gated_rollback",
        text: "Rollback is refused or gated when the release applied a schema change the previous version cannot read.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Migrations sequenced as a separate step the platform knows about",
          "A backward-compatibility property recorded per migration and checked before rollback"
        ],
        discoveryHints: [
          "The canary fails after the migration already ran. Can you roll back?",
          "Does the platform know whether a migration is reversible?"
        ],
        progressiveNudges: [
          "Your rollout applied a schema change, then the canary failed. What does automated rollback do?",
          "If the old code cannot read the new schema, what happens when it comes back?",
          "So how does the platform know, before rolling back, that this is safe? What does it record per migration?"
        ]
      },
      {
        id: "insufficient_data_verdict",
        text: "A canary that cannot reach statistical confidence returns insufficient-data rather than a pass.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A minimum sample size or confidence check before a verdict",
          "A third verdict distinct from pass and fail, with a defined next action"
        ],
        discoveryHints: [
          "A service takes three requests a minute. What does a 1% canary observe?",
          "Can your verdict be pass, fail, or something else?"
        ],
        progressiveNudges: [
          "Compute the canary sample for a service at three requests a minute over ten minutes.",
          "Can you detect a doubled error rate from that sample?",
          "So what does the platform return — and what does it do next, given it cannot decide?"
        ]
      },
      {
        id: "concurrent_baseline_comparison",
        text: "The canary is compared against a concurrently running baseline, not against historical data.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A baseline group serving traffic in the same window",
          "Matched instance class and traffic mix between canary and baseline"
        ],
        discoveryHints: [
          "What are you comparing the canary's metrics against?",
          "Why not yesterday's numbers for the same service?"
        ],
        progressiveNudges: [
          "What is the control group in this experiment?",
          "If you compare against last week, what confounds the result?",
          "What has to match between canary and baseline for the comparison to mean anything?"
        ]
      },
      {
        id: "metrics_blind_pauses",
        text: "When the metrics backend is degraded, rollouts pause rather than silently passing.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "Absence of data treated as not-a-pass",
          "A defined state for rollouts in flight when metrics are unavailable"
        ],
        discoveryHints: [
          "Your metrics backend goes blind for ten minutes mid-rollout. What happens?",
          "Is no data the same as good data?"
        ],
        progressiveNudges: [
          "Forty rollouts are in flight and metrics stop arriving. What does each do?",
          "If your check is 'error rate below threshold', what does zero data evaluate to?",
          "Make the failure mode explicit: does no data pass, fail, or pause?"
        ]
      },
      {
        id: "fast_abort",
        text: "A rollout can be aborted at any point with all traffic back on the previous version within 60 seconds.",
        dimension: "latencyPerformance",
        importance: "core",
        satisfiedBy: [
          "Traffic weights reset in one control-plane operation",
          "The previous version's instances kept warm until the rollout completes"
        ]
      },
      {
        id: "canary_sample_math",
        text: "Canary sample size is computed from traffic rate, split, and observation window, for both a busy and a quiet service.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A sample-size number for a typical service",
          "The same computation redone for a low-traffic service, showing the problem"
        ],
        discoveryHints: [
          "How many requests does the canary actually serve during one step?",
          "Redo that for a service doing one request a minute."
        ],
        progressiveNudges: [
          "Multiply request rate by canary fraction by window length.",
          "Now do it for your quietest service.",
          "What does the difference between those two numbers say about a fleet-wide canary policy?"
        ]
      },
      {
        id: "reconciled_rollout_state",
        text: "Rollout state is persisted and reconciled, so a control-plane restart resumes rather than loses the rollout.",
        dimension: "reliability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Desired state stored durably and continuously reconciled against actual",
          "A rollout that survives the orchestrator restarting"
        ],
        discoveryHints: [
          "The control plane restarts mid-rollout. What happens to the rollout?",
          "Where does rollout state live?"
        ],
        progressiveNudges: [
          "Your orchestrator process dies at 25% traffic shifted. What is the state of the world?",
          "Is that state in memory or persisted?",
          "How does the new process learn what it should be converging toward?"
        ]
      },
      {
        id: "progressive_traffic_steps",
        text: "Traffic is shifted in defined steps with a verdict gate between them, not in one jump.",
        dimension: "requirements",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Named traffic percentages per step",
          "A gate between steps that consults the verdict"
        ],
        discoveryHints: [
          "What are the actual traffic percentages in your rollout?",
          "What has to happen between one step and the next?"
        ],
        progressiveNudges: [
          "Describe the traffic sequence from 0% to 100%.",
          "What decides whether to take the next step?",
          "How do you pick step sizes — blast radius, or sample size, or both?"
        ]
      },
      {
        id: "verdict_metric_selection",
        text: "The metrics compared are named and tied to user-visible impact, not just infrastructure signals.",
        dimension: "operability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Specific signals such as error rate and latency percentiles",
          "A statement of why CPU or memory alone is not a verdict"
        ],
        discoveryHints: [
          "Which metrics decide pass or fail?",
          "Would you fail a canary on CPU alone?"
        ],
        progressiveNudges: [
          "Name the specific signals your verdict reads.",
          "Which of those would a user actually notice?",
          "What do you do about a canary that is slower but has no errors?"
        ]
      },
      {
        id: "tenant_isolation",
        text: "One team's failing rollout does not block or delay another team's.",
        dimension: "reliability",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "Per-team or per-service rollout concurrency rather than a global queue",
          "A stuck rollout that does not hold a shared lock"
        ],
        discoveryHints: [
          "Forty rollouts are in flight. One is stuck. What happens to the other 39?",
          "Is there anything global that rollouts contend on?"
        ],
        progressiveNudges: [
          "One team's rollout hangs waiting for a verdict. Who else is blocked?",
          "What resource do all rollouts share?",
          "How do you bound the damage — per-team concurrency, timeouts, or both?"
        ]
      },
      {
        id: "metrics_ingest_scale",
        text: "The platform's own metrics ingestion volume is sized, and comparisons run against aggregates rather than raw samples.",
        dimension: "scalability",
        importance: "expected",
        hiddenFrom: "hard",
        satisfiedBy: [
          "An ingest throughput figure derived from instances and series",
          "Verdicts computed from pre-aggregated series"
        ],
        discoveryHints: [
          "How much metric data does the whole fleet produce?",
          "Does the verdict query raw samples?"
        ],
        progressiveNudges: [
          "Compute metrics ingest across instances and series.",
          "Is that a small number?",
          "So can your verdict scan raw samples per rollout, or does it need pre-aggregation?"
        ]
      },
      {
        id: "decision_audit_trail",
        text: "Every rollout decision is auditable: who deployed, which metrics were compared, and why the verdict was reached.",
        dimension: "operability",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Recorded inputs to the verdict alongside the outcome",
          "Enough detail to explain a passed-but-bad rollout after the fact"
        ],
        discoveryHints: [
          "A bad version passed and reached 100%. How do you find out why?",
          "What do you record at verdict time?"
        ],
        progressiveNudges: [
          "A team says the platform passed a broken release. How do you investigate?",
          "Do you still have the metric values the verdict saw?",
          "What exactly would you persist so that question has a definitive answer?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "verdict_logic",
          label: "Canary verdict",
          phaseRefs: ["verdict", "estimate"],
          criterionRefs: [
            "insufficient_data_verdict",
            "concurrent_baseline_comparison",
            "canary_sample_math",
            "verdict_metric_selection"
          ],
          sampleQuestions: [
            "A service takes three requests a minute. What does a 1% canary over ten minutes observe, and can you decide anything?",
            "What are you comparing the canary against, and why not last week's numbers?"
          ],
          progressiveNudges: [
            "Compute the canary sample size for a busy service, then a quiet one.",
            "Can the quiet one detect a doubled error rate?",
            "So what is the third verdict, and what does the platform do next?"
          ],
          greenFlags: [
            "Returns insufficient-data instead of a false pass",
            "Insists on a concurrent baseline with matched conditions"
          ],
          redFlags: [
            "One fixed canary percentage for the whole fleet",
            "Compares against historical data from another window"
          ]
        },
        {
          id: "rollout_mechanics",
          label: "Rollout mechanics",
          phaseRefs: ["rollout_model"],
          criterionRefs: ["progressive_traffic_steps", "fast_abort", "reconciled_rollout_state"],
          sampleQuestions: [
            "Describe the traffic sequence from 0% to 100% and what gates each step.",
            "The control plane restarts at 25% shifted. What is the state of the world?"
          ],
          progressiveNudges: [
            "What are the actual percentages?",
            "How is the 60-second abort achieved — are old instances still warm?",
            "And where does rollout state live so a restart resumes rather than loses it?"
          ],
          greenFlags: [
            "Persisted desired state continuously reconciled",
            "Keeps the previous version warm to make abort fast"
          ],
          redFlags: [
            "Rollout state in orchestrator memory",
            "Abort requires redeploying the old version"
          ]
        },
        {
          id: "unsafe_rollback",
          label: "Migrations and unsafe rollback",
          phaseRefs: ["migrations_and_rollback"],
          criterionRefs: ["migration_gated_rollback"],
          sampleQuestions: [
            "The canary fails after the migration already applied. What does automated rollback do?",
            "How does the platform know a migration is not backward-compatible?"
          ],
          progressiveNudges: [
            "Old code, new schema. What breaks?",
            "Does the platform know that before it rolls back?",
            "What does it record per migration, and what does it ask a human to do?"
          ],
          greenFlags: [
            "Sequences migrations separately and records reversibility",
            "Refuses automated rollback and escalates rather than corrupting data"
          ],
          redFlags: [
            "Rolls back code without considering schema state",
            "Assumes all migrations are additive"
          ]
        },
        {
          id: "platform_scale",
          label: "Platform scale and accountability",
          phaseRefs: ["estimate", "wrap_up"],
          criterionRefs: [
            "metrics_blind_pauses",
            "tenant_isolation",
            "metrics_ingest_scale",
            "decision_audit_trail"
          ],
          sampleQuestions: [
            "Metrics stop arriving during forty concurrent rollouts. What does each do?",
            "A team says you passed a broken release. How do you investigate?"
          ],
          progressiveNudges: [
            "If your check is 'errors below threshold', what does no data evaluate to?",
            "Now isolation: what do all forty rollouts share?",
            "And what did you persist at verdict time to answer the audit question?"
          ],
          greenFlags: [
            "Treats absent data as not-a-pass and pauses",
            "Records the verdict inputs, not just the outcome"
          ],
          redFlags: [
            "Missing metrics evaluate as healthy",
            "A global rollout queue or lock"
          ]
        }
      ],
      scoreRubric: {
        "1": "Describes shifting traffic and watching a dashboard, with no defined verdict rule, no baseline, and no consideration of migrations.",
        "2": "Has progressive steps and automated rollback on error-rate threshold, but one fixed canary percentage, historical comparison, and no migration handling.",
        "3": "Compares against a concurrent baseline, computes sample size, returns insufficient-data honestly, and gates rollback on migration reversibility.",
        "4": "Also pauses when metrics are blind, isolates tenants, sizes its own metrics ingest and aggregates for verdicts, and records enough to audit a bad pass afterwards."
      }
    }
  }
});
