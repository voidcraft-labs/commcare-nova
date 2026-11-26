import type { Kysely, Transaction } from "kysely";
import { z } from "zod";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import { readReleasedFoldSnapshot } from "@/lib/case-store/migrations/20261208000000_connect_activity_roles";
import type { AppDatabase } from "@/lib/db/pg";
import { uuidSchema } from "@/lib/domain/uuid";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { completionSettingsSchema } from "../migrations/step7-completion";
import type { CompletionMigration } from "./completionWorkspaces";
import type { CompletionStorage } from "./hqRoundTripCompletion";
import {
	checkSourceFacts as checkLocationSourceFacts,
	locationCaptureSourceFacts,
} from "./locationCaptureAdoption";
import {
	checkMenuLayoutSourceFacts,
	scanMenuLayoutAdoptions,
} from "./menuLayoutAdoptionScan";

import {
	checkSearchResultsSourceFacts,
	searchResultsSourceFacts,
} from "./searchResultsAdoption";

const releasedLayoutDoc = z.object({
	appSettings: z
		.object({
			firstMenuLayout: z.literal("grid").optional(),
			formMenuLayout: z.enum(["grid", "individual"]).optional(),
		})
		.default({}),
	moduleOrder: z.array(uuidSchema),
	modules: z.record(
		z.string(),
		z.object({ menuLayout: z.literal("grid").optional() }),
	),
});

/** Layout adoption only reads the old snapshot's layout and menu identity
 * carriers. It can run before any candidate tables or roles exist. */
function releasedLayoutHeads(
	tx: Transaction<AppDatabase>,
	migration: CompletionMigration,
) {
	return async (appId: string) => {
		const row = await tx
			.selectFrom("apps")
			.select("mutation_seq")
			.where("id", "=", appId)
			.executeTakeFirst();
		if (!row) return null;
		return {
			doc: releasedLayoutDoc.parse(
				migration.readHead(await readReleasedFoldSnapshot(tx, appId)),
			),
			mutationSeq: safePersistedSequence(row.mutation_seq),
		};
	};
}

export async function freezeCompletionSettings(
	db: Kysely<AppDatabase>,
	migration: CompletionMigration,
) {
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const locationCapture = await locationCaptureSourceFacts(tx);
			const { decisions, digest } = await scanMenuLayoutAdoptions(
				tx,
				undefined,
				releasedLayoutHeads(tx, migration),
			);
			const searchResults = await searchResultsSourceFacts(tx);
			return completionSettingsSchema.parse({
				locationCapture,
				searchResults,
				menuLayouts: { decisions, digest },
			});
		});
}

export const step7CompletionStorage: CompletionStorage = {
	migrations: caseStoreMigrations,
	completionMigration: "20261209000000_hq_round_trip_complete",
	readReleasedHead: readReleasedFoldSnapshot,
	async checkSourceFacts(tx, migration) {
		const frozen = completionSettingsSchema.parse(migration.conversionSettings);
		await checkLocationSourceFacts(tx, frozen.locationCapture);
		await checkSearchResultsSourceFacts(tx, frozen.searchResults);
		await checkMenuLayoutSourceFacts(
			tx,
			frozen.menuLayouts,
			releasedLayoutHeads(tx, migration),
		);
	},
};
