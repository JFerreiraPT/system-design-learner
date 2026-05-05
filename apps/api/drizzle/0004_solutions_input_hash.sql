ALTER TABLE "solutions"
  ADD COLUMN IF NOT EXISTS "input_hash" text DEFAULT NULL;

CREATE INDEX IF NOT EXISTS "solutions_problem_input_hash_idx"
  ON "solutions" ("problem_id", "input_hash");
