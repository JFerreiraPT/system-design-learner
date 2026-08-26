# 20 · Voice transport: server-minted realtime sessions over WebRTC

**Area:** Voice · **Priority:** P1 · **Size:** L · **Depends on:** —
**Labels:** `agent-ready`, `voice`, `api`, `web`

> **Status: DONE.** `apps/api/src/voice/` mints ephemeral credentials with the interviewer
> prompt baked in; `apps/web/src/lib/voice/useRealtimeVoice.ts` holds the WebRTC session.
> The security property is asserted directly in `voice.service.test.ts` with a sentinel
> string planted in a hidden criterion: it appears in the instructions and in neither the
> response body nor the built client bundle. `resolveVoiceName` / `resolveVoiceTurnDetection`
> / `resolveVoiceLimits` in `ai.models.ts` all fall back rather than throw.
> Verified with `pnpm -w lint`, `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

> **Verify the API surface before writing code.** The Realtime session object has
> already been reshaped once (flat `input_audio_transcription` /
> `turn_detection` moved under `session.audio.input.*`, and the docs host moved
> from `platform.openai.com` to `developers.openai.com`). Every field path in this
> document was checked against `developers.openai.com/api/docs/guides/realtime`,
> `.../realtime-webrtc`, `.../realtime-vad` and `.../realtime-transcription` in
> **August 2026**. Re-read those four pages first and correct this spec in the PR
> body if anything has moved.

## Problem

The interview is text-only. `POST /interviews/:id/messages` streams gpt-4o tokens
over SSE (`apps/api/src/interview/interview.controller.ts:52`) and the candidate
types into a textarea (`apps/web/src/components/ChatPanel.tsx`). A real system
design interview is spoken: the candidate talks while drawing, thinks out loud,
trails off, and the interviewer interjects.

The narrative work in task 10 already assumes this. `framingScript` is specified
as *"the paragraph you would **SAY** to open the interview … This is spoken
framing"* (`packages/ai-prompts/src/index.ts:178`) — and then we render it as
text. Voice makes that literal.

## Desired behaviour

A **speech-to-speech** loop: the browser holds a WebRTC connection directly to
OpenAI's Realtime API, carrying candidate audio up and interviewer audio down,
with a data channel for transcripts and turn-taking events. The API key never
leaves the server; the browser gets a short-lived ephemeral secret with the
session **already configured**.

### Why the config is minted server-side

`POST /v1/realtime/client_secrets` accepts the full session object, so the
`instructions` are baked into the credential on the server. This is not a
convenience — it is the security property that makes voice possible at all:

The interviewer prompt contains the **hidden rubric** — every undiscovered hidden
expectation, verbatim, with its progressive nudges
(`buildInterviewerPrompt`, `packages/ai-prompts/src/index.ts:1335-1358`). If the
browser assembled the session config, the candidate could read the entire hidden
rubric out of devtools and the whole discovery mechanism
(`detectDiscoveries`, `interview.service.ts:1138`) would be theatre.

So: **the client must never receive, and never be able to reconstruct,
`instructions`.** It receives an opaque token plus the handful of non-secret
knobs it genuinely needs (voice name, VAD mode, sample rate) for its own UI.

A candidate can still `session.update` over the data channel and overwrite the
instructions — that is a self-sabotage vector, not a leak, and is out of scope.
Note it in the PR.

### Server: `apps/api/src/voice/`

A new Nest module, mirroring the shape of `interview/`:

`POST /interviews/:id/voice/session`

1. Load the interview + problem. **409 if `status !== "active"`** — same guard and
   same message as `sendMessage` (`interview.service.ts:364-375`), for the same
   reason: a completed interview has a debrief written against a fixed transcript.
2. Build `instructions` from the existing builders — do not write a second
   interviewer prompt. Same inputs `sendMessage` passes to `streamInterviewer`:
   level, problem statement, rubric criteria + playbook, discovered ids, current
   phase, phase timeline, narrative, and the **server-authoritative** live
   constraints (`interview.service.ts:398-404` — the client's copy is never
   trusted). Voice-specific delivery rules come from task 21.
3. Seed the conversation with the existing transcript so voice can resume a
   session that started in text (and vice versa). Realtime sessions do not accept
   history in the session object, so pass it as a compact digest inside the
   instructions, and let task 23 own the live turn-by-turn record.
4. `POST https://api.openai.com/v1/realtime/client_secrets` with:

```jsonc
{
  "session": {
    "type": "realtime",
    "model": "gpt-realtime-2.1",
    "instructions": "<built server-side, never sent to the browser>",
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "transcription": {
          "model": "gpt-live-transcribe",
          "prompt": "A spoken system-design interview.",
          "keywords": ["idempotency", "sharding", "quorum", "CQRS", "write-ahead log", "CDN", "Kafka", "consistent hashing", "read replica", "backpressure"]
        },
        "turn_detection": { "type": "semantic_vad", "eagerness": "low", "create_response": true, "interrupt_response": true }
      },
      "output": { "voice": "marin" }
    }
  }
}
```

   `keywords` matters more than it looks: untuned transcription renders
   "idempotency" as "eye dempotency" and every such miss is a criterion
   `detectDiscoveries` will fail to match. Seed it from the problem's own tags
   and rubric vocabulary, not only from a static list.

   Turn detection (`eagerness: "low"`) is task 22's subject; ship the default here
   so this task is independently testable.

