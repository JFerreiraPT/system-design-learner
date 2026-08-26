# 26 · Voice cost ceiling, expiry and reconnect

**Area:** Voice · **Priority:** P1 · **Size:** M · **Depends on:** 20
**Labels:** `agent-ready`, `voice`, `api`, `web`

> **Status: DONE.** Ceiling and idle timeout are env-tunable with falling-back defaults;
> accumulated seconds live on `interviews.voice_seconds` so a reload cannot reset them
> (asserted). The credential is re-minted `REMINT_LEAD_MS` *before* expiry rather than after
> a dead connection, and a re-mint carries the persisted transcript, so the interviewer does
> not re-deliver `framingScript`. `costMeter.ts` attributes heard and spoken time separately
> because output audio costs 4x per second — asserted — and a held mic bills nothing.
> Exhausted retries close the session, flush the transcript and leave text working.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

Every other AI call in this product is bounded by a request. A voice session is
bounded by **nothing**: it bills for as long as a socket is open. `gpt-realtime-2.1`
is $32 / 1M audio-input tokens and $64 / 1M audio-output tokens — about $0.02 per
minute heard and $0.08 per minute spoken, so a real 45-minute interview is around
$2. A tab left open over a lunch break keeps the mic hot and keeps charging.

The failure modes are all silent, which is what makes them worth a task:

- The ephemeral client secret expires mid-interview. The connection drops and the
  candidate is talking to nobody. There is no request to fail and no error banner
  to render, because nothing was requested.
- Wi-Fi blips. WebRTC does not transparently recover a dead peer connection.
- A reconnect mints a **fresh** session, and a fresh session has no memory of the
  conversation. Reconnecting naively produces an interviewer that reintroduces
  itself twenty minutes in.

This task also fixes the one thing task 20 deliberately deferred: the model is
free to speak indefinitely and there is no ceiling anywhere.

## Desired behaviour

### A hard ceiling

`VOICE_MAX_SESSION_MINUTES` (default `60`) enforced client-side as a countdown
and server-side by refusing to mint another session for an interview whose
accumulated voice time exceeds it. Warn at 80%, end cleanly at 100% with the
transcript flushed (task 23) rather than dropped.

Track accumulated seconds per interview so the ceiling survives reconnects —
otherwise it is trivially reset by reloading the page, and the ceiling is
decoration.

### Idle auto-close

Close the session after `VOICE_IDLE_TIMEOUT_SECONDS` (default `300`) with no
candidate speech and no interviewer response. This is the lunch-break case and
the common one. Warn first, in the UI **and** aloud — an unattended tab is
exactly the case where nobody is looking at the screen.

Distinguish idle from thinking: task 22 spent real effort making long pauses
legitimate. Five minutes of true silence is not a pause, but the timer must reset
on any speech event, and holding the mic must not count as idle.

### Cost visibility

Show elapsed voice time and an estimated spend in the voice bar, from locally
accumulated audio seconds and the documented rates. Approximate and labelled as
such — the point is that the candidate can see the meter running, not
accounting accuracy.

### Expiry and reconnect, with continuity

- Track the secret's `expiresAt` from task 20 and re-mint **before** it lapses
  rather than reacting to a dead connection.
- On `iceconnectionstatechange` reaching `failed`/`disconnected`, attempt a
  bounded reconnect with backoff, showing state honestly throughout — a
  reconnecting session must never look live.
- A re-minted session must carry the conversation so far. Task 20 already seeds
  history into the instructions from `interview_messages`; because task 23 has
  been persisting every turn, a reconnect picks up the real transcript. Assert
  this: reconnect after several turns and confirm the interviewer does not
  re-deliver `framingScript`.
- Reconnection is a courtesy, not a guarantee. After the bounded retries, end the
  session, flush the transcript, and drop the candidate into text mode with an
  explanation. Never leave a dead session looking alive.

### Failing safe

If minting fails for any reason — quota, network, misconfiguration, ceiling
reached — the interview is unaffected and the candidate is told plainly why voice
is unavailable. Voice never blocks the interview.

## Files to touch

- `apps/api/src/voice/voice.service.ts` — ceiling enforcement, accumulated time
- `apps/api/src/db/schema.ts` — accumulated voice seconds on `interviews` (nullable; migration + manual journal entry)
- `apps/web/src/lib/voice/useRealtimeVoice.ts` — expiry, reconnect, idle
- `apps/web/src/lib/voice/costMeter.ts` + `costMeter.test.ts` (new)
- `apps/web/src/components/VoiceBar.tsx`
- `.env.example`, `docs/ARCHITECTURE.md`

## Acceptance criteria

- [ ] `VOICE_MAX_SESSION_MINUTES` and `VOICE_IDLE_TIMEOUT_SECONDS` are honoured, documented in `.env.example`, and fall back to their defaults on a malformed value.
- [ ] Accumulated voice seconds persist per interview, so the ceiling cannot be reset by reloading — asserted.
- [ ] Reaching the ceiling ends the session cleanly with the transcript flushed, and a further mint request is refused with a clear reason.
- [ ] The idle timer resets on any speech event and does not fire while the mic is held; asserted with a fake clock.
- [ ] The idle warning is delivered both visually and audibly.
- [ ] The secret is re-minted before expiry, not after failure — asserted with a short fake TTL.
- [ ] A dropped connection reconnects within the retry budget and the interviewer does **not** re-deliver `framingScript` or reintroduce the problem; asserted against a transcript with prior turns.
- [ ] Exhausted retries end the session, flush the transcript, and leave a working text interview.
- [ ] A reconnecting session is never displayed as live.
- [ ] The cost meter is a pure, unit-tested function over accumulated audio seconds and is labelled as an estimate in the UI.
- [ ] Mint failure of any kind leaves the text interview fully functional.
- [ ] `pnpm -w lint`, `pnpm -w turbo run typecheck`, `pnpm -w turbo run test` pass.

## Out of scope

- Per-user billing, quotas or spend caps across interviews. Single-user tool; the ceiling is per session.
- Exact token accounting. The meter is an estimate from documented rates.
- Resuming the *audio* of an interrupted turn after reconnect — the transcript carries over, the half-spoken sentence does not.
