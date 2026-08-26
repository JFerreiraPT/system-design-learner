import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  VoiceConnectionStatus,
  VoiceTurn,
  VoiceTurnState
} from "@sdl/shared";
import { createVoiceSession, exchangeSdp, postVoiceTurns } from "../api";
import { ContextFeed, type ContextSnapshot } from "./contextFeed";
import { applyLiveDelta, applyLiveSet, type ProvisionalTurn } from "./liveTurns";
import {
  billableSeconds,
  initialMeter,
  meterCostUsd,
  tickMeter,
  type MeterState
} from "./costMeter";
import {
  applyCommand,
  INITIAL_TURN_MACHINE,
  reduceTurn,
  truncationTarget,
  type TurnMachine
} from "./turnState";
import { TurnBuffer } from "./turnBuffer";
import {
  isAssistantTranscriptDelta,
  isAssistantTranscriptDone,
  isCandidateTranscriptDelta,
  isCandidateTranscriptDone,
  isCandidateTranscriptFailed,
  type RealtimeServerEvent
} from "./types";

/**
 * One spoken interview, end to end.
 *
 * Owns the WebRTC peer connection, the data channel, turn state, transcript
 * buffering, workspace-context injection, the cost meter, and reconnection.
 * Everything genuinely tricky is delegated to the pure modules next door, which
 * is where the tests live — a WebRTC session is not something you can unit test.
 *
 * The transport rule that shapes this file: the candidate's audio goes straight
 * to OpenAI, so this client is the ONLY witness to what was said. If it fails to
 * post a turn, that turn is gone, and the debrief is graded against a transcript
 * with a hole in it. Hence the retry queue and the explicit warning.
 */

export type VoiceSessionView = {
  status: VoiceConnectionStatus;
  turnState: VoiceTurnState;
  /** 0..1, for the level meter. The only honest answer to "is it hearing me?". */
  micLevel: number;
  muted: boolean;
  held: boolean;
  error: string | null;
  /** Set when transcript posts are failing — the candidate must know the tail
   * of their session is not being recorded. */
  transcriptWarning: string | null;
  liveTurns: ProvisionalTurn[];
  elapsedSeconds: number;
  estimatedUsd: number;
  maxSessionSeconds: number;
  ceilingWarning: boolean;
  start: () => void;
  stop: () => void;
  setMuted: (muted: boolean) => void;
  setHeld: (held: boolean) => void;
  /** Force-end the candidate's turn for someone who has finished but whose
   * trailing tone reads as unfinished. */
  goAhead: () => void;
};

type Options = {
  interviewId: string;
  /** Current workspace state, read on every tick. */
  snapshot: () => ContextSnapshot;
  /** Phase snapshot to attach to persisted turns, matching the text path. */
  phase?: () => unknown;
  /** Called after turns are persisted, so the workspace can refetch. */
  onTurnsPersisted?: () => void;
  /** Called when the session ends for any reason. */
  onClosed?: () => void;
};

const TICK_MS = 1000;
/** Level-meter sampling interval. ~15Hz reads as smooth and costs a quarter of
 * the renders a per-frame meter would. */
const MIC_LEVEL_INTERVAL_MS = 66;
const RECONNECT_ATTEMPTS = 3;
/** Total reconnects allowed per session, however they are spread out. The
 * per-burst counter resets once a connection proves stable, so without this a
 * link that opens and drops every few seconds would reconnect forever. */
const RECONNECT_ATTEMPTS_TOTAL = 8;
/** How long a connection must survive before its burst counter is forgiven. */
const STABLE_CONNECTION_MS = 60_000;
const REMINT_LEAD_MS = 30_000;
const CEILING_WARN_FRACTION = 0.8;
const IDLE_TIMEOUT_MS = 300_000;
const POST_RETRY_LIMIT = 5;

