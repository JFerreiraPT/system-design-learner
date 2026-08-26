import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getTrack } from "@sdl/shared";
import type { VoiceSessionResponse, VoiceTurn, VoiceTurnsResponse } from "@sdl/shared";
import { AiService } from "../ai/ai.service.js";
import {
  resolveVoiceLimits,
  resolveVoiceTurnDetection,
  VOICE_SAMPLE_RATE
} from "../ai/ai.models.js";
import { buildInterviewTranscript } from "../common/transcript.js";
import { InterviewService } from "../interview/interview.service.js";

/**
 * Spoken interviews.
 *
 * This service does two things and deliberately not a third: it mints
 * credentials and it records what was said. It never carries audio — the browser
 * holds the WebRTC connection to OpenAI directly, which is why persistence
 * (task 23) exists at all.
 */
@Injectable()
export class VoiceService {
  constructor(
    @Inject(InterviewService) private readonly interviewService: InterviewService,
    @Inject(AiService) private readonly aiService: AiService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {}

  private limits() {
    return resolveVoiceLimits((key) => this.configService.get<string>(key));
  }

  /**
   * Mint a realtime session for this interview.
   *
   * `getInterviewerPromptInputs` throws 404 / 409 for an unknown or completed
   * interview, so those guards are inherited from the text path rather than
   * reimplemented — a completed interview has a debrief written against a fixed
   * transcript and must not accept another turn through any modality.
   */
  async createSession(
    interviewId: string,
    workspaceContext?: Record<string, unknown>
  ): Promise<VoiceSessionResponse> {
    const inputs = await this.interviewService.getInterviewerPromptInputs(interviewId);
    const limits = this.limits();

    const accumulatedSeconds = Number(inputs.session.voiceSeconds ?? 0);
    if (accumulatedSeconds >= limits.maxSessionSeconds) {
      throw new ConflictException(
        `This interview has used its full ${Math.round(limits.maxSessionSeconds / 60)} minutes of voice time. The interview continues in text.`
      );
    }

    // The client's constraint list is discarded in favour of the server's, the
    // same override the text path applies — a stale client must not make the
    // model reason against an old scope.
    const context = {
      ...(workspaceContext ?? {}),
      ...inputs.augmentedContext
    };

    const turnDetection = resolveVoiceTurnDetection((key) => this.configService.get<string>(key));

    const instructions = this.aiService.buildVoiceInstructions({
      interviewerLevel: inputs.session.interviewerLevel,
      problemStatement: inputs.problem.statement,
      history: inputs.history,
      workspaceContext: context,
      criteria: inputs.criteria,
      playbook: inputs.playbook,
      currentPhaseId: (context as { phase?: { id?: string } }).phase?.id,
      discoveredCriterionIds: inputs.discoveredCriterionIds,
      phaseTimeline: inputs.phaseTimeline,
      pendingPhaseTransition: inputs.pendingPhaseTransition,
      narrative: inputs.narrative,
      transcript: buildInterviewTranscript(inputs.history)
    });

    const minted = await this.aiService.mintRealtimeSession({
      instructions,
      turnDetection,
      keywords: this.problemKeywords(inputs)
    });

    // Everything returned here is non-secret by construction. `instructions` is
    // absent on purpose: it contains the hidden rubric verbatim.
    return {
      clientSecret: minted.clientSecret,
      expiresAt: minted.expiresAt,
      model: minted.model,
      voice: minted.voice,
      sampleRate: VOICE_SAMPLE_RATE,
      turnDetection:
        turnDetection.type === "semantic_vad"
          ? { type: "semantic_vad", eagerness: turnDetection.eagerness }
          : { type: "server_vad", silenceDurationMs: turnDetection.silence_duration_ms },
      accumulatedSeconds,
      maxSessionSeconds: limits.maxSessionSeconds
    };
  }

  /** Persist a batch of spoken turns, then bill the audio they consumed.
   *
   * Order matters: the transcript is the graded artefact, so it is written
   * first. If the meter update then failed we would under-bill a session, which
   * is strictly better than losing the turns it recorded. */
  async recordTurns(
    interviewId: string,
    turns: VoiceTurn[],
    audioSecondsDelta?: number
  ): Promise<VoiceTurnsResponse> {
    const { persisted, duplicates } = await this.interviewService.persistVoiceTurns(
      interviewId,
      turns
    );
    const meter = await this.interviewService.addVoiceSeconds(
      interviewId,
      audioSecondsDelta ?? 0,
      this.limits().maxSessionSeconds
    );
    return { persisted, duplicates, ...meter };
  }

  /**
   * Transcription vocabulary for this specific problem.
   *
   * Domain terms the candidate is about to say repeatedly — drawn from the
   * problem's tags, its track and its rubric — so they come back spelled
   * correctly. A mis-transcribed "idempotency" is a criterion the matcher will
   * not match, which reads to the candidate as the interviewer ignoring a point
   * they made.
   */
  private problemKeywords(inputs: {
    problem: { tags?: unknown; title?: string; track?: unknown };
    criteria?: Array<{ text: string }>;
  }): string[] {
    const out: string[] = [];

    const tags = inputs.problem.tags;
    if (Array.isArray(tags)) {
      for (const tag of tags) if (typeof tag === "string") out.push(tag.replace(/[-_]/g, " "));
    }

    const track = getTrack(inputs.problem.track);
    if (track) out.push(track);

    // Capitalised or hyphenated multiwords out of the rubric are the technical
    // nouns; whole criterion sentences would be useless as keywords.
    for (const criterion of inputs.criteria ?? []) {
      for (const match of criterion.text.matchAll(/\b([A-Z][a-zA-Z0-9]{2,}(?:\s+[A-Z][a-zA-Z0-9]+)?)\b/g)) {
        out.push(match[1]);
      }
    }

    return out;
  }
}
