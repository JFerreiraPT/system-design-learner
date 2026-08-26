# Architecture

System Design Learner is a single-user web app for practicing system design with an Excalidraw whiteboard, an AI problem generator, AI solution validation, an AI interviewer, and a tutor chat.

This document describes the runtime architecture, data model, request flows, and caching strategy.

## High-level diagram

```text
                ┌──────────────────────────────────────┐
                │           Browser (React)            │
                │  Excalidraw board · chat · dashboard │
                └──────────────┬───────────────────────┘
                               │ HTTP + SSE (axios, AI SDK)
                               ▼
                ┌──────────────────────────────────────┐
                │        NestJS API  (port 3001)       │
                │  problems · solutions · interview ·  │
                │  tutor · ai · db · redis             │
                └─────┬───────────┬───────────────┬────┘
                      │           │               │
                      ▼           ▼               ▼
              PostgreSQL 16    Redis 7      OpenAI API
              (Drizzle ORM)    (cache)      (Vercel AI SDK)
```

## Monorepo layout

Driven by `pnpm-workspace.yaml` and Turborepo (`turbo.json`).

| Path | Package | Description |
|---|---|---|
| `apps/web` | `@sdl/web` | React 19 + Vite + Tailwind + shadcn/ui frontend |
| `apps/api` | `@sdl/api` | NestJS 11 backend |
| `packages/shared` | `@sdl/shared` | Shared TypeScript types and Zod schemas |
| `packages/ai-prompts` | `@sdl/ai-prompts` | Prompt templates / vocabularies for OpenAI |
| `infra/` | — | `docker-compose.yml`, `api.Dockerfile`, `web.Dockerfile` |

Turbo orchestrates `dev`, `build`, `lint`, and Drizzle DB tasks (`db:generate`, `db:migrate`, `db:push`).

## Frontend (`apps/web`)

- **Framework:** React 19 + Vite + TypeScript, Tailwind + shadcn/ui
- **Whiteboard:** `@excalidraw/excalidraw`
- **Routing:** `react-router-dom` v7
- **Server state:** `@tanstack/react-query` (in-memory cache of REST responses)
- **Client state:** `zustand` (`apps/web/src/lib/store.ts`)
- **HTTP:** `axios` instance in `apps/web/src/lib/api.ts`
- **Streaming chat:** `@ai-sdk/react` (SSE) for interviewer/tutor chat
- **Voice:** `RTCPeerConnection` straight to the OpenAI Realtime API — audio never transits
  this app's API, which is why spoken turns are posted back separately for persistence

### Pages

- `DashboardPage.tsx` — list problems, generate new ones
- `WorkspacePage.tsx` — main practice surface (board + chat + estimation + phase ribbon)
- `TutorPage.tsx` — standalone tutor chat

### Key components

- `Board.tsx` — Excalidraw scene
- `TranscriptView.tsx` — conversation rendering + scroll behaviour, shared by text and voice
- `ChatPanel.tsx` — the typed composer + SSE send loop, rendered through `TranscriptView`
  (read-only once the interview ends)
- `VoicePanel.tsx` — Text/Voice toggle for the Interview tab; both modalities share ONE
  transcript, and the composer stays live during a voice session because mixed input
  ("the id looks like this" → typed) is the realistic mode, not a fallback
- `VoiceBar.tsx` — connection + turn state, mic level, Hold to think, Go ahead, spend meter
- `PhaseRibbon.tsx` — phase progress + the candidate-confirmed "ready to move on?" banner
- `EstimationPanel.tsx`, `DimensionBreakdown.tsx`
- `CriteriaReveal.tsx` — post-validate rubric reveal, paired with the reference's coverage lines
- `FlagsPanel.tsx`, `ProcessPanel.tsx` — observed signals and how the candidate worked (reported, never scored)
- `InterviewDebrief.tsx` — the written close-out for a completed interview
- `WorkspaceProblemRail.tsx`, `TrackBadge.tsx`, `ConfirmDialog.tsx`

### Key client libs

- `lib/exportReport.ts` — the exported debrief, one formatter per section; every optional
  section returns `null` and is dropped, so an attempt with no interview still yields a
  valid document