export function useRealtimeVoice(options: Options): VoiceSessionView {
  const { interviewId } = options;

  const [status, setStatus] = useState<VoiceConnectionStatus>("idle");
  const [turnState, setTurnState] = useState<VoiceTurnState>("idle");
  const [micLevel, setMicLevel] = useState(0);
  const [muted, setMutedState] = useState(false);
  const [held, setHeldState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcriptWarning, setTranscriptWarning] = useState<string | null>(null);
  const [liveTurns, setLiveTurns] = useState<ProvisionalTurn[]>([]);
  const [meter, setMeter] = useState<MeterState>(() => initialMeter(Date.now()));
  const [maxSessionSeconds, setMaxSessionSeconds] = useState(3600);
  const [ceilingWarning, setCeilingWarning] = useState(false);

  // Everything below is transport state, deliberately in refs: none of it should
  // drive a render, and the event handlers must always see the latest value.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode } | null>(null);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);

  const machineRef = useRef<TurnMachine>(INITIAL_TURN_MACHINE);
  const bufferRef = useRef(new TurnBuffer());
  const feedRef = useRef(new ContextFeed());
  const meterRef = useRef<MeterState>(initialMeter(Date.now()));
  const reportedSecondsRef = useRef(0);
  const pendingPostsRef = useRef<VoiceTurn[]>([]);
  const postFailuresRef = useRef(0);
  const expiresAtRef = useRef<number>(Number.POSITIVE_INFINITY);
  const lastVoiceActivityRef = useRef(Date.now());
  const attemptRef = useRef(0);
  const totalAttemptsRef = useRef(0);
  const liveSinceRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const accumulatedAtStartRef = useRef(0);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // --- data channel -------------------------------------------------------

  const send = useCallback((payload: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return false;
    dc.send(JSON.stringify(payload));
    return true;
  }, []);

  const syncMachine = useCallback((next: TurnMachine) => {
    machineRef.current = next;
    setTurnState(next.state);
    const now = Date.now();
    meterRef.current = tickMeter(meterRef.current, next.state, now);
    setMeter(meterRef.current);
  }, []);

  /** Push whatever the buffer has ready, with a bounded retry queue.
   *
   * Losing graded transcript silently is the worst outcome available here, so a
   * failure is queued and surfaced rather than swallowed. */
  const flushTurns = useCallback(
    async (turns: VoiceTurn[]) => {
      const batch = [...pendingPostsRef.current, ...turns];
      if (batch.length === 0) return;
      pendingPostsRef.current = [];

      // Absolute total, including what earlier sessions already spent, so the
      // server can dedupe it with a max() and a retried post cannot bill twice.
      const total = accumulatedAtStartRef.current + billableSeconds(meterRef.current);

      try {
        const result = await postVoiceTurns(interviewId, batch.slice(0, 20), total);
        reportedSecondsRef.current = total;
        postFailuresRef.current = 0;
        setTranscriptWarning(null);
        setCeilingWarning(
          result.ceilingReached ||
            result.accumulatedSeconds >= maxSessionSeconds * CEILING_WARN_FRACTION
        );
        if (result.ceilingReached) closeSessionRef.current("ceiling");
        optionsRef.current.onTurnsPersisted?.();
      } catch (err) {
        postFailuresRef.current += 1;
        // A rejected interview (409) will never accept these; anything else is
        // worth retrying on the next flush.
        const statusCode = (err as { response?: { status?: number } })?.response?.status;
        if (statusCode === 409) {
          setTranscriptWarning("This interview is closed, so nothing further is being recorded.");
          closeSessionRef.current("closed");
          return;
        }
        pendingPostsRef.current = batch.slice(-40);
        if (postFailuresRef.current >= POST_RETRY_LIMIT) {
          setTranscriptWarning(
            "The last few minutes of this conversation could not be saved. Your debrief will be missing them."
          );
        }
      }
    },
    [interviewId, maxSessionSeconds]
  );

  /** Both updates go through the pure reducers in `liveTurns.ts`, which is where
   * the delta-accumulation subtlety is documented and tested. */
  const setLive = useCallback((turn: ProvisionalTurn) => {
    setLiveTurns((prev) => applyLiveSet(prev, turn));
  }, []);

  const appendLive = useCallback(
    (externalId: string, role: "user" | "assistant", delta: string) => {
      setLiveTurns((prev) => applyLiveDelta(prev, externalId, role, delta));
    },
    []
  );

  const handleEvent = useCallback(
    (event: RealtimeServerEvent) => {
      const now = Date.now();
      const previous = machineRef.current;

      if (event.type === "error") {
        setError(event.error?.message ?? "The voice session reported an error.");
        return;
      }

      // Barge-in: truncate BEFORE reducing, while the previous state still knows
      // which item was being spoken and for how long. Without this the model's
      // context claims it delivered a sentence the candidate never heard, and it
      // will refer back to it — a bug that reads like a prompt problem.
      if (event.type === "input_audio_buffer.speech_started") {
        const target = truncationTarget(previous, now);
        if (target) {
          send({
            type: "conversation.item.truncate",
            item_id: target.itemId,
            content_index: 0,
            audio_end_ms: target.audioEndMs
          });
          const spoken = liveTurnContent(target.itemId);
          bufferRef.current.markInterrupted(target.itemId, spoken);
          setLive({
            externalId: target.itemId,
            role: "assistant",
            content: spoken ?? "",
            provisional: false,
            interrupted: true
          });
        }
      }

      if (event.type.startsWith("input_audio_buffer.") || event.type === "response.created") {
        lastVoiceActivityRef.current = now;
      }

      syncMachine(reduceTurn(previous, { event, atMs: now }));

      // --- transcripts ---
      const itemId = event.item_id ?? event.item?.id ?? "";

      if (isCandidateTranscriptDelta(event.type) && itemId) {
        bufferRef.current.appendDelta(itemId, event.delta ?? "", now, "user");
        appendLive(itemId, "user", event.delta ?? "");
        return;
      }

      if (isCandidateTranscriptDone(event.type) && itemId) {
        bufferRef.current.completeItem(itemId, "user", now, event.transcript);
        if (event.transcript) {
          setLive({ externalId: itemId, role: "user", content: event.transcript, provisional: false });
        } else {
          setLive({ externalId: itemId, role: "user", content: liveTurnContent(itemId) ?? "", provisional: false });
        }
        void flushTurns(bufferRef.current.drain(now));
        return;
      }

      if (isCandidateTranscriptFailed(event.type) && itemId) {
        bufferRef.current.failItem(itemId, "user", now);
        void flushTurns(bufferRef.current.drain(now));
        return;
      }

      if (isAssistantTranscriptDelta(event.type) && itemId) {
        bufferRef.current.appendDelta(itemId, event.delta ?? "", now, "assistant");
        appendLive(itemId, "assistant", event.delta ?? "");
        return;
      }

      if (isAssistantTranscriptDone(event.type) && itemId) {
        bufferRef.current.completeItem(itemId, "assistant", now, event.transcript);
        setLive({
          externalId: itemId,
          role: "assistant",
          content: event.transcript ?? liveTurnContent(itemId) ?? "",
          provisional: false
        });
        return;
      }

      if (event.type === "response.done") {
        void flushTurns(bufferRef.current.drain(now));
      }

      // A user item created from audio: register it immediately so ordering is
      // fixed even though its transcript is still in flight.
      if (event.type === "conversation.item.created" && event.item?.id) {
        const role = event.item.role;
        if (role === "user" || role === "assistant") {
          bufferRef.current.noteItem(event.item.id, role, now);
        }
      }
    },
    [appendLive, flushTurns, send, setLive, syncMachine]
  );

  /** Reads live transcript text without making it a render dependency. */
  const liveTurnsRef = useRef<ProvisionalTurn[]>([]);
  liveTurnsRef.current = liveTurns;
  function liveTurnContent(itemId: string): string | undefined {
    return liveTurnsRef.current.find((t) => t.externalId === itemId)?.content;
  }

  // --- teardown -----------------------------------------------------------

  const closeSessionRef = useRef<(reason: string) => void>(() => {});

  const closeSession = useCallback(
    (reason: string) => {
      if (closingRef.current) return;
      // Already torn down. The tail flush below is async and can re-enter here
      // once `closingRef` has been cleared, so identity of the transport — not
      // just the in-progress flag — is what makes this idempotent.
      if (!pcRef.current && !dcRef.current && !micRef.current) return;
      closingRef.current = true;

      // Flush the tail before tearing anything down: a lost tail is a debrief
      // graded against an incomplete transcript.
      const remaining = bufferRef.current.flushAll(Date.now());
      if (remaining.length > 0 || pendingPostsRef.current.length > 0) {
        void flushTurns(remaining);
      }

      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      rafRef.current = null;
      tickRef.current = null;

      try {
        dcRef.current?.close();
      } catch {
        /* already closed */
      }
      dcRef.current = null;

      // Every track must actually stop — a user should never be left wondering
      // whether the mic is still on.
      micRef.current?.getTracks().forEach((track) => track.stop());
      micRef.current = null;

      try {
        pcRef.current?.close();
      } catch {
        /* already closed */
      }
      pcRef.current = null;

      void analyserRef.current?.ctx.close().catch(() => {});
      analyserRef.current = null;

      if (audioRef.current) {
        audioRef.current.srcObject = null;
        audioRef.current = null;
      }

      syncMachine(applyCommand(machineRef.current, { kind: "closed" }));
      setStatus(reason === "failed" ? "failed" : "closed");
      setMicLevel(0);
      setHeldState(false);
      closingRef.current = false;
      optionsRef.current.onClosed?.();
    },
    [flushTurns, syncMachine]
  );
  closeSessionRef.current = closeSession;

  // --- connect ------------------------------------------------------------

  const connect = useCallback(async () => {
    setError(null);
    setStatus(attemptRef.current > 0 ? "reconnecting" : "connecting");

    let mint: Awaited<ReturnType<typeof createVoiceSession>>;
    try {
      mint = await createVoiceSession(interviewId, optionsRef.current.snapshot() as never);
    } catch (err) {
      // Voice never blocks the interview: fail loudly here and leave text alone.
      setError(mintMessage(err));
      setStatus("failed");
      return;
    }

    setMaxSessionSeconds(mint.maxSessionSeconds);
    accumulatedAtStartRef.current = mint.accumulatedSeconds;
    expiresAtRef.current = Date.parse(mint.expiresAt) || Number.POSITIVE_INFINITY;
    setCeilingWarning(mint.accumulatedSeconds >= mint.maxSessionSeconds * CEILING_WARN_FRACTION);

    let mic: MediaStream;
    try {
      // Echo cancellation is not optional: without it the interviewer's own
      // voice returns through the laptop mic, semantic VAD reads it as the
      // candidate speaking, and the model interrupts itself in a loop.
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch {
      setError(
        "Microphone access was denied, so voice is unavailable. The interview continues in text."
      );
      setStatus("failed");
      return;
    }
    micRef.current = mic;

    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    const audio = document.createElement("audio");
    audio.autoplay = true;
    audioRef.current = audio;
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? null;
    };

    const track = mic.getAudioTracks()[0];
    if (track) pc.addTrack(track, mic);

    // Exact channel name — anything else connects and never delivers an event.
    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;
    dc.addEventListener("message", (e) => {
      try {
        handleEvent(JSON.parse(String(e.data)) as RealtimeServerEvent);
      } catch {
        // A malformed frame is not worth dropping the session over.
      }
    });
    dc.addEventListener("open", () => {
      // Do NOT forgive the burst counter here. An open socket is not yet a
      // working one, and resetting on every open is what turns a flapping
      // connection into an unbounded reconnect loop.
      liveSinceRef.current = Date.now();
      setStatus("live");
      syncMachine(applyCommand(machineRef.current, { kind: "connected" }));
      // The mint already described this state in the instructions, so it must
      // not immediately be re-sent as news.
      feedRef.current.seed(optionsRef.current.snapshot());
      lastVoiceActivityRef.current = Date.now();
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      const state = pc.iceConnectionState;
      if (state !== "failed" && state !== "disconnected") return;

      // A connection that lasted a while has earned a fresh budget; one that
      // dropped immediately has not.
      const liveFor = liveSinceRef.current === null ? 0 : Date.now() - liveSinceRef.current;
      if (liveFor >= STABLE_CONNECTION_MS) attemptRef.current = 0;
      liveSinceRef.current = null;

      if (
        attemptRef.current >= RECONNECT_ATTEMPTS ||
        totalAttemptsRef.current >= RECONNECT_ATTEMPTS_TOTAL
      ) {
        setError("The voice connection dropped and could not be re-established. Continuing in text.");
        closeSessionRef.current("failed");
        return;
      }
      attemptRef.current += 1;
      totalAttemptsRef.current += 1;
      setStatus("reconnecting");
      // A re-mint carries the transcript so far, because every turn has been
      // persisted — so the interviewer picks up rather than reintroducing itself.
      window.setTimeout(() => {
        closeSessionRef.current("reconnecting");
        void connectRef.current();
      }, 500 * attemptRef.current);
    });

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await exchangeSdp(offer.sdp ?? "", mint.clientSecret);
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not establish the voice connection.");
      closeSessionRef.current("failed");
      return;
    }

    startLevelMeter(mic, analyserRef, rafRef, setMicLevel);
  }, [handleEvent, interviewId, syncMachine]);

  const connectRef = useRef(connect);
  connectRef.current = connect;

  // --- periodic work: meter, context feed, idle, expiry, ceiling ----------

  useEffect(() => {
    if (status !== "live") return;
    const id = window.setInterval(() => {
      const now = Date.now();
      meterRef.current = tickMeter(meterRef.current, machineRef.current.state, now);
      setMeter(meterRef.current);

      const totalSeconds = accumulatedAtStartRef.current + billableSeconds(meterRef.current);
      if (totalSeconds >= maxSessionSeconds) {
        setError("This interview has reached its voice-time limit. Continuing in text.");
        closeSessionRef.current("ceiling");
        return;
      }
      if (totalSeconds >= maxSessionSeconds * CEILING_WARN_FRACTION) setCeilingWarning(true);

      // Re-mint BEFORE expiry rather than reacting to a dead connection: an
      // expired session has no request to fail and no banner to render.
      if (now > expiresAtRef.current - REMINT_LEAD_MS) {
        expiresAtRef.current = Number.POSITIVE_INFINITY;
        // A scheduled refresh is not a failure and must not consume the
        // reconnect budget, or a long interview would exhaust it on expiry
        // alone and drop the candidate into text for no reason.
        attemptRef.current = 0;
        setStatus("reconnecting");
        closeSessionRef.current("reconnecting");
        void connectRef.current();
        return;
      }

      if (
        now - lastVoiceActivityRef.current > IDLE_TIMEOUT_MS &&
        machineRef.current.state !== "held"
      ) {
        setError("The voice session was idle, so it was closed to stop it billing.");
        closeSessionRef.current("idle");
        return;
      }

      // Keep the interviewer aware of the board. `snapshot()` is cheap; the feed
      // decides whether anything is worth saying.
      const text = feedRef.current.offer(
        optionsRef.current.snapshot(),
        machineRef.current.state,
        now
      );
      if (text) {
        send({
          type: "conversation.item.create",
          item: { type: "message", role: "system", content: [{ type: "input_text", text }] }
        });
      }

      // Release any turn stranded by a transcript that never completed.
      const stalled = bufferRef.current.drain(now);
      if (stalled.length > 0 || pendingPostsRef.current.length > 0) void flushTurns(stalled);
    }, TICK_MS);
    tickRef.current = id;
    return () => window.clearInterval(id);
  }, [flushTurns, maxSessionSeconds, send, status]);

  // Unmount must stop every track — see the ceiling rationale, and the simpler
  // one that a live mic nobody knows about is unacceptable.
  useEffect(() => () => closeSessionRef.current("unmount"), []);

  // --- controls -----------------------------------------------------------

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    micRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
  }, []);

  /** Hold disables the mic track locally: instant, no round trip, and it cannot
   * leave the session waiting on a manual commit a disconnected client will
   * never send (which `turn_detection: null` can). */
  const setHeld = useCallback(
    (next: boolean) => {
      const now = Date.now();
      if (next) {
        // Holding mid-reply is a barge-in, so truncate as usual.
        const target = truncationTarget(machineRef.current, now);
        if (target) {
          send({
            type: "conversation.item.truncate",
            item_id: target.itemId,
            content_index: 0,
            audio_end_ms: target.audioEndMs
          });
        }
      }
      setHeldState(next);
      micRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = next ? false : !muted;
      });
      syncMachine(applyCommand(machineRef.current, { kind: next ? "hold" : "release" }));
      lastVoiceActivityRef.current = now;
    },
    [muted, send, syncMachine]
  );

  const goAhead = useCallback(() => {
    // A no-op, not an error, in every state where there is nothing to hand over:
    // the interviewer already has the floor, or no audio has been buffered yet.
    // Committing an empty buffer is an API error, and it would surface to the
    // candidate as a banner about something they did nothing wrong to cause.
    if (machineRef.current.state !== "candidateSpeaking") return;
    if (!send({ type: "input_audio_buffer.commit" })) return;
    send({ type: "response.create" });
    lastVoiceActivityRef.current = Date.now();
  }, [send]);

  const start = useCallback(() => {
    if (status === "live" || status === "connecting") return;
    attemptRef.current = 0;
    totalAttemptsRef.current = 0;
    liveSinceRef.current = null;
    bufferRef.current = new TurnBuffer();
    feedRef.current = new ContextFeed();
    meterRef.current = initialMeter(Date.now(), "idle");
    reportedSecondsRef.current = 0;
    setLiveTurns([]);
    setTranscriptWarning(null);
    void connectRef.current();
  }, [status]);

  const stop = useCallback(() => closeSessionRef.current("user"), []);

  const elapsedSeconds = accumulatedAtStartRef.current + Math.round(meter.elapsedSeconds);

  return useMemo(
    () => ({
      status,
      turnState,
      micLevel,
      muted,
      held,
      error,
      transcriptWarning,
      liveTurns,
      elapsedSeconds,
      estimatedUsd: meterCostUsd(meter),
      maxSessionSeconds,
      ceilingWarning,
      start,
      stop,
      setMuted,
      setHeld,
      goAhead
    }),
    [
      ceilingWarning,
      elapsedSeconds,
      error,
      goAhead,
      held,
      liveTurns,
      maxSessionSeconds,
      meter,
      micLevel,
      muted,
      setHeld,
      setMuted,
      start,
      status,
      stop,
      transcriptWarning,
      turnState
    ]
  );
}

