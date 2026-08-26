# 22 · Turn-taking: silence tolerance, hold-to-think, barge-in

**Area:** Voice · **Priority:** P1 · **Size:** M · **Depends on:** 20
**Labels:** `agent-ready`, `voice`, `web`

> **Status: DONE, then corrected by real use.** `semantic_vad` /
> `eagerness: "medium"` by default. This spec argued for `"low"`, and `"low"`
> shipped first and was wrong: it pads the *maximum* wait, so a chair scrape
> opened a turn and the session then sat in it for seconds — the candidate got a
> false "you're speaking" AND a sluggish interviewer, which is both failure modes
> at once. `server_vad` now also exposes a loudness `threshold` (default 0.65,
> above the API's 0.5), because it is the only mode that can reject room noise.
> Original text below kept as the reasoning that led there. `server_vad` at 1500ms `server_vad` at 2500ms
> as an escape hatch. `turnState.ts` is a pure reducer with 14 tests; the load-bearing one
> feeds `speech_started → speech_stopped → speech_started → committed` and asserts it yields
> ONE turn that never flickers to `thinking`. Barge-in sends `conversation.item.truncate`
> with real elapsed playback, derived from wall-clock because over WebRTC the audio never
> touches the data channel. Hold disables the mic track locally; Space holds it unless the
> candidate is typing.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

This is the task the whole feature lives or dies on, and it is not "add a VAD".

A candidate mid-way through a system design does this: *"so I'd put a queue
here…"* — eight seconds of silence while they draw the queue and think about
backpressure — *"…and the consumers would be idempotent because retries."* That
is **one** turn. Any turn detector tuned for chat cuts it into two, the
interviewer answers the first half, and the candidate is now defending a design
they hadn't finished describing. Do that three times and the tool is unusable.

Default `server_vad` fires at `silence_duration_ms: 500`. Raising it to 8000 is
not the fix either — the interviewer then feels comatose after a genuinely
finished short answer like "consistent hashing".

## Desired behaviour

Three mechanisms, layered.

### 1. Semantic VAD, low eagerness (the default path)

`semantic_vad` runs a turn-detection model over the audio and sets the timeout
*dynamically* from how finished the speech sounds — trailing off on "uhhm" scores
a low end-of-turn probability and it waits longer. `eagerness` tunes the maximum
wait:

> Set `eagerness` to `low` if you want to let the user speak uninterrupted.

That is exactly this product. Configure under `session.audio.input.turn_detection`:

```jsonc
{ "type": "semantic_vad", "eagerness": "low", "create_response": true, "interrupt_response": true }
```

Make the mode and eagerness env-tunable (`VOICE_TURN_DETECTION`,
`VOICE_VAD_EAGERNESS`) and expose them in the returned session snapshot from
task 20, because the right setting is a matter of taste and cannot be discovered
without real sessions. Support `server_vad` as an escape hatch with
`silence_duration_ms` configurable, defaulting to a deliberately generous
`2500` rather than the API default of `500`.

### 2. Hold-to-think (the explicit path)

Semantic VAD is good, not clairvoyant. Give the candidate an unambiguous way to
buy silence: a **Hold** control that disables the mic track
(`track.enabled = false`) for as long as it is held or toggled.

Muting the track — rather than sending `turn_detection: null` — is the right
mechanism because it is local, instant, needs no round trip, and cannot leave the
session in a state where the model is waiting for a manual
`input_audio_buffer.commit` that a disconnected client will never send.

Pair it with the inverse: a **"go ahead"** control that force-ends the turn by
committing the buffer and requesting a response, for the candidate who has
finished but whose trailing tone reads as unfinished.

Both need keyboard access. Space-to-hold while the transcript is not focused,
matching how push-to-talk works everywhere else, plus a visible button.

### 3. Barge-in, with truncation (the correctness path)

`interrupt_response: true` stops the interviewer's audio when the candidate starts
talking over it. That handles the audio. It does **not** handle the model's
belief about what it said.

The assistant item stays in the conversation with its full generated text, so the
model's context claims it delivered a sentence the candidate never heard, and it
will refer back to it. The fix is to send `conversation.item.truncate` with the
audio position where playback actually stopped, so the item is trimmed to what
was really heard.

This is the single easiest thing to get wrong in the whole feature, and its
symptom — an interviewer referring to a question it never finished asking — is
easy to misread as a prompt problem. Track played-audio duration per assistant
item and truncate on every interruption. The same truncation applies to the
candidate pressing Stop.

### Turn state, surfaced

Derive one state machine the UI can render (task 25), driven by data-channel
events:

| state | entered on |
|---|---|
| `listening` | session live, nothing in flight |
| `candidateSpeaking` | `input_audio_buffer.speech_started` |
| `thinking` | `input_audio_buffer.committed` / `response.created` |
| `interviewerSpeaking` | first `response.output_audio.delta` |
| `held` | candidate holds the mic control |

`speech_stopped` must **not** move to `thinking` on its own — under semantic VAD
speech can stop and resume inside one turn, and a UI that flickers to "thinking"
during every pause tells the candidate they are being cut off even when they are
not.

## Files to touch

- `apps/web/src/lib/voice/useRealtimeVoice.ts` — turn state, truncation, hold
- `apps/web/src/lib/voice/turnState.ts` + `turnState.test.ts` (new) — the reducer, pure and unit-tested against recorded event sequences
- `apps/api/src/voice/voice.service.ts` — VAD config + env plumbing
- `.env.example`

## Acceptance criteria

- [ ] The turn-state reducer is a pure function over data-channel events and is unit-tested with recorded fixtures — including the sequence `speech_started → speech_stopped → speech_started → committed`, which must yield exactly one turn and never enter `thinking` in the middle.
- [ ] Default config is `semantic_vad` with `eagerness: "low"`; `VOICE_TURN_DETECTION=server_vad` switches modes and a malformed value falls back to the default without throwing.
- [ ] `server_vad` mode defaults to `silence_duration_ms: 2500`, not the API's 500.
- [ ] Hold disables the mic track and no audio reaches the model while held; releasing restores it without renegotiating the peer connection.
- [ ] Hold is reachable by keyboard and its state is announced to assistive tech (`aria-pressed` + a live region).
- [ ] Interrupting the interviewer sends `conversation.item.truncate` with the actual played duration, asserted against a fake data channel — not merely "audio stopped".
- [ ] After an interruption, the interviewer's next turn does not restate the truncated content as already said. Verified by asserting the truncate event is sent with a non-zero `audio_end_ms` before the next `response.create`.
- [ ] "Go ahead" commits the buffer and produces exactly one response, and is a no-op (not an error) while the interviewer is already speaking.
- [ ] `pnpm -w lint`, `pnpm -w turbo run typecheck`, `pnpm -w turbo run test` pass.

## Out of scope

- Client-side VAD (Silero/WebRTC energy gates). The server's semantic model is strictly better here and shipping both invites two detectors fighting.
- Speaker diarisation or multi-participant calls. One candidate, one interviewer.
- Detecting whether a pause is "thinking" versus "drawing" and behaving differently — the board feed in task 24 is a better signal than pause length.
