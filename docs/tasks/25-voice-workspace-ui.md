# 25 · Voice UI: mode toggle, turn state, live transcript in chat

**Area:** Voice · **Priority:** P1 · **Size:** L · **Depends on:** 20, 22, 23
**Labels:** `agent-ready`, `voice`, `web`, `a11y`

## Problem

`ChatPanel` owns its entire send loop: it holds `messages`, opens the fetch,
buffers tokens on a 60ms timer (`FLUSH_INTERVAL_MS`), appends them to the
trailing assistant bubble, and guards history sync against a stream in flight
(`streamingRef`). Every one of those mechanics is coupled to *"I typed, therefore
a request is in flight."*

Voice has no send. Turns start because someone spoke, transcripts arrive for
**both** roles on separate asynchronous channels, and a turn can be interrupted
and truncated. Bolting that onto `ChatPanel` means a second, subtly different
copy of the scroll-pinning, markdown-normalising, memoised-bubble logic — the
part that took real work to get right (the `ResizeObserver` auto-pin, the
`historySignature` guard that stops the once-a-second phase timer from wiping a
stream in flight).

## Desired behaviour

### Extract, then add

Split `ChatPanel` into:

- **`TranscriptView`** — rendering and scroll behaviour only. Takes a message
  array plus optional live/provisional turns. Keeps `MessageBubble`,
  `normalizeMathDelimiters`, `closeOpenMarkdown`, the `ResizeObserver` auto-pin,
  the jump-to-bottom affordance and the memoisation exactly as they are.
- **`ChatPanel`** — today's composer + SSE send loop, rendering through
  `TranscriptView`. Behaviour must not change at all.
- **`VoicePanel`** — the realtime session, rendering through the same
  `TranscriptView`.

Do the extraction as its own commit with no behaviour change, so the diff that
adds voice is readable.

### The voice surface

A **Text / Voice** segmented toggle in the Interview tab header. Text stays the
default; voice is opt-in and costs money per minute.

While live, a voice bar above the transcript showing:

- Connection state, and the turn state from task 22 as a plain-language pill —
  *Listening · You're speaking · Thinking · Interviewer speaking · Held*
- A mic level meter, which is the only honest answer to "is this thing hearing
  me?"
- **Hold to think** and **Go ahead** (task 22)
- Mute, and End voice
- Elapsed voice time and estimated spend (task 26)

### Live transcript

Both sides stream into the transcript as they happen:

- Candidate speech from `conversation.item.input_audio_transcription.delta` →
  a provisional user bubble, visually distinct (lower emphasis) because it will
  be revised. Firms up on `.completed`.
- Interviewer speech from `response.output_audio_transcript.delta` → an assistant
  bubble filling in as it is spoken. Reuse the existing 60ms buffered flush;
  the reason it exists — re-parsing markdown and KaTeX per token makes long
  answers crawl — applies identically here.
- On interruption, the assistant bubble is truncated to what was actually spoken
  and marked interrupted. The transcript must never show words the candidate
  never heard, or the post-mortem is misleading.

Provisional turns are **display only**. Persistence is task 23's, off the
buffered pair — never off what is on screen.

### Text stays available in voice mode

The composer remains usable while voice is live. This is not a fallback, it is
the realistic mixed mode: candidates say "the ID looks like this" and then type
it. A typed message during a voice session goes through the existing text path
and appears in the same transcript.

### Accessibility and the non-negotiables

- Turn state in an `aria-live="polite"` region — a screen-reader user gets no
  information from a colour-changing pill.
- Every control keyboard-reachable, Hold with `aria-pressed`.
- **Nothing about voice may gate anything.** Mic denied, no input device,
  unsupported browser, connection failed: the interview continues in text with a
  clear message. Voice is an input modality, not a feature flag on the product.
- Mic-active state must be unmistakable, and ending the session must visibly stop
  the tracks. A user should never wonder whether they are still being listened to.

### Layout

The workspace is already a dense resizable-panel layout with the board, rail,
phase ribbon and tabs. The voice bar must not shift the board when it appears or
when the turn-state text changes length — reserve its height. Task 09 made the
same promise for the phase banner; hold to it.

## Files to touch

- `apps/web/src/components/TranscriptView.tsx` (new, extracted)
- `apps/web/src/components/ChatPanel.tsx` (thinned)
- `apps/web/src/components/VoicePanel.tsx`, `VoiceBar.tsx` (new)
- `apps/web/src/pages/WorkspacePage.tsx`
- `apps/web/src/styles.css`

## Acceptance criteria

- [ ] The `TranscriptView` extraction lands as a separate no-behaviour-change commit; text chat, streaming, retry, stop, scroll-pinning and the jump-to-bottom button all behave exactly as before.
- [ ] The once-a-second phase timer still does not reset the transcript or wipe a stream in flight — the `historySignature` guard survives the refactor, asserted.
- [ ] Both sides' speech appears in the transcript as it is spoken.
- [ ] Provisional candidate bubbles are visually distinct and are replaced, not duplicated, on completion.
- [ ] An interrupted interviewer bubble shows only what was spoken and is marked interrupted.
- [ ] Turn state is exposed via `aria-live`; Hold exposes `aria-pressed`; every control is keyboard-reachable.
- [ ] Mic-permission denial, an absent input device and a failed connection each leave a fully usable text interview with a clear explanation.
- [ ] The text composer works during a live voice session and its message lands in the same transcript.
- [ ] Showing the voice bar does not shift the board or the transcript; asserted by reserving height rather than by eye.
- [ ] Switching tabs or unmounting the workspace ends the session and stops every track.
- [ ] `pnpm -w lint`, `pnpm -w turbo run typecheck`, `pnpm -w turbo run test` pass.

## Out of scope

- Waveform visualisation beyond a simple level meter.
- Audio playback of past turns, or transcript editing.
- Voice on the Tutor tab.
