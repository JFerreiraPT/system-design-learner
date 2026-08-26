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
  }
});