- `lib/phaseEvents.ts` — fire-and-forget pacing telemetry (never surfaces an error)
- `lib/constraintPills.ts` — tolerates a `discoveredFromCriterionId` left dangling by a
  rubric regeneration
- `lib/voice/` — the spoken interview. `useRealtimeVoice.ts` owns the WebRTC session;
  everything genuinely tricky is a pure module beside it, because a live WebRTC connection
  cannot be unit tested:
  - `turnState.ts` — whose turn it is. Its load-bearing rule: `speech_stopped` does **not**
    end a turn, because under semantic VAD speech stops and resumes inside one turn all the
    time (the candidate is drawing, or thinking)
  - `turnBuffer.ts` — orders and pairs turns before persistence. Transcription completes
    asynchronously with respect to response generation, so the interviewer's reply routinely
    arrives before the transcript of the question it answered
  - `contextFeed.ts` — pushes board deltas into a live session, debounced and never
    mid-sentence
  - `noiseGate.ts` — gates the microphone before the model ever hears it.
    `semantic_vad` decides *when a turn ends*, never *whether a sound was
    speech*, so a chair scrape or a pet opens a turn and the interviewer answers
    a noise. Rejects transients by minimum duration rather than loudness alone
    (a thud is louder than speech and shorter), with hysteresis so word gaps do
    not chop sentences and lookahead so the gate opens before the first syllable
  - `costMeter.ts` — elapsed time and estimated spend

## Backend (`apps/api`)

NestJS 11 application. `src/main.ts` bootstraps with CORS enabled, listens on port `3001`, and registers a global `ZodValidationPipe`.

### Modules (registered in `app.module.ts`)

| Module | Path | Responsibility |
|---|---|---|
| `DbModule` | `src/db` | Drizzle ORM + `pg` Pool, exposes `DB` injection token |
| `RedisModule` | `src/redis` | `ioredis` client, exposes `REDIS` injection token (`@Global`) |
| `AiModule` | `src/ai` | OpenAI integration via `@ai-sdk/openai` + `ai` SDK |
| `ProblemsModule` | `src/problems` | Problem generation, listing, reference solutions, backfills |
| `SolutionsModule` | `src/solutions` | Save and score user solutions |
| `InterviewModule` | `src/interview` | Interview sessions and streamed messages |
| `TutorModule` | `src/tutor` | Tutor sessions and streamed messages |
| `VoiceModule` | `src/voice` | Mints realtime credentials and records spoken turns |

### REST surface

```text
GET   /health

POST  /problems/generate                        { difficulty, topic?, track? }
POST  /problems/backfill-tags
POST  /problems/backfill-tracks
POST  /problems/backfill-narrative              ?force=true
POST  /problems/backfill-estimation-specs       ?force=true
POST  /problems/backfill-interview-plans
GET   /problems
GET   /problems/:id
GET   /problems/:id/reference                   ?interviewId=  (interview-scoped answer)

POST  /solutions
GET   /solutions

POST  /interviews
POST  /interviews/backfill-criteria
PATCH /interviews/:id                           { interviewerLevel, regenerateCriteria? }
POST  /interviews/:id/messages                  (SSE stream; 409 once completed)
GET   /interviews/:id/messages
GET   /interviews/:id/status                    lifecycle + stored debrief + rubricStale
POST  /interviews/:id/end                       completes + persists the debrief (idempotent)
GET   /interviews/:id/constraints
POST  /interviews/:id/constraints
DELETE /interviews/:id/constraints/:constraintId
POST  /interviews/:id/proposals/:proposalId/apply
POST  /interviews/:id/proposals/:proposalId/dismiss
GET   /interviews/:id/tutor-usage
GET   /interviews/:id/phase-proposal
POST  /interviews/:id/phase-proposal/apply
POST  /interviews/:id/phase-proposal/dismiss
POST  /interviews/:id/phase-events              fire-and-forget pacing telemetry
GET   /interviews/:id/phase-timeline            per-phase actual vs budget
GET   /interviews/:id/criteria                  progress only (no hidden text)
GET   /interviews/:id/criteria/reveal           gated on >= 1 validation
POST  /interviews/:id/criteria/regenerate

POST  /interviews/:id/voice/session             mint an ephemeral realtime credential
                                                (instructions baked in server-side and
                                                 NEVER returned — they carry the hidden rubric)
POST  /interviews/:id/voice/turns               { turns[], audioSecondsTotal? }
                                                idempotent on turns[].externalId

POST  /tutor/sessions                           { title?, interviewId? }
GET   /tutor/sessions
GET   /tutor/sessions/:id/messages
POST  /tutor/sessions/:id/messages              (SSE stream)
```

