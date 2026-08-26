import { canaryDeploymentPlatform } from "./catalog/canary-deployment-platform.js";
import { distributedRateLimiter } from "./catalog/distributed-rate-limiter.js";
import { googleDocsCollaboration } from "./catalog/google-docs-collaboration.js";
import { netflixBrowseUi } from "./catalog/netflix-browse-ui.js";
import { netflixStreaming } from "./catalog/netflix-streaming.js";
import { ragKnowledgeAssistant } from "./catalog/rag-knowledge-assistant.js";
import { slackWorkspaceMessaging } from "./catalog/slack-workspace-messaging.js";
import { stripeIdempotentPayments } from "./catalog/stripe-idempotent-payments.js";
import { ticketmasterFlashSale } from "./catalog/ticketmaster-flash-sale.js";
import { twitterHomeTimeline } from "./catalog/twitter-home-timeline.js";
import { uberRideMatching } from "./catalog/uber-ride-matching.js";
import { urlShortener } from "./catalog/url-shortener.js";
import { whatsappMessaging } from "./catalog/whatsapp-messaging.js";
import { youtubeUploadWatch } from "./catalog/youtube-upload-watch.js";
import { validateSeedProblem, type SeedProblem } from "./types.js";

/**
 * The curated catalogue, ordered easiest-first so the dashboard reads sensibly.
 *
 * Adding a problem: drop a file in `catalog/`, export it, add it here, then run
 * `pnpm --filter @sdl/api db:seed --dry-run` to check it before writing.
 */
export const SEED_PROBLEMS: SeedProblem[] = [
  urlShortener,
  distributedRateLimiter,
  netflixBrowseUi,
  twitterHomeTimeline,
  whatsappMessaging,
  netflixStreaming,
  youtubeUploadWatch,
  ticketmasterFlashSale,
  stripeIdempotentPayments,
  slackWorkspaceMessaging,
  ragKnowledgeAssistant,
  canaryDeploymentPlatform,
  uberRideMatching,
  googleDocsCollaboration
];

/** Every seed's validation errors, prefixed with its slug. Empty means good. */
export function validateAllSeeds(): string[] {
  const errors: string[] = [];

  const seenSlugs = new Set<string>();
  const seenTitles = new Set<string>();
  for (const seed of SEED_PROBLEMS) {
    // Duplicate titles would make the upsert non-deterministic, since the
    // runner matches on title.
    if (seenSlugs.has(seed.slug)) errors.push(`${seed.slug}: duplicate slug`);
    if (seenTitles.has(seed.title)) errors.push(`${seed.slug}: duplicate title "${seed.title}"`);
    seenSlugs.add(seed.slug);
    seenTitles.add(seed.title);

    for (const error of validateSeedProblem(seed)) {
      errors.push(`${seed.slug}: ${error}`);
    }
  }

  return errors;
}

export { validateSeedProblem, type SeedProblem } from "./types.js";