5. Return `{ clientSecret, expiresAt, model, voice, sampleRate, turnDetection }`.
   Nothing else. Assert in a test that the response body contains no substring of
   any hidden criterion text.

### Client: `apps/web/src/lib/voice/`

`useRealtimeVoice(interviewId)` — one hook owning the whole connection:

```ts
const pc = new RTCPeerConnection();
pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };      // interviewer voice out
const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
pc.addTrack(mic.getTracks()[0]);                                 // candidate voice in
const dc = pc.createDataChannel("oai-events");                   // exact name required
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
const answer = await fetch("https://api.openai.com/v1/realtime/calls", {
  method: "POST",
  body: offer.sdp,
  headers: { Authorization: `Bearer ${clientSecret}`, "Content-Type": "application/sdp" }
}).then((r) => r.text());
await pc.setRemoteDescription({ type: "answer", sdp: answer });
```

Exposed state: `status` (`idle | connecting | live | reconnecting | failed`),
`turnState` (`listening | candidateSpeaking | thinking | interviewerSpeaking`),
`micLevel`, and an event stream for tasks 23–25 to consume. Keep it a pure
transport: no persistence, no React tree assumptions, no rendering.

**Echo cancellation is not optional.** Request `echoCancellation`,
`noiseSuppression` and `autoGainControl` explicitly — without them the
interviewer's own voice comes back through the laptop mic, semantic VAD reads it
as the candidate speaking, and the model interrupts itself in a loop.

Open the interview by speaking: on `live` with an empty transcript, send
`response.create` so the interviewer delivers `narrative.framingScript` aloud
rather than waiting for a candidate who is waiting for it.

### Config

Add to `apps/api/src/ai/ai.models.ts` — that file is already the single place
every model id is decided, and voice must not become the exception:

| purpose | default | env key |
|---|---|---|
| `interviewerVoice` | `gpt-realtime-2.1` | `AI_MODEL_VOICE` |
| `voiceTranscription` | `gpt-live-transcribe` | `AI_MODEL_VOICE_TRANSCRIPTION` |

The voice *name* (`marin`) is not a model id — give it its own key
(`AI_VOICE_NAME`) validated against the documented set, falling back to the
default rather than throwing, exactly as `usableModelId` does today.

Document all three in `.env.example` with the cost note: **$32 / 1M audio-input
tokens and $64 / 1M audio-output tokens** — roughly $0.02 per minute heard and
$0.08 per minute spoken, so a 45-minute interview lands near $2. That number is
why task 26 exists.

## Files to touch

- `apps/api/src/voice/voice.module.ts`, `voice.controller.ts`, `voice.service.ts` (new)
- `apps/api/src/voice/voice.dto.ts` (new)
- `apps/api/src/app.module.ts` — register the module
- `apps/api/src/ai/ai.models.ts`, `.env.example`
- `apps/api/src/interview/interview.service.ts` — extract the prompt-input assembly in `sendMessage` so voice reuses it instead of copying it
- `apps/web/src/lib/voice/useRealtimeVoice.ts`, `events.ts`, `types.ts` (new)
- `packages/shared/src/index.ts` — `VoiceSessionResponseSchema`, turn-state union
- `docs/ARCHITECTURE.md`

## Acceptance criteria

- [ ] `OPENAI_API_KEY` never appears in any response body or in the client bundle; assert with a test on the session route and a grep over `apps/web/dist`.
- [ ] The session response contains no `instructions` field and no substring of any hidden criterion text — asserted directly, with a rubric containing a distinctive sentinel string.
- [ ] `POST /interviews/:id/voice/session` returns 409 for a completed interview and 404 for an unknown one.
- [ ] The interviewer prompt is built by the **existing** `buildInterviewerPrompt`; no second copy of the interviewer instructions exists in the tree (assert by grepping for a distinctive phrase from the prompt and finding exactly one definition site).
- [ ] Live constraints in the voice prompt come from `interviews.live_constraints_json`, never from a client-supplied payload — same rule the text path already enforces.
- [ ] A voice session started on an interview with existing text messages carries that history into the model's context.
- [ ] The interviewer speaks first on a fresh interview, delivering `framingScript`.
- [ ] `getUserMedia` is requested with `echoCancellation`, `noiseSuppression` and `autoGainControl` all set.
- [ ] Mic-permission denial surfaces a clear message and leaves the text composer fully usable — voice is never the only way to answer.
- [ ] Unmounting the workspace closes the peer connection, the data channel, and every `MediaStreamTrack`; assert no track is left in `readyState === "live"`.
- [ ] A bad or missing `AI_VOICE_NAME` / `AI_MODEL_VOICE` falls back to the documented default instead of throwing — a typo in `.env` must not take the API down.
- [ ] `pnpm -w lint`, `pnpm -w turbo run typecheck`, `pnpm -w turbo run test` pass.

## Out of scope

- Persisting transcripts (task 23) and the workspace-context feed (task 24).
- Any UI beyond what the hook needs to be exercised — task 25 owns the surface.
- Voice on the Tutor tab. Deliberately excluded: the Tutor is a read-and-think surface where typing is the right input.
- Preventing a candidate from overwriting `instructions` via `session.update`.
- A server-side audio relay. The browser talks to OpenAI directly; revisit only if transcript integrity ever needs to be enforced rather than trusted.