### AI integration (`apps/api/src/ai/ai.service.ts`)

Single integration point with OpenAI; all prompts live in `@sdl/ai-prompts`.

Model ids are **never** literals in the service. `apps/api/src/ai/ai.models.ts` owns the
purpose → model map, with an env override per purpose; the table below references the
config key so it cannot drift from the code. Defaults and the reasoning behind the tiering
live in that file.

| Method | Model config key | Purpose |
|---|---|---|
| `generateProblem` | `problemGeneration` (`AI_MODEL_PROBLEM`) | Full problem: statement, constraints, tags, narrative (framing / signature challenge / stall ladder), estimation spec, interview plan |
| `generateCriteria` | `criteriaGeneration` (`AI_MODEL_CRITERIA`) | Per-interview rubric + private interviewer playbook |
| `validateSolution` | `validation` (`AI_MODEL_VALIDATION`) | Per-criterion judgement, dimension bars, flag observations, process assessment (multimodal) |
| `generateReference` | `reference` (`AI_MODEL_REFERENCE`) | Reference answer; interview-scoped when given the rubric |
| `generateDebrief` | `debrief` (`AI_MODEL_DEBRIEF`) | End-of-interview written debrief |
| `streamInterviewer` | `interviewerChat` (`AI_MODEL_INTERVIEWER`) | Streamed interviewer chat (SSE), multimodal |
| `streamTutor` | `tutorChat` (`AI_MODEL_TUTOR`) | Streamed tutor chat (SSE), multimodal |
| `matchCriteriaDiscovery` | `discoveryMatch` (`AI_MODEL_DISCOVERY`) | Per-turn conservative discovery matcher |
| `extractConstraintProposals` | `proposals` (`AI_MODEL_PROPOSALS`) | Per-turn conservative scope-change extraction |
| `inferTags` / `inferTrack` / `inferEstimationSpec` / `inferInterviewPlan` / `inferProblemNarrative` / `summariseTutorTopics` | `backfill` (`AI_MODEL_BACKFILL`) | One-off column backfills and cached summaries |

Generation quality is the highest-leverage spend: the problem and the rubric are what the
interviewer's coaching, the discovery loop, validation and the debrief are all built on, so
they default to the stronger tier while the per-turn matchers stay cheap.

`generateObject` is used with Zod schemas to guarantee structured output; `streamText` powers the chat endpoints.

Phase-transition detection is deliberately **not** an AI call — `evaluatePhaseTransition`
(`packages/shared`) is a pure rule over data already in hand, and it runs on every
interviewer turn.

## Data layer

### PostgreSQL 16 (Drizzle ORM)

Schema lives in `apps/api/src/db/schema.ts`. Migrations are tracked in `apps/api/drizzle/`.

#### Tables

**`problems`**
- `id` (uuid, pk), `title`, `statement`, `difficulty`
- `constraints_json` (jsonb, `string[]`)
- `evaluation_rubric_json` (jsonb, `string[]`)
- `tags_json` (jsonb, `string[] | null`)
- `track` (text, nullable) — role archetype (`TrackSchema`); `NULL` = unspecified
- `reference_json` (jsonb) — lazily filled generic reference solution
- `estimation_spec_json` (jsonb) — per-problem back-of-envelope field spec
- `interview_plan_json` (jsonb) — per-problem ordered interview phases
- `narrative_json` (jsonb) — `{ framingScript?, signatureChallenge?, progressiveReveals? }`.
  `signatureChallenge` is **interviewer-private** and must never reach the candidate UI.
