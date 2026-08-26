# 24 · Feed the live whiteboard into a voice conversation

**Area:** Voice · **Priority:** P2 · **Size:** M · **Depends on:** 20
**Labels:** `agent-ready`, `voice`, `web`, `api`

> **Status: DONE, plus a gap found in real use.** The delta feed was built as
> specified, but the *mint* was being handed the feed's own snapshot shape
> (`{ scene, constraints, phaseLabel }`) — whose unknown keys `workspaceContextSchema`
> strips — so a voice session opened with no board, no estimation, no checklist
> and no phase, and the spoken interviewer could not challenge a number it had
> never seen. The mint now sends the full workspace context (minus the
> screenshot: realtime reads the board as text), and estimation changes are
> pushed mid-session as named `field = value` deltas. Both are asserted with
> sentinel strings.
>
> `contextFeed.ts` diffs against the last *sent* snapshot and injects a
> `system` item over the data channel, prefixed with `VOICE_CONTEXT_ITEM_PREFIX` so
> `TurnBuffer.drain` filters it out of the transcript, the debrief and `interview_messages`
> in one place. Fifty rapid scene mutations are asserted to produce exactly one injection;
> nothing is sent while `candidateSpeaking`; scope and phase changes bypass the rate limit.
> Constraints come from the server's live set, never client state.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

In the text path, every message carries a fresh snapshot of the workspace:
`buildPayload` (`WorkspacePage.tsx:988`) attaches `workspaceContext` — scene
summary, phase, constraints — and `sendMessage` folds it into the prompt, even
comparing scene hashes so the interviewer knows whether the board changed since
last turn (`markAndCompareSceneHash`, `interview.service.ts:1311`). The
hard/staff drilling rule depends on this: *"Parse sceneJson. Identify ONE
component the candidate has visibly drawn…"* (`ai-prompts/src/index.ts:1324`).

A realtime session gets its instructions **once**, at mint time. Ten minutes in,
the candidate has drawn the entire architecture and the interviewer is still
reasoning about an empty canvas. The single most distinctive thing about this
product — an interviewer that can see your whiteboard — stops working precisely
when the conversation gets good.

Worse, `sceneUnchanged` inverts: in voice the interviewer would permanently
believe nothing has been drawn, and the drilling rule would have no component to
drill.

## Desired behaviour

Push workspace deltas into the live session over the data channel, on change
rather than on turn.

### Mechanism

`conversation.item.create` with a `system`-role message carrying a compact
delta, sent when the board or scope actually changes:

```
[board update] added: Kafka topic "orders" between API and Worker pool; removed: none.
[scope update] active constraints now include: 99.9% availability.
```

Not `session.update` with rebuilt instructions: that re-sends the entire prompt
(rubric, playbook, timeline, narrative) on every stroke, which is expensive and
invites the model to re-anchor on its opening framing mid-conversation.

### When to send

Debounce hard. Drawing produces a continuous stream of scene mutations and one
injection per stroke would both cost a fortune and drown the conversation.

- Diff against the last **sent** summary, not the last rendered one.
- Send at most once every ~10s, and never while `turnState === "candidateSpeaking"`
  — queue it and flush at the turn boundary. An injection mid-sentence is a
  context switch the model may treat as a new user turn.
- Send immediately on phase change and on a constraint apply/dismiss, which are
  discrete, candidate-initiated, and worth the interruption.
- Send nothing when the diff is empty. The existing scene-hash comparison already
  gives a clean signal for this — reuse it rather than adding a second notion of
  "changed".

### Constraints stay server-authoritative

The text path deliberately overwrites whatever the client sends with
`interviews.live_constraints_json` (`interview.service.ts:398-404`) so a stale
client cannot make the model reason against an old scope. Voice must not become
the hole in that rule: constraint deltas are pulled from
`GET /interviews/:id/constraints`, not asserted by the client.

### Injected items are not transcript

These items exist in the model's conversation but are **not** interview turns.
They must not be persisted by task 23, must not appear in the chat panel, must
not reach the debrief, and must not be counted as candidate contributions. Mark
them at creation and filter on that mark in exactly one place.

## Files to touch

- `apps/web/src/lib/voice/contextFeed.ts` + `contextFeed.test.ts` (new)
- `apps/web/src/lib/voice/useRealtimeVoice.ts`
- `apps/web/src/pages/WorkspacePage.tsx` — wire the existing scene summary in
- `apps/api/src/voice/voice.controller.ts` — constraint snapshot for the feed
- `packages/shared/src/index.ts` — the delta shape

## Acceptance criteria

- [ ] Drawing a component while speaking results in the interviewer being able to reference it by name on a later turn.
- [ ] The debounce is unit-tested: 50 rapid scene mutations produce at most one injection per window, and an unchanged scene produces none.
- [ ] No injection is sent while `candidateSpeaking`; queued deltas flush at the turn boundary.
- [ ] Phase changes and constraint apply/dismiss bypass the debounce.
- [ ] Constraint deltas come from the server endpoint, never from client state — asserted.
- [ ] Injected context items never appear in the chat transcript, in `interview_messages`, or in the debrief. Asserted at the persistence boundary, not just visually.
- [ ] The delta is a diff, not a full resend: a scene with one added node produces a payload naming that node, not the whole board.
- [ ] `pnpm -w lint`, `pnpm -w turbo run typecheck`, `pnpm -w turbo run test` pass.

## Out of scope

- Sending images of the board. Text summaries only — `sceneSummary` already exists and the realtime model's value here is conversation, not vision.
- Changing how `sceneSummary` is produced.
- Letting the interviewer draw or annotate.