/** Bars in the UI meter. The level is quantised to this many steps, because a
 * meter with eight bars cannot render more resolution than eight steps — and
 * every extra distinct value is a wasted React render. */
const MIC_LEVEL_STEPS = 8;

/**
 * A simple RMS level meter. Not a waveform — the question it answers is "is this
 * thing hearing me?", and a number answers that.
 *
 * The rate limiting is not cosmetic. `micLevel` is React state, so a naive
 * `setMicLevel` per animation frame re-renders the conversation subtree sixty
 * times a second for the entire session. `ChatPanel` already buffers streamed
 * tokens at 60ms for exactly this reason; a level meter must not undo it.
 *
 * Two guards: sample at a fixed interval rather than per frame, and only push a
 * value when the quantised step actually changes — so a candidate sitting in
 * silence produces no renders at all.
 */
function startLevelMeter(
  stream: MediaStream,
  analyserRef: React.MutableRefObject<{ ctx: AudioContext; analyser: AnalyserNode } | null>,
  rafRef: React.MutableRefObject<number | null>,
  setMicLevel: (level: number) => void
) {
  try {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    analyserRef.current = { ctx, analyser };

    const data = new Uint8Array(analyser.frequencyBinCount);
    let lastStep = -1;
    let lastSampleMs = 0;

    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);
      if (now - lastSampleMs < MIC_LEVEL_INTERVAL_MS) return;
      lastSampleMs = now;

      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const sample of data) {
        const centred = (sample - 128) / 128;
        sum += centred * centred;
      }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
      const step = Math.round(level * MIC_LEVEL_STEPS);
      if (step === lastStep) return;
      lastStep = step;
      setMicLevel(step / MIC_LEVEL_STEPS);
    };
    rafRef.current = requestAnimationFrame(loop);
  } catch {
    // No level meter is a cosmetic loss; it must never stop the session.
  }
}

function mintMessage(err: unknown): string {
  const detail = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && typeof detail[0] === "string") return detail[0];
  return "Voice could not be started. The interview continues in text.";
}
export type { ProvisionalTurn } from "./liveTurns";