- `generated_by_ai` (bool), `created_at` (timestamptz)

**`solutions`**
- `id` (uuid, pk), `problem_id` → `problems.id`
- `scene_json` (text, Excalidraw scene), `notes` (text)
- `score` (int), `feedback_json` (jsonb), `estimation_json` (jsonb)
- `created_at`

> The PNG screenshot is sent to the AI for validation but **not** persisted; the diagram can always be re-rendered from `scene_json`. The legacy `image_b64` column was dropped.

**`interviews`**
- `id` (uuid, pk), `problem_id` → `problems.id`
- `interviewer_level`, `status` (`active` → `completed` via `POST /interviews/:id/end`)
- `live_constraints_json` (jsonb) — evolving scope; soft-removals preserved
- `pending_proposals_json` (jsonb) — AI scope-change proposals awaiting Apply / Dismiss
- `criteria_json` (jsonb) — `{ criteria, playbook }` for this interview
- `criteria_level` (text, nullable) — level the rubric was generated FOR; `NULL` = unknown,
  which reports `rubricStale: false`
- `pending_phase_proposal_json` (jsonb) — `{ pending, resolvedPhaseIds }` for the single
  live "ready to move on?" offer
- `reference_json` (jsonb) — interview-scoped reference answer (kept separate from the
  per-problem cache, since rubrics differ per level)
- `debrief_json` (jsonb) — written close-out, generated once
- `voice_seconds` (integer, default 0) — accumulated realtime audio for this interview.
  Persisted rather than tracked client-side so the session ceiling survives a reload; a
  ceiling reset by pressing F5 is decoration
- `started_at`, `ended_at`

**`interview_phase_events`** (append-only pacing telemetry)
- `id` (uuid, pk), `interview_id` → `interviews.id`
- `phase_id`, `phase_index`, `kind` (`enter` | `exit` | `reset`)
- `elapsed_sec` (int) — client-reported, clamped server-side to `[0, 86400]`
- `at` (timestamptz); index on `(interview_id, at)`

> The live timer stays in the browser (`localStorage`) — it is pausable and client-owned.
> This table exists so pacing is *observable* afterwards; reduce it with
> `buildPhaseTimeline` from `@sdl/shared`.

**`interview_messages`**
- `id` (uuid, pk), `interview_id` → `interviews.id`
- `role`, `content`, `created_at`
- `source` (text, nullable) — `'voice'` on spoken turns; `NULL` = text, which is every row
  written before voice existed and is deliberately not backfilled. Provenance only; nothing
  downstream branches on it
- `external_id` (text, nullable) — the realtime conversation item id, and the idempotency
  key. Unique index on `(interview_id, external_id) WHERE external_id IS NOT NULL`: a
  re-post is a no-op, because reconnects and retries replay turns and a duplicated answer
  would skew the debrief and double-count discoveries

**`tutor_sessions`**
- `id` (uuid, pk), `title` (default `"Tutor Session"`)
- `interview_id` (uuid, nullable) → `interviews.id` — set when the session was opened from
  a workspace with a live interview; `NULL` for standalone tutor use
- `topics_json` (jsonb, nullable) — cached topic labels, summarised at most once per session
- `created_at`

> Tutor usage is **reported, never penalised**: no score reads it, and the tutor is never
> gated during an interview.

**`tutor_messages`**
- `id` (uuid, pk), `session_id` → `tutor_sessions.id`
- `role`, `content`, `created_at`

#### Relationships

```text
problems 1───* solutions
problems 1───* interviews 1───* interview_messages
                         1───* interview_phase_events
                         1───* tutor_sessions (nullable link)
tutor_sessions 1───* tutor_messages
```

#### Migrations

Managed by `drizzle-kit`:

- `pnpm db:generate` — diff schema → SQL
- `pnpm db:push` — apply schema directly (dev)
- `pnpm db:migrate` — apply tracked migrations

Migrations from `0001` onward are **hand-written idempotent SQL** (`ADD COLUMN IF NOT
EXISTS`, `CREATE TABLE IF NOT EXISTS`) with a manual `meta/_journal.json` entry, because
only `0000` has a drizzle snapshot — running `db:generate` would diff against that and
re-emit everything since. Follow the existing files rather than generating, and never
backfill destructively: legacy rows stay `NULL` and services must tolerate it.

