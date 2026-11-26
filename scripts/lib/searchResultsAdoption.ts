import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { Transaction } from "kysely";
import { HQ_APP_SOURCE_MAX_BYTES } from "@/lib/commcare/hq/bounds";
import { parseHqJsonText } from "@/lib/commcare/hq/jsonText";
import { type AppDatabase, getAppDb } from "@/lib/db/pg";
import { sourceFromBaseline } from "@/lib/deployment/hqChanges/baselineSource";
import { searchResultsNameSchema } from "@/lib/domain/modules";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** HQ normalizes form ids on every download but keeps menu unique_id. Only
 * the ledger connects that id to a Nova menu. A missing or repeated mapping
 * prevents choosing the menu from its current label or its array position. */
export function retainedSearchResultsNames(
	source: Readonly<Record<string, unknown>>,
	identities: readonly { unique_id: string | null; nova_entity_uuid: string }[],
) {
	const names: { menu: string; uniqueId: string; name: string | null }[] = [];
	if (!Array.isArray(source.modules))
		throw new Error("The adopted source has no menus.");
	const seen = new Set<string>();
	for (const module of source.modules) {
		if (
			!object(module) ||
			typeof module.unique_id !== "string" ||
			seen.has(module.unique_id)
		)
			throw new Error(
				"The adopted source has an unidentified or repeated menu.",
			);
		seen.add(module.unique_id);
		const value = object(module.search_config)
			? module.search_config.instance_name
			: undefined;
		const name =
			value === null || value === undefined || value === ""
				? null
				: searchResultsNameSchema.parse(value);
		const matches = identities.filter(
			(identity) => identity.unique_id === module.unique_id,
		);
		// HQ may also carry generated menus which never had a Nova entity.
		if (matches.length === 0 && name === null) continue;
		if (matches.length !== 1)
			throw new Error("A named search has no unique adopted menu identity.");
		names.push({
			menu: matches[0].nova_entity_uuid,
			uniqueId: module.unique_id,
			name,
		});
	}
	return names;
}

export async function searchResultsSourceFacts(tx: Transaction<AppDatabase>) {
	const targets = await tx
		.selectFrom("app_deployments as d")
		.innerJoin("apps as a", (join) =>
			join
				.onRef("a.id", "=", "d.app_id")
				.onRef("a.project_id", "=", "d.project_id"),
		)
		.innerJoin("app_deployment_resources as r", (join) =>
			join
				.onRef("r.deployment_id", "=", "d.id")
				.onRef("r.nova_resource_id", "=", "d.app_id")
				.onRef("r.server", "=", "d.server")
				.onRef("r.domain", "=", "d.domain"),
		)
		.leftJoin("app_deployment_baselines as b", "b.deployment_id", "d.id")
		.where("r.ownership", "=", "adopted")
		.where("r.kind", "=", "app")
		.where("r.superseded_at", "is", null)
		.where("r.released_at", "is", null)
		.where("r.remote_missing_at", "is", null)
		.where("a.deleted_at", "is", null)
		.where("d.state", "!=", "ended")
		.select([
			"d.id",
			"r.id as mapping_id",
			"d.app_id",
			"d.project_id",
			"d.server",
			"d.domain",
			"r.remote_id",
			"r.push_token",
			"r.adopted_by",
			"r.pushed_revision",
			"b.remote_app_id",
			"b.origin",
			"b.source_bytes",
			"b.source_digest",
			"b.nova_revision",
			"b.observed_by",
		])
		.orderBy("d.id")
		.execute();
	const evidence = [];
	for (const target of targets) {
		if (
			target.remote_app_id !== target.remote_id ||
			target.adopted_by === null ||
			target.observed_by === null ||
			target.origin === null ||
			!["read", "changes", "push"].includes(target.origin) ||
			(target.origin === "read" && target.observed_by !== target.adopted_by) ||
			target.nova_revision === null ||
			(target.origin === "push" &&
				target.pushed_revision !== target.nova_revision)
		)
			throw new Error(
				`The active adopted target ${target.id} needs a verified source for its current app before cutover.`,
			);
		const count = target.source_bytes;
		if (!count || count > HQ_APP_SOURCE_MAX_BYTES)
			throw new Error("An adopted source has an invalid byte count.");
		const body = await tx
			.selectFrom("app_deployment_baselines")
			.select("source_gzip")
			.where("deployment_id", "=", target.id)
			.executeTakeFirstOrThrow();
		if (!body.source_gzip) throw new Error("An adopted source is missing.");
		const bytes = gunzipSync(body.source_gzip, {
			maxOutputLength: HQ_APP_SOURCE_MAX_BYTES,
		});
		if (
			bytes.length !== count ||
			createHash("sha256").update(bytes).digest("hex") !== target.source_digest
		)
			throw new Error(
				"An adopted source failed its retained byte or digest check.",
			);
		const source = sourceFromBaseline(parseHqJsonText(bytes.toString("utf8")));
		const identities = await tx
			.selectFrom("app_deployment_identities")
			.select(["unique_id", "nova_entity_uuid"])
			.where("deployment_id", "=", target.id)
			.where("entity_kind", "=", "module")
			.execute();
		evidence.push({
			...target,
			menus: retainedSearchResultsNames(source.raw, identities),
		});
	}
	return { targets: evidence };
}

export async function scanSearchResultsAdoptions() {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(searchResultsSourceFacts);
}

/** Recheck inside the cutover transaction after the writer fence. */
export async function checkSearchResultsSourceFacts(
	tx: Transaction<AppDatabase>,
	frozen: unknown,
) {
	if (
		canonicalJsonDigest(await searchResultsSourceFacts(tx)) !==
		canonicalJsonDigest(frozen)
	)
		throw new Error(
			"The adopted Search source or identity changed. Freeze the current targets again.",
		);
}
