// Rewrite stored model ids from the AI Gateway's `creator/model-name` format
// to OpenAI's own ids ("openai/gpt-5.6-sol" → "gpt-5.6-sol"). Every LLM call
// now goes to OpenAI directly, so `run_summaries.model` — the one stored
// model id, and the key admin inspect tools use to recompute costs against
// `MODEL_PRICING` — must match the bare ids that table is keyed by.
//
// Forward-only in production; `down` exists for local/test teardown only.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`UPDATE "run_summaries" SET "model" = substring("model" from 8) WHERE "model" LIKE 'openai/%'`.execute(
		db,
	);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`UPDATE "run_summaries" SET "model" = 'openai/' || "model" WHERE "model" NOT LIKE 'openai/%'`.execute(
		db,
	);
}