### Redis 7

Wired in `apps/api/src/redis/redis.module.ts` as a `@Global` provider exposing the `REDIS` token. Used today only by `ProblemsService`.

## Whiteboard pipeline

The Excalidraw board is the central artifact. Three things happen with it.

### 1. Scene projection (compact graph for LLMs)

`apps/web/src/lib/sceneProjection.ts` walks the raw Excalidraw scene and produces a compact `SceneSummary` (defined in `@sdl/shared`):

```text
{
  nodes: [{ id: "n0", label: "API Gateway", kind: "rectangle" }, …],
  edges: [{ from: "n0", to: "n3", label: "writes" }, …],
  summaryText: "5 components: ... 4 connections: API Gateway → Auth Service; …"
}
```

Why: raw Excalidraw scene JSON is huge (`appState`, `files`, version stamps, group ids…) and forces the model to reason about geometry. The projection is ~10–50× smaller and gives the model a clean nodes/edges graph instead of pixel coordinates.

The projection resolves text labels for shapes via three strategies in order:
1. text element with `containerId === shape.id`
2. text in `shape.boundElements`
3. nearest standalone text overlapping the shape's bbox

Edges come from `arrow` elements with `startBinding` / `endBinding`; arrow text labels propagate into `edges[].label`.

### 2. Lazy screenshot capture (resolution-capped)

`Board.tsx` no longer takes a screenshot on every Excalidraw `onChange`. It registers a `captureSceneImage()` function on the Zustand store; consumers (validate, chat send) call it on demand:

```ts
const imageBase64 = captureSceneImage ? await captureSceneImage() : undefined;
```

The capture runs `exportToBlob` with a `getDimensions` callback that clamps the longest side to 1280px before base64-encoding, so a busy board can't produce a multi-MB payload.

### 3. Server-side scene-diff per session

When the browser sends a message to the interviewer or tutor, it includes the latest `sceneSummary` (and optionally an `imageBase64`). On the API, `InterviewService` / `TutorService` compute a SHA-1 of the canonical `(nodes, edges)` and compare it to the previous turn's hash stored in Redis under `interview:<id>:sceneHash` / `tutor:<id>:sceneHash` (TTL 4h).

If the hash matches, `sceneUnchanged: true` is passed to `AiService`, which **omits the whiteboard description and image from the prompt for that turn**. This avoids re-sending hundreds to thousands of tokens of board context every chat turn when the candidate is just talking.


## Voice: spoken interviews

A system design interview is a spoken conversation held over a whiteboard. Voice is
**speech-to-speech** over the OpenAI Realtime API (`gpt-realtime-2.1`), opt-in per
interview, and it never gates anything: mic denied, no input device, connection failed, or
minting refused all leave a fully working text interview.

```text
browser ──audio(WebRTC)──> OpenAI Realtime ──audio──> browser
   │                              │
   │            data channel: transcripts, VAD events, context deltas
   ▼
POST /interviews/:id/voice/turns ──> interview_messages
                                     └─> the SAME post-turn pipeline as text:
                                         detectDiscoveries → deriveConstraintProposals
                                         → detectPhaseTransition
```

Four decisions carry the design.

**The hidden rubric never reaches the browser.** `buildInterviewerPrompt` embeds every
undiscovered hidden expectation verbatim, with its progressive nudges. So
`POST /interviews/:id/voice/session` builds the instructions server-side, bakes them into
an ephemeral credential (`POST /v1/realtime/client_secrets`), and returns only the
credential plus non-secret knobs. A browser that assembled its own session config could
read the whole hidden rubric out of devtools and `detectDiscoveries` would be measuring
nothing. A candidate can still overwrite the instructions via `session.update` — that is
self-sabotage, not a leak, and is out of scope.

**Noise is not speech.** Turn detection answers "has the turn ended", never "was
that a voice", and it has no loudness threshold at all — so furniture, a keyboard
or a cat opens a turn and the interviewer dutifully replies to it. Neither VAD
knob fixes this: more eagerness answers noise faster, and `server_vad`'s
threshold buys a gate at the cost of the semantic pause tolerance. So the
microphone is gated client-side before the model hears anything, keyed on
duration as much as level.

