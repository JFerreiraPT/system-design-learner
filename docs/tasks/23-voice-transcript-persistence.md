# 23 · Persist voice turns into the existing transcript

**Area:** Voice · **Priority:** P1 · **Size:** M · **Depends on:** 20
**Labels:** `agent-ready`, `voice`, `api`, `web`, `db`

> **Status: DONE.** Migration `0014_voice_turns` adds `source` / `external_id` plus the
> partial unique index, and `interviews.voice_seconds`. `persistAssistantTurn` is the single
> implementation of the post-turn pipeline; `saveAssistantMessage` is now a thin wrapper, so
> the interview controller is untouched. `turnBuffer.ts` emits the longest complete prefix in
> conversation order — tested against a transcript completing *after* its reply, a
> transcript that never completes, and four turns finishing in scrambled order.
> A replay is asserted to run the post-turn pipeline **zero** extra times, by counting
> matcher invocations rather than rows. **`pnpm db:push` is required.**
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

With voice on WebRTC, audio flows browser ↔ OpenAI and **the server sees nothing**.
Every downstream feature reads `interview_messages`:

- `detectDiscoveries` (`interview.service.ts:1138`) — the criterion matcher that
  drives the whole rubric-discovery mechanism
- `deriveConstraintProposals` (`:1240`)
- `detectPhaseTransition` (`:941`)
- `end()` (`:453`) — the debrief, which is graded output
- `getTutorUsage`, the fifteen-section markdown export, `listMessages`

A voice interview that writes nothing to that table produces an empty debrief, a
rubric where nothing is ever discovered, and an export with no transcript. Voice
would look like it works and silently destroy every graded artefact in the
product.

## Desired behaviour

The client posts each completed turn back; the server persists it and runs the
**same** post-turn pipeline the text path runs. Voice and text turns must be
indistinguishable to everything downstream — one transcript, mixed modalities, in
order.

### Schema

Two columns on `interview_messages`, both nullable so every existing row stays
valid:

| column | purpose |
|---|---|
| `source` (text, null) | `"voice"` on realtime turns. Null means text — do not backfill. |
| `external_id` (text, null) | The realtime item id. The idempotency key. |

Plus a **unique index on `(interview_id, external_id)`** where `external_id` is
not null. This is not belt-and-braces: reconnects, retries and React strict-mode
double-effects will all re-post the same turn, and a duplicated candidate answer
skews the debrief and double-counts discoveries.

### `POST /interviews/:id/voice/turns`

Accepts one or more turns:

```ts
{ turns: [{ externalId: string, role: "user" | "assistant", content: string, phase?: PhaseRuntimeInfo }] }
```

1. 409 if the interview is not `active` — same guard, same reason as `sendMessage`.
2. Insert with `ON CONFLICT (interview_id, external_id) DO NOTHING`, so a replay
   is a cheap no-op rather than an error the client has to interpret.
3. For a newly inserted **assistant** turn, run the existing post-turn jobs.
   Reuse `saveAssistantMessage`'s body — do not copy it. Its ordering comment
   (`interview.service.ts:889-895`) documents a real dependency chain: discovery
   promotes criteria to live constraints before proposals run, and the transition
   rule reads `discoveredVia` so it must run last. Voice must not reinvent that
   ordering and get it wrong.
4. Skip the pipeline for a conflict, or the same turn re-posted would run
   discovery twice.

Refactor `saveAssistantMessage` into `persistAssistantTurn(opts)` taking the
optional `source`/`externalId`, with the existing signature kept as a thin
wrapper so the controller (`interview.controller.ts:63`) is untouched.

### Ordering

`conversation.item.input_audio_transcription.completed` fires **asynchronously**
with respect to response events — the docs are explicit that it "can come before
or after the response events". So the interviewer's reply can arrive before the
transcript of the question it answered.

Do not persist on arrival. Buffer by item, and flush a `(user, assistant)` pair
once both are complete, ordering by the realtime conversation order rather than
by wall-clock arrival. Otherwise the stored transcript reads as the interviewer
answering a question the candidate had not yet asked, and the debrief is graded
against that.

A user turn whose transcript never completes (transcription failure) still gets
persisted, with content `"[inaudible]"` — a gap in the transcript is far better
than a dropped turn, because `detectDiscoveries` reads assistant turns and would
otherwise credit discoveries to a question that appears out of nowhere.

### Failure isolation

Persistence must never break the conversation. A failed post is retried with
backoff, queued in memory, and flushed on the next successful call or on session
end. If the queue cannot be drained, warn the candidate **explicitly** that the
tail of the session is not recorded — silently losing graded transcript is the
worst outcome available.

### Trust

The client is the only witness to the audio, so it is trusted for the transcript.
That is consistent with the existing model: phase events
(`POST /interviews/:id/phase-events`) and scene summaries are already
client-asserted. Note it in the PR; do not build server-side verification.

## Files to touch

- `apps/api/src/db/schema.ts` + migration (idempotent SQL + manual `meta/_journal.json` entry, matching `0005`–`0013`)
- `apps/api/src/interview/interview.service.ts` — `persistAssistantTurn`
- `apps/api/src/voice/voice.controller.ts`, `voice.service.ts`, `voice.dto.ts`
- `apps/web/src/lib/voice/turnBuffer.ts` + `turnBuffer.test.ts` (new)
- `apps/web/src/lib/api.ts`
- `packages/shared/src/index.ts` — `VoiceTurnSchema`

## Acceptance criteria

- [ ] A voice interview produces `interview_messages` rows indistinguishable from text rows to `listMessages`, `end()`, the export and the criteria matcher.
- [ ] Re-posting the same `externalId` inserts nothing and runs the post-turn pipeline **zero** extra times — asserted by counting matcher invocations, not just row counts.
- [ ] The unique index exists and the migration is idempotent (`CREATE UNIQUE INDEX IF NOT EXISTS`), re-runnable against a populated database.
- [ ] Existing rows with `source`/`external_id` NULL are untouched and still parse everywhere.
- [ ] `detectDiscoveries`, `deriveConstraintProposals` and `detectPhaseTransition` run for voice assistant turns, in that order — asserted, since the ordering encodes a real dependency.
- [ ] The turn buffer is a pure, unit-tested reducer, covering: transcript completing **after** the response, transcript never completing, and two rapid turns arriving interleaved.
- [ ] A `409` from a completed interview stops the client posting further turns and surfaces the same message the text path uses.
- [ ] Post failures retry, queue, and produce a visible warning when undrained.
- [ ] Ending a voice interview yields a debrief whose transcript is complete — asserted end-to-end with a faked event sequence.
- [ ] `pnpm -w lint`, `pnpm -w turbo run typecheck`, `pnpm -w turbo run test` pass.

## Out of scope

- Storing audio. Text transcripts only — recordings are a privacy and storage question this task does not open.
- Server-side transcript verification.
- Per-word timings or speaker-overlap metadata.
