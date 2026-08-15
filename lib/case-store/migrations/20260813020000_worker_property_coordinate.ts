// Retained as a no-op migration key because local Unit E databases may have
// already recorded it. The unreleased intent-provenance table it altered was
// removed before production; the cleanup migration drops it locally.

import type { Kysely } from "kysely";

export async function up(_db: Kysely<unknown>): Promise<void> {}

export async function down(_db: Kysely<unknown>): Promise<void> {}
