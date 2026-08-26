import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { problems } from "./schema.js";
import { SEED_PROBLEMS, validateAllSeeds } from "./seeds/index.js";

/**
 * Seed the curated problem catalogue.
 *
 *   pnpm --filter @sdl/api db:seed            # upsert every seed
 *   pnpm --filter @sdl/api db:seed --dry-run  # validate only, no writes
 *
 * Idempotent: seeds are matched on `title`, so re-running updates the existing
 * row in place rather than creating duplicates. Updating in place matters —
 * `interviews.problem_id` points at these rows, so a re-seed must not orphan
 * a session that is already running against one.
 *
 * Only ever touches rows whose title matches a seed. AI-generated problems are
 * never read, updated, or deleted.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadEnv({ path: resolve(packageRoot, "../../.env") });

const dryRun = process.argv.includes("--dry-run");

const problemErrors = validateAllSeeds();
if (problemErrors.length > 0) {
  console.error(`✖ ${problemErrors.length} seed validation error(s):\n`);
  for (const error of problemErrors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`✔ ${SEED_PROBLEMS.length} seed problems validated`);

if (dryRun) {
  console.log("--dry-run: no database writes");
  process.exit(0);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("✖ DATABASE_URL is not set (expected in the repo-root .env)");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const db = drizzle(pool);

let inserted = 0;
let updated = 0;

try {
  for (const seed of SEED_PROBLEMS) {
    const values = {
      title: seed.title,
      statement: seed.statement,
      difficulty: seed.difficulty,
      constraintsJson: seed.constraints,
      // Free-text rubric is legacy; structured criteria are generated per
      // interview. Kept as [] so the column stays non-null.
      evaluationRubricJson: [],
      tagsJson: seed.tags as unknown as string[],
      track: seed.track,
      estimationSpecJson: seed.estimationSpec as unknown as Record<string, unknown>,
      interviewPlanJson: seed.interviewPlan as unknown as Record<string, unknown>,
      narrativeJson: seed.narrative,
      // Null when a seed has no authored rubric — that problem simply falls
      // back to generating one per interview.
      seededRubricJson: seed.rubric ?? null,
      // These are curated, not model output. Nothing branches on this today,
      // but recording it honestly is the point of the column.
      generatedByAi: false
    };

    const existing = await db
      .select({ id: problems.id })
      .from(problems)
      .where(eq(problems.title, seed.title))
      .limit(1);

    if (existing[0]) {
      await db.update(problems).set(values).where(eq(problems.id, existing[0].id));
      updated += 1;
      console.log(`  ~ ${seed.title}`);
    } else {
      await db.insert(problems).values(values);
      inserted += 1;
      console.log(`  + ${seed.title}`);
    }
  }

  console.log(`\n✔ seeded: ${inserted} inserted, ${updated} updated`);
} catch (error) {
  console.error("✖ seeding failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
