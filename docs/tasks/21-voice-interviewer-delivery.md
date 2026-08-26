# 21 · Voice-native interviewer delivery rules

**Area:** Voice · **Priority:** P1 · **Size:** S · **Depends on:** —
**Labels:** `agent-ready`, `voice`, `prompts`

> **Status: DONE.** `buildInterviewerPrompt(level, scope, { modality })`. Text output is
> **byte-identical** to before — asserted across every level × scope combination, including
> an explicit `{ modality: "text" }` and an omitted options object. `VOICE_DELIVERY_RULES`
> replaces the chat-panel formatting contract rather than supplementing it, since a prompt
> carrying both tells the model to say `$$...$$` out loud.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

`buildInterviewerPrompt` (`packages/ai-prompts/src/index.ts:1304`) was written for
a chat panel that renders markdown, GFM tables and KaTeX — `ChatPanel` goes to
real trouble to make that output pretty, including wrapping bare-bracket LaTeX
for KaTeX (`normalizeMathDelimiters`) and provisionally closing open fences
mid-stream (`closeOpenMarkdown`).

Feed the same prompt to a speech model and every one of those affordances becomes
a defect. Spoken aloud:

- `**Latency:** ~200ms p99` becomes *"asterisk asterisk latency asterisk asterisk
  tilde two hundred m s p ninety-nine"*.
- A three-column comparison table is unlistenable.
- `$$295 \text{ bytes} \times 100{,}000$$` is noise.
- A four-bullet list of probes asks four questions at once; the candidate answers
  the last one and the other three are lost.

The pacing guidance has the same problem in reverse. The prompt tells the
interviewer to drill one component for *"at least three consecutive follow-ups"*
(`index.ts:1324`) — sound advice in text, where the candidate can re-read. Spoken,
three stacked follow-ups in one turn is an interrogation.

## Desired behaviour

One modality parameter, one extra block. **No second prompt.**

```ts
buildInterviewerPrompt(level, scope?, options?: { modality?: "text" | "voice" })
```

`modality` defaults to `"text"`, so every existing call site and every existing
assertion in `packages/ai-prompts/src/index.test.ts` keeps passing untouched.
When `"voice"`, append a delivery block covering:

- **Plain speech only.** No markdown, no bullets, no tables, no LaTeX, no code
  fences, no emoji, no stage directions.
- **Numbers as spoken language.** "about two hundred million writes a day", not
  "~200M w/d". "ninety-nine point nine percent", not "99.9%".
- **One question per turn.** Two or three sentences. If several probes are
  warranted, ask the most load-bearing one and hold the rest.
- **Real acknowledgement.** Open by reacting to what was actually said ("okay, so
  you're sharding on user id —") before probing. In text this is optional
  politeness; spoken, its absence reads as a non-sequitur.
- **Silence is the candidate thinking.** Do not fill a pause, do not re-ask, do
  not offer a hint because two seconds passed. Task 22 keeps you out of the
  candidate's pauses at the transport layer; this rule keeps you out of them at
  the prompt layer.
- **Never read the rubric aloud.** Already the rule
  (`index.ts:1337` — "do not paste these texts at the candidate"), and worth
  restating for voice because a spoken hidden expectation cannot be un-said.
- **Ask before spelling.** Where an exact identifier matters, ask the candidate to
  type it rather than spelling it out phonetically.
- **Whiteboard is shared context.** Refer to what is on the board by name
  ("the queue between the API and the workers"), not by coordinates.

The nudge-escalation rule (`index.ts:1354`) needs one voice amendment: a spoken
nudge is easier to miss than a written one, so a nudge that draws no reaction at
all may be repeated once in different words before escalating. Without this the
ladder burns a rung on a nudge the candidate simply did not catch.

Apply the same treatment to the phase-transition line: spoken, the offer should
be a natural sentence ("want to move on to the deep dive?"), which is what
task 09 already asked for and text never quite delivered.

## Files to touch

- `packages/ai-prompts/src/index.ts` — `modality` option + the delivery block
- `packages/ai-prompts/src/index.test.ts`
- `apps/api/src/voice/voice.service.ts` — pass `modality: "voice"`

## Acceptance criteria

- [ ] `buildInterviewerPrompt(level, scope)` with no options produces a **byte-identical** string to today's output, for every level — assert with a snapshot per level, so text behaviour cannot regress.
- [ ] `modality: "voice"` adds the delivery block and changes nothing else about criteria, playbook, timeline or narrative handling.
- [ ] The voice block forbids markdown, bullets, tables and LaTeX explicitly, and the assertions name those four.
- [ ] The one-question-per-turn rule is present, and the hard/staff drilling rule is reworded for voice so three follow-ups are spread across turns rather than stacked in one.
- [ ] The "silence is thinking" rule is present.
- [ ] Voice mode still refuses to read hidden criterion text aloud, asserted with a rubric containing a sentinel string absent from the built prompt's candidate-facing guidance.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Changing the *content* of the rubric, playbook, or coaching rules for voice — this task only changes delivery.
- Tutor prompts.
- Choosing a voice timbre (task 20 owns `AI_VOICE_NAME`).
