import { defineSeedProblem } from "../types.js";

export const ragKnowledgeAssistant = defineSeedProblem({
  slug: "rag-knowledge-assistant",
  title: "Design an Internal Knowledge Assistant (RAG)",
  difficulty: "hard",
  track: "ai-engineering",
  tags: ["caching", "cost-optimization", "observability", "api-design"],
  statement: [
    "Design a question-answering assistant over a company's internal documents — wikis, tickets, design docs, code comments. An employee asks a question in natural language and gets a grounded answer with citations.",
    "",
    "In scope: document ingestion and chunking, embedding and indexing, retrieval and reranking, prompt assembly, the inference gateway with routing and fallback, caching, permission enforcement, and offline evaluation.",
    "",
    "Out of scope: training or fine-tuning a model (assume hosted models behind an API), the chat UI, and the identity provider.",
    "",
    "Documents change constantly and so do their permissions: a design doc that was company-wide on Monday may be restricted to one team on Tuesday. The corpus is large, the query volume is modest, and inference is the dominant cost."
  ].join("\n"),
  constraints: [
    "An answer must arrive in under 5 seconds at p95, including retrieval and generation.",
    "Every claim in an answer must cite a retrieved source; an answer with no supporting chunk must say it does not know.",
    "A user must never be shown content from a document they cannot read — including through a cached answer generated for someone else.",
    "A permission change must take effect in retrieval within 5 minutes.",
    "A document edited in the wiki must be reflected in answers within one hour.",
    "The model provider may be slow or unavailable, and the system must degrade rather than fail outright.",
    "Inference spend must be attributable per team, and a runaway team must not exhaust the global budget."
  ],
  narrative: {
    framingScript:
      "We want an assistant that answers questions about our internal documentation with citations. The naive version is a weekend project, so I am going to push on the parts that make it real: keeping the index fresh, keeping costs predictable, and making absolutely sure it never shows someone a document they are not allowed to read. Design the whole pipeline, ingestion through answer. Start wherever you like.",
    signatureChallenge:
      "The vector index is a stale copy of permissions, so a chunk indexed while a document was public stays retrievable after it is restricted — and a cached answer can leak it to another user. The candidate separates by checking authorization at query time against the live source, and by keying the answer cache on the requester's access scope.",
    progressiveReveals: [
      "Say the corpus is now 20 million documents and we are serving 200,000 questions a day across 40 teams.",
      "The model provider starts timing out on a third of requests. What does a user asking a question experience?",
      "A user says the assistant quoted a document that was restricted last week. How do you determine how that chunk was retrieved?"
    ]
  },
  estimationSpec: {
    intro:
      "Two very different budgets: index size, which is driven by the corpus, and inference cost, which is driven by queries and prompt size. Size both.",
    fields: [
      {
        key: "documents",
        label: "Documents in the corpus",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10_000,
          max: 100_000_000,
          rationale: "A large company accumulates millions of documents and tickets"
        }
      },
      {
        key: "chunks_per_document",
        label: "Chunks per document",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 2,
          max: 500,
          rationale: "A few paragraphs per chunk means tens of chunks for a typical doc"
        }
      },
      {
        key: "embedding_bytes_per_chunk",
        label: "Bytes per embedding vector",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        hint: "Dimensions times bytes per dimension, plus the stored chunk text",
        expectedMagnitude: {
          min: 500,
          max: 50_000,
          rationale: "A 1536-dimension float32 vector is about 6KB before compression"
        }
      },
      {
        key: "queries_per_day",
        label: "Questions asked / day",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 1_000,
          max: 10_000_000,
          rationale: "Internal tools see thousands to hundreds of thousands of queries a day"
        }
      },
      {
        key: "retrieved_chunks_per_query",
        label: "Chunks retrieved per query",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 3,
          max: 200,
          rationale: "Enough context to ground an answer without flooding the prompt"
        }
      },
      {
        key: "prompt_tokens_per_query",
        label: "Prompt tokens per query",
        type: "number",
        unitKind: "count",
        hint: "System prompt plus retrieved context plus the question",
        expectedMagnitude: {
          min: 500,
          max: 200_000,
          rationale: "Retrieved context dominates; a few thousand tokens is typical"
        }
      },
      {
        key: "cache_hit_ratio",
        label: "Answer cache hit ratio",
        type: "number",
        unitKind: "ratio",
        expectedMagnitude: {
          min: 0.01,
          max: 0.9,
          rationale: "Internal questions repeat, but scoping the cache per user limits reuse"
        }
      },
      {
        key: "cost_per_million_tokens",
        label: "Model cost per million tokens",
        type: "number",
        unitKind: "currency",
        displayUnit: "USD",
        expectedMagnitude: {
          min: 0.05,
          max: 100,
          rationale: "Cheap models are cents per million tokens; frontier models are dollars"
        }
      },
      {
        key: "reindex_interval_seconds",
        label: "Full reindex interval",
        type: "number",
        unitKind: "seconds",
        displayUnit: "hours",
        displayMultiplier: 3600,
        expectedMagnitude: {
          min: 3_600,
          max: 2_592_000,
          rationale: "Incremental updates handle freshness; full rebuilds are rarer"
        }
      },
      {
        key: "permission_enforcement_point",
        label: "Where exactly are permissions checked, and against what source?",
        type: "text"
      }
    ],
    derivedHints: [
      "Total chunks is the number that sizes your vector index. If it lands in the billions, flat search is out and you need an approximate index with a recall trade-off you should name.",
      "Daily inference cost is usually the number that decides the product's viability. Compute it, then look at what the cache hit ratio does to it.",
      "Notice that queries per second is small — often single digits. That means latency, not throughput, is your engineering problem.",
      "Embedding the whole corpus once is a one-off cost that can dwarf a month of query spend. Consider it before proposing a re-embed on every model upgrade."
    ],
    derivedFormulas: [
      {
        id: "total_chunks",
        label: "Total indexed chunks",
        expression: "documents * chunks_per_document",
        unitKind: "count",
        displayUnit: "chunks"
      },
      {
        id: "vector_index_bytes",
        label: "Vector index size",
        expression: "documents * chunks_per_document * embedding_bytes_per_chunk",
        unitKind: "bytes",
        displayUnit: "B"
      },
      {
        id: "queries_per_sec",
        label: "Queries / sec",
        expression: "queries_per_day / 86400",
        unitKind: "count",
        displayUnit: "qps"
      },
      {
        id: "llm_calls_per_sec",
        label: "Model calls / sec after cache",
        expression: "queries_per_day * (1 - cache_hit_ratio) / 86400",
        unitKind: "count",
        displayUnit: "calls/s"
      },
      {
        id: "daily_inference_cost",
        label: "Inference cost / day",
        expression:
          "queries_per_day * (1 - cache_hit_ratio) * prompt_tokens_per_query * cost_per_million_tokens / 1000000",
        unitKind: "currency",
        displayUnit: "USD/day"
      },
      {
        id: "vector_reads_per_sec",
        label: "Vector index reads / sec",
        expression: "queries_per_day * retrieved_chunks_per_query / 86400",
        unitKind: "count",
        displayUnit: "reads/s"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Seven phases. Two things I will not let pass: permission enforcement at query time, and a cost model you can defend. Retrieval quality is the third.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope it. **Interact with:** **Problem** tab — note the permission constraints; there are two of them and they are the sharpest thing here. **Interviewer** tab — ask me about corpus size and churn rate, whether answers must be citable, what happens when nothing relevant is found, and who owns the authorization model."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 420,
        candidateGuide:
          "Size the index and the bill. **Interact with:** **Estimation** tab — fill every field, then read total chunks, index size, and daily inference cost. **Interviewer** tab — say the cost number out loud and tell me what you would change first to halve it. Also note how low queries per second is; that should shape your priorities."
      },
      {
        id: "ingestion",
        label: "Ingestion and indexing",
        durationSec: 540,
        candidateGuide:
          "Design the write path. **Interact with:** **Board** — connectors, chunking strategy, embedding jobs, the vector store, and the incremental update path when a document changes. **Interviewer** tab — tell me your chunking approach and what it costs you at retrieval time, plus how a deleted document leaves the index. Use **Tutor** for chunking or embedding concepts, then commit to an approach."
      },
      {
        id: "retrieval",
        label: "Retrieval and ranking",
        durationSec: 600,
        candidateGuide:
          "Design the read path. **Interact with:** **Board** — query embedding, candidate retrieval, any lexical component, reranking, and how the final context window is assembled. **Interviewer** tab — tell me how you would know retrieval is good, and what you do when the top results are all irrelevant. Name your recall trade-off if you use an approximate index."
      },
      {
        id: "permissions",
        label: "Permissions",
        durationSec: 540,
        candidateGuide:
          "The constraint that fails most designs. **Interact with:** **Board** — mark exactly where an authorization check happens, what it reads, and how it stays correct within 5 minutes of a permission change. Then mark how the answer cache is keyed. **Interviewer** tab — I will construct the case where a chunk was indexed while public and the document is now restricted. Walk me through why your design does not leak it."
      },
      {
        id: "serving_and_evals",
        label: "Serving, cost, and evals",
        durationSec: 600,
        candidateGuide:
          "Make it operable. **Interact with:** **Board** — the inference gateway: model routing, timeouts, fallback to a cheaper model, per-team budgets and attribution. Then the offline eval loop: a dataset, a scoring method, and what gates a prompt or model change. **Interviewer** tab — tell me what a user sees when the provider is failing, and how you would catch a quality regression before users do."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 420,
        candidateGuide:
          "Close it out. **Interact with:** **Board** — mark the trade-offs: retrieval recall against prompt cost, cache reuse against permission safety, answer quality against latency. **Interviewer** tab — summarise, then answer unprompted: what breaks first at 10x corpus size, and what would you log on every query to make a bad answer debuggable a week later? Then **Validate**, then **End interview**."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "query_time_authorization",
        text: "Permissions are enforced at query time against the live authorization source, not against metadata copied into the index.",
        dimension: "security",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "An authorization filter applied per retrieval using current permissions",
          "Index permission metadata treated as a hint at best"
        ],
        discoveryHints: [
          "A document was public when indexed and is restricted now. Is its chunk retrievable?",
          "Where do the permissions used in retrieval come from?"
        ],
        progressiveNudges: [
          "You indexed a chunk while its document was company-wide. It is now team-only. What happens on retrieval?",
          "If the index holds a copy of the ACL, how stale can that copy be?",
          "So what has to be consulted at query time for the answer to be safe?"
        ]
      },
      {
        id: "cache_scoped_to_requester",
        text: "The answer cache is keyed on the requester's access scope, so a cached answer cannot leak across users.",
        dimension: "security",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A cache key including the identity or permission set, not just the question text",
          "Recognition that identical questions can have different lawful answers"
        ],
        discoveryHints: [
          "Two people ask the same question with different access. Same cached answer?",
          "What is in your cache key?"
        ],
        progressiveNudges: [
          "An engineer asks a question and you cache the answer. Now a contractor asks the same words.",
          "If the key is the question text, what did you just serve them?",
          "What has to be in that key to make reuse safe, and what does that do to your hit rate?"
        ]
      },
      {
        id: "grounded_or_abstain",
        text: "Every claim cites a retrieved source, and the assistant abstains when retrieval finds nothing relevant.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Citations tied to specific retrieved chunks",
          "An explicit no-answer path when retrieval scores are poor"
        ],
        discoveryHints: [
          "What happens when nothing relevant is retrieved?",
          "What stops the model answering from its own weights?"
        ],
        progressiveNudges: [
          "Retrieval returns three irrelevant chunks. What does the user get?",
          "Does the model still answer? What would it be answering from?",
              "What signal do you use to decide to abstain instead?"
        ]
      },
      {
        id: "provider_degradation",
        text: "A slow or failing model provider degrades the experience deliberately rather than failing outright.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "Timeouts plus fallback to a cheaper or alternate model",
          "A stated user-visible behaviour during degradation"
        ],
        discoveryHints: [
          "The provider starts timing out on a third of calls. What does a user see?",
          "Is there a second model in this design?"
        ],
        progressiveNudges: [
          "A third of your inference calls are timing out. What happens to those requests?",
          "Do you retry, fall back, or fail? Pick and say why.",
          "If you fall back to a weaker model, how does the user know the answer is degraded?"
        ]
      },
      {
        id: "index_freshness_pipeline",
        text: "Document edits reach retrieval within the stated window via incremental updates, and deletes remove chunks.",
        dimension: "consistency",
        importance: "core",
        satisfiedBy: [
          "An incremental ingestion path triggered by document change events",
          "A delete path that removes chunks rather than orphaning them"
        ]
      },
      {
        id: "index_and_cost_math",
        text: "Vector index size and daily inference cost are both computed, and the cost driver identified.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Total chunks times embedding bytes stated as a number",
          "Daily spend derived from queries, prompt tokens, and price per token"
        ],
        discoveryHints: [
          "How large is the vector index?",
          "What does a day of queries cost?"
        ],
        progressiveNudges: [
          "How many chunks, and how many bytes each?",
          "Now the bill: queries times prompt tokens times price.",
          "Which of those factors would you attack first to halve it?"
        ]
      },
      {
        id: "chunking_strategy",
        text: "Chunking is a stated strategy with a named cost at retrieval time, not an arbitrary token split.",
        dimension: "requirements",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Chunk size and overlap chosen with a reason",
          "Recognition that small chunks improve precision but lose context"
        ],
        discoveryHints: [
          "How do you split a document, and why that way?",
          "What does a chunk that is too small cost you?"
        ],
        progressiveNudges: [
          "What is your chunk size?",
          "What happens to an answer whose evidence spans a chunk boundary?",
          "So what does overlap buy, and what does it cost in index size?"
        ]
      },
      {
        id: "latency_budget_breakdown",
        text: "The 5-second budget is broken into retrieval, reranking, and generation, with the dominant term named.",
        dimension: "latencyPerformance",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Per-stage latency estimates that sum within budget",
          "Generation identified as the dominant cost"
        ],
        discoveryHints: [
          "Where does the 5 seconds actually go?",
          "Which stage dominates?"
        ],
        progressiveNudges: [
          "Break the 5-second budget into stages.",
          "Which one is largest, and by how much?",
          "Given queries per second is tiny, is throughput or latency your real problem?"
        ]
      },
      {
        id: "per_team_budget_attribution",
        text: "Inference spend is attributed per team and one team cannot exhaust the global budget.",
        dimension: "cost",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "Per-team accounting on the inference gateway",
          "Quotas or rate limits that bound one team's spend"
        ],
        discoveryHints: [
          "One team writes a script that asks 100,000 questions overnight. What happens?",
          "How do you know which team spent what?"
        ],
        progressiveNudges: [
          "A team automates queries and burns the monthly budget in a night. Who stops them?",
          "Is spend attributable per team at all?",
          "What is the enforcement — a quota, a rate limit, or a hard cutoff?"
        ]
      },
      {
        id: "offline_eval_gate",
        text: "There is an offline evaluation set and a scoring method that gates prompt or model changes.",
        dimension: "operability",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A labelled question set with a retrieval and answer metric",
          "A gate in the release path for prompt or model changes"
        ],
        discoveryHints: [
          "How would you know a prompt change made answers worse?",
          "What runs before a model upgrade ships?"
        ],
        progressiveNudges: [
          "You swap the model for a newer one. How do you know quality did not regress?",
          "Is there a dataset you can score against?",
          "What metric, and what threshold blocks the release?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "permission_safety",
          label: "Permission safety",
          phaseRefs: ["permissions"],
          criterionRefs: ["query_time_authorization", "cache_scoped_to_requester"],
          sampleQuestions: [
            "A chunk was indexed while its document was public. The document is now restricted. What happens on retrieval?",
            "Two users with different access ask the identical question. What does your cache do?"
          ],
          progressiveNudges: [
            "Where do the permissions used at retrieval come from?",
            "How stale can that copy be, and what is the 5-minute constraint asking for?",
            "Now the cache key — what makes reuse safe across users?"
          ],
          greenFlags: [
            "Filters against live authorization at query time",
            "Includes access scope in the cache key and accepts the hit-rate cost"
          ],
          redFlags: [
            "Stores ACLs in the vector index and trusts them",
            "Caches on question text alone"
          ]
        },
        {
          id: "retrieval_quality",
          label: "Retrieval quality",
          phaseRefs: ["ingestion", "retrieval"],
          criterionRefs: ["chunking_strategy", "grounded_or_abstain", "index_freshness_pipeline"],
          sampleQuestions: [
            "What is your chunk size, and what happens when evidence spans a boundary?",
            "Retrieval returns three irrelevant chunks. What does the user get?"
          ],
          progressiveNudges: [
            "How are documents split?",
            "What does overlap buy you, and what does it cost?",
            "And when retrieval is bad, what makes the system abstain rather than improvise?"
          ],
          greenFlags: [
            "Justifies chunk size and overlap against retrieval precision",
            "Has an explicit abstain path with a score threshold"
          ],
          redFlags: [
            "Fixed token split with no rationale",
            "Always answers, citing whatever came back"
          ]
        },
        {
          id: "cost_and_latency",
          label: "Cost and latency",
          phaseRefs: ["estimate", "serving_and_evals"],
          criterionRefs: [
            "index_and_cost_math",
            "latency_budget_breakdown",
            "per_team_budget_attribution"
          ],
          sampleQuestions: [
            "What does a day of queries cost, and what would you change first to halve it?",
            "One team scripts 100,000 questions overnight. What happens?"
          ],
          progressiveNudges: [
            "Compute daily inference spend from queries, tokens, and price.",
            "Now break the 5-second budget into stages — which dominates?",
            "And who stops one team consuming the whole budget?"
          ],
          greenFlags: [
            "Notices queries per second is tiny, so latency not throughput is the problem",
            "Attributes spend per team with an enforced quota"
          ],
          redFlags: [
            "Treats inference cost as an afterthought",
            "Scales for throughput that does not exist"
          ]
        },
        {
          id: "reliability_and_quality_gates",
          label: "Provider failure and evals",
          phaseRefs: ["serving_and_evals", "wrap_up"],
          criterionRefs: ["provider_degradation", "offline_eval_gate"],
          sampleQuestions: [
            "The provider times out on a third of calls. What does a user experience?",
            "You upgrade the model. How do you know quality did not regress?"
          ],
          progressiveNudges: [
            "Do you retry, fall back, or fail?",
            "If you fall back to a weaker model, does the user know?",
            "And what dataset and metric would block a bad prompt change from shipping?"
          ],
          greenFlags: [
            "Timeouts plus a named fallback model and a user-visible signal",
            "A scored eval set gating releases"
          ],
          redFlags: [
            "Unbounded retries against a failing provider",
            "No way to detect a quality regression before users complain"
          ]
        }
      ],
      scoreRubric: {
        "1": "Describes embed-retrieve-generate with no permission model, no cost awareness, and no behaviour when retrieval or the provider fails.",
        "2": "Has a working pipeline with chunking and a vector store, but permissions live in the index, the cache is keyed on the question, and cost is unexamined.",
        "3": "Enforces authorization at query time, scopes the cache to the requester, abstains when ungrounded, keeps the index fresh, and computes the bill.",
        "4": "Also breaks down the latency budget, attributes and bounds spend per team, degrades deliberately when the provider fails, and gates changes on a scored eval set."
      }
    }
  }
});