**Silence is the candidate thinking.** "So I'd put a queue here…" — eight seconds of
drawing — "…and the consumers are idempotent." That is *one* turn, and the API's default
500ms silence threshold cuts it in two. Turn detection is `semantic_vad` with
`eagerness: "low"`, which scores how *finished* the speech sounds and waits longer when it
trails off, plus an explicit **Hold to think** that disables the mic track locally.

**Barge-in requires truncation.** `interrupt_response: true` stops the audio, but the
assistant item still claims it said the whole sentence. Without `conversation.item.truncate`
the interviewer refers back to a question the candidate never heard — and it reads like a
prompt bug, not a transport bug.

**Persistence is load-bearing, not polish.** Audio flows browser ↔ OpenAI, so the server
sees nothing, and the debrief, the criterion matcher, `getTutorUsage` and the markdown
export all read `interview_messages`. Spoken turns are posted back and land in that same
table, indistinguishable to every consumer (`source = 'voice'` is provenance only). The
`(interview_id, external_id)` unique index makes a re-post a no-op: reconnects, retries and
strict-mode double-effects all replay turns, and a duplicated answer would skew the debrief
and double-count discoveries.

The client is the only witness to the audio, so it is trusted for the transcript — the same
trust model the phase-event log and scene summaries already use.

### Cost

Unlike every other AI call here, a voice session is bounded by nothing: it bills for as long
as its socket is open. Roughly $0.02 per minute heard and $0.08 per minute spoken, so a
45-minute interview lands near $2. Hence a persisted per-interview ceiling
(`interviews.voice_seconds`, so it survives a reload), an idle auto-close, and a visible
spend meter.

## Caching

Five places where caching happens.

### 1. Redis: generated problems (only when a topic is supplied)

Location: `apps/api/src/problems/problems.service.ts` in `generate()`.

- **Key:** `problem:<difficulty>:<topic-trimmed-lowercased>`
- **Value:** the full DB row of the inserted problem (JSON-stringified)
- **TTL:** 900 seconds (15 minutes), via `SET ... EX 900`
- **Trigger condition:** only when `topic` is provided. Topic-less generations skip the cache entirely (every call goes to OpenAI and inserts a new row).
- **Read path:** on cache hit, the cached row is returned without calling OpenAI and **without** inserting a new row in `problems`.
- **Write path:** on miss, OpenAI generates the problem, the row is inserted into `problems`, then the row is cached.
- **Invalidation:** TTL only.

> Caveat: because the topic is normalized but the difficulty is not, two consecutive `(difficulty, topic)` requests within 15 minutes return the **same** problem row.

### 2. Redis: per-session scene hash (interviewer / tutor)

- **Keys:** `interview:<id>:sceneHash`, `tutor:<id>:sceneHash`
- **Value:** SHA-1 of the compact `(nodes, edges)` projection
- **TTL:** 4 hours
- **Effect:** if the current turn's hash matches the stored one, the API skips re-sending the board description and PNG to the model.

### 3. Postgres: reference solutions (durable lazy cache)

- The first call to `GET /problems/:id/reference` (after at least one validation attempt exists) generates the reference via OpenAI and writes it to `problems.reference_json`.
- Subsequent calls short-circuit and return the stored JSON without calling OpenAI.
- No TTL — invalidated only by clearing the column.

### 4. Frontend: scene-unchanged validate guard

`WorkspacePage.tsx` keeps the `sceneJson` of the last successful validation in component state. The Validate button is disabled until the diagram changes, preventing accidental re-spend on identical multimodal calls.

### 5. Frontend: TanStack Query in-memory cache

Standard client-side cache for REST responses (problem list, problem detail, solutions list, etc.).

### What is **not** cached

- Validation results (`POST /solutions`) — every call goes to OpenAI and writes a new row.
- Interview and tutor messages — streamed every time; only the scene-hash is cached, not the response.
- Problem listings (`GET /problems`) and detail fetches — direct Postgres reads.
- The PNG screenshot — sent to OpenAI for validation but no longer persisted in Postgres.

