import "server-only";

import type { Transaction } from "kysely";
import { readLookupReferencingApps } from "@/lib/db/lookupReferenceEdges";
import {
	hydrateReferenceApp,
	persistedReferenceApps,
} from "@/lib/db/persistedReferenceApps";
import type { AppDatabase } from "@/lib/db/pg";
import {
	extractLookupReferenceOccurrences,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { declaredPlatforms } from "@/lib/domain/platforms";
import { hasLookupDesignProtection } from "./designProtection";
import { LookupError } from "./errors";
import {
	lookupNameNeedsUseCheck,
	lookupPathNameExplanation,
	lookupPathNameIssue,
} from "./pathNames";
import type { LookupReferencingAppSummary } from "./types";

/** The app writer and the rename both check the name at its consuming slot
 * and on the app's declared platforms. A form-local path and a menu condition
 * can reach exactly the same identity and give different verdicts. */
function renameProblemInApp(
	doc: BlueprintDoc,
	tableId: LookupTableId,
	names: ReadonlyMap<LookupColumnId | undefined, string>,
): string | undefined {
	const tag = names.get(undefined);
	const platforms = declaredPlatforms(doc);
	for (const use of extractLookupReferenceOccurrences(
		doc,
		PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
	)) {
		if (use.tableId !== tableId) continue;
		const column =
			use.columnId === undefined ? undefined : names.get(use.columnId);
		for (const [part, name] of [
			["tag", tag],
			["column", column],
		] as const) {
			if (name === undefined) continue;
			const issue = lookupPathNameIssue(
				name,
				use.registrySlot,
				part,
				platforms,
			);
			if (issue === null) continue;
			const { moduleName, formName, fieldId } = use.location;
			const location = [moduleName, formName, fieldId]
				.filter(Boolean)
				.join(" / ");
			return `uses this ${part === "tag" ? "table" : "column"}${location ? ` at “${location}”` : ""}. The name “${name}” won't work here. ${lookupPathNameExplanation(issue)}`;
		}
	}
}

/** A rename changes the path printed by every use of this identity across
 * the Project. The caller holds the table FOR UPDATE; every app writer takes
 * FOR KEY SHARE on the union of its old and new targets before it commits. */
export async function assertLookupRenamesAllowed(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableId: LookupTableId,
	changes: readonly { columnId?: LookupColumnId; name: string }[],
): Promise<void> {
	const names = new Map<LookupColumnId | undefined, string>();
	for (const { columnId, name } of changes) {
		if (
			!lookupNameNeedsUseCheck(name, columnId === undefined ? "tag" : "column")
		)
			continue;
		names.set(columnId, name);
		// A pre-app design protects identities but has no committed carrier
		// from which to establish the intended use. Superseding the design or
		// finishing its app replaces this temporary protection with exact slots.
		if (await hasLookupDesignProtection(tx, projectId, tableId, columnId)) {
			throw new LookupError(
				"accepted_design",
				`An accepted app design uses this ${columnId ? "column" : "table"}. The name “${name}” only works in some places. You can use a name like “district_code” now, or try this name again once the design is finished or replaced.`,
			);
		}
	}
	if (!names.size) return;

	const [firstColumnId] = names.keys();
	const apps = await readLookupReferencingApps(tx, {
		projectId,
		tableId,
		columnId: names.size === 1 ? firstColumnId : undefined,
	});
	const blockingApps: LookupReferencingAppSummary[] = [];
	let explanation: string | undefined;
	for (const app of apps) {
		const row = await persistedReferenceApps(tx)
			.where("app.id", "=", app.appId)
			.where("app.project_id", "=", projectId)
			.executeTakeFirst();
		if (!row) continue;
		const problem = renameProblemInApp(
			hydrateReferenceApp(row),
			tableId,
			names,
		);
		if (problem === undefined) continue;
		blockingApps.push(app);
		explanation ??= `“${app.appName}”${app.deleted ? " (in the trash)" : ""} ${problem}`;
	}
	if (explanation !== undefined) {
		throw new LookupError(
			"referenced",
			`${explanation} You can use a name like “district_code”, or change how the app uses the data first.`,
			{ blockingApps },
		);
	}
}