The `Cache-Control: no-cache` headers on the SSE endpoints are about HTTP intermediaries, not Redis caching.

## Multimodal inputs

| Surface | PNG sent to OpenAI? | Scene representation in prompt | Model |
|---|---|---|---|
| Validation (`POST /solutions`) | Yes (always when scene non-empty) | Compact `sceneSummary` + notes + estimation digest | `validation` |
| Interviewer chat | Yes (when scene changed since last turn) | Compact `sceneSummary` (nodes / edges / summaryText) | `interviewerChat` |
| Tutor chat | Yes (when scene changed since last turn) | Compact `sceneSummary` | `tutorChat` |

The PNG is captured lazily by `Board.tsx` via `captureSceneImage()` on demand, scaled to a max of 1280px on the longest side before base64-encoding.

## End-to-end flow (typical session)

1. Open dashboard → `GET /problems` (Postgres).
2. Generate problem → `POST /problems/generate` →
   - if a topic is given and cached in Redis: return cached row;
   - else `AiService.generateProblem` (gpt-4o-mini) → insert into `problems` → cache in Redis (15 min) when topic was given.
3. Open workspace → load problem, draw on Excalidraw, fill the AI-generated estimation fields, optionally chat with the AI interviewer.
4. Interviewer/tutor chat:
   - Browser builds the payload: compact `sceneSummary` + (lazy) `imageBase64` + estimation + phase.
   - API hashes the scene; if unchanged from last turn, the board context + image are omitted to save tokens.
   - Tokens stream back via the Vercel AI SDK to `ChatPanel.tsx`.
   - Both user and assistant messages are persisted in `interview_messages` / `tutor_messages`.
5. Validate → `POST /solutions` with `scene_json` + notes + base64 board PNG → `AiService.validateSolution` (gpt-4o, multimodal) returns scored dimensions + feedback; persisted in `solutions`. The PNG is **not** persisted. The Validate button is then disabled until the diagram is edited.
6. Reference solution → `GET /problems/:id/reference` → returns `problems.reference_json` if present; otherwise generates with `gpt-4o`, stores it on the row, then returns it. Requires at least one prior validation attempt for that problem.

## Infrastructure (`infra/`)

`docker-compose.yml` defines four services:

| Service | Image / Build | Ports | Notes |
|---|---|---|---|
| `postgres` | `postgres:16` | `${POSTGRES_PORT:-5433}:5432` | Volume `postgres_data` |
| `redis` | `redis:7` | `${REDIS_PORT:-6380}:6379` | Volume `redis_data` |
| `api` | `infra/api.Dockerfile` | `3001:3001` | Runs `pnpm db:migrate && pnpm --filter @sdl/api dev`; depends on `postgres` + `redis` |
| `web` | `infra/web.Dockerfile` | `5173:5173` | Vite dev server; depends on `api` |

### Environment variables (`.env`)

- `OPENAI_API_KEY`
- `DATABASE_URL` (e.g. `postgresql://sdl:sdl@postgres:5432/sdl`)
- `REDIS_URL` (e.g. `redis://redis:6379`)
- `POSTGRES_PORT`, `REDIS_PORT` — host port overrides for local conflicts
- Per-purpose model overrides and the voice knobs (`AI_MODEL_*`, `AI_VOICE_NAME`,
  `VOICE_TURN_DETECTION`, `VOICE_VAD_EAGERNESS`, `VOICE_MAX_SESSION_MINUTES`,
  `VOICE_IDLE_TIMEOUT_SECONDS`) — all documented in `.env.example`, all falling back to a
  documented default rather than throwing, because a typo in `.env` must not take the API down

## Notes and possible extensions

- Redis is currently underused — it could also cache problem listings, gate AI calls with rate limiting, or stash interview transcripts for resume.
- The cache key for problem generation is per `(difficulty, topic)`; if you want multiple distinct problems for the same topic, either include a nonce in the topic, drop the cache, or wait out the 15-minute TTL.
- There is no auth layer — the app is designed for single-user local use.
