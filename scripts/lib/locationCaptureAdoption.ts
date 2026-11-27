import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { sql, type Transaction } from "kysely";
import { HQ_APP_SOURCE_MAX_BYTES } from "@/lib/commcare/hq/bounds";
import { parseHqJsonText } from "@/lib/commcare/hq/jsonText";
import { sourceCapturesLocation } from "@/lib/commcare/locationCapture";
import { type AppDatabase, getAppDb } from "@/lib/db/pg";
import { sourceFromBaseline } from "@/lib/deployment/hqChanges/baselineSource";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { locationDecision } from "../migrations/step7-location-capture.mjs";

interface Target {
	readonly deploymentId: string;
	readonly mappingId: string | null;
	readonly remoteId: string | null;
	readonly pushToken: string | null;
	readonly claim:
		| "held"
		| "released"
		| "claimed-elsewhere"
		| "ended"
		| "unmapped";
	readonly retainedRemoteId: string | null;
	readonly retainedChoice: boolean | null;
	readonly origin: string | null;
	readonly priorLocationOwnership: boolean | null;
	readonly server: string;
	readonly domain: string;
	readonly digest: string | null;
	readonly previous: boolean | null;
}
export interface AppLocationDecision {
	readonly appId: string;
	readonly projectId: string;
	readonly standing: string;
	readonly captureLocation: boolean;
	readonly targets: readonly Target[];
}

export async function scanLocationCaptureAdoptions() {
	const db = await getAppDb();
	return db
		.transaction()
		.setAccessMode("read only")
		.setIsolationLevel("repeatable read")
		.execute(locationCaptureSourceFacts);
}

/** A Step 7 candidate must carry its own exact GPS source settings. */
export function frozenLocationMap(settings: unknown): unknown {
	if (
		typeof settings !== "object" ||
		settings === null ||
		!("locationCapture" in settings)
	)
		throw new Error(
			"The completion plan is missing the frozen automatic location map.",
		);
	return settings.locationCapture;
}

/** Called in the cutover's own read snapshot and again after its writer fences. */
export async function checkSourceFacts(
	tx: Transaction<AppDatabase>,
	frozenMap: unknown,
) {
	const current = await locationCaptureSourceFacts(tx);
	if (canonicalJsonDigest(current) !== canonicalJsonDigest(frozenMap)) {
		throw new Error(
			"Automatic location source facts changed. Freeze the active targets again before converting.",
		);
	}
}

export async function locationCaptureSourceFacts(tx: Transaction<AppDatabase>) {
	const apps = await tx
		.selectFrom("apps")
		.select(["id", "project_id"])
		.orderBy("id")
		.execute();
	const mappings = await tx
		.selectFrom("app_deployments as d")
		.innerJoin("apps as a", (join) =>
			join
				.onRef("d.app_id", "=", "a.id")
				.onRef("d.project_id", "=", "a.project_id"),
		)
		.leftJoin("app_deployment_resources as r", (join) =>
			join
				.onRef("r.deployment_id", "=", "d.id")
				.onRef("r.nova_resource_id", "=", "d.app_id")
				.on("r.kind", "=", "app")
				.on("r.superseded_at", "is", null),
		)
		.select([
			"d.id",
			"d.app_id",
			"d.server",
			"d.domain",
			"d.state",
			"r.id as mappingId",
			"r.remote_id",
			"r.push_token",
			"r.released_at",
		])
		.where(sql<boolean>`a.connect_type IS NULL`)
		.orderBy("d.id")
		.execute();
	const byApp = new Map<string, Target[]>();
	for (const mapping of mappings) {
		const source = await tx
			.selectFrom("app_deployment_baselines")
			.select([
				"origin",
				"remote_app_id",
				"source_bytes",
				"source_digest",
				"source_gzip",
				"ownership",
			])
			.where("deployment_id", "=", mapping.id)
			.executeTakeFirst();
		let claim: Target["claim"] =
			mapping.state === "ended"
				? "ended"
				: mapping.remote_id === null
					? "unmapped"
					: mapping.released_at === null
						? "held"
						: "released";
		if (claim === "released" && mapping.remote_id !== null) {
			const other = await tx
				.selectFrom("app_deployment_resources as r")
				.innerJoin("app_deployments as d", "d.id", "r.deployment_id")
				.innerJoin("apps as a", "a.id", "d.app_id")
				.select("r.id")
				.where("d.server", "=", mapping.server)
				.where("d.domain", "=", mapping.domain)
				.where("r.kind", "=", "app")
				.where("r.remote_id", "=", mapping.remote_id)
				.where("d.app_id", "!=", mapping.app_id)
				.where("r.superseded_at", "is", null)
				.where("r.released_at", "is", null)
				.where("d.state", "!=", "ended")
				.where("a.deleted_at", "is", null)
				.executeTakeFirst();
			if (other) claim = "claimed-elsewhere";
		}
		let retainedChoice: boolean | null = null;
		if (
			source &&
			["push", "changes", "read", "cutover"].includes(source.origin) &&
			source.source_gzip !== null &&
			source.source_digest !== null
		) {
			if (
				source.source_bytes === null ||
				source.source_bytes <= 0 ||
				source.source_bytes > HQ_APP_SOURCE_MAX_BYTES
			)
				throw new Error(
					"A retained app source has an invalid size. Re-read the project space before converting.",
				);
			const bytes = gunzipSync(source.source_gzip, {
				maxOutputLength: HQ_APP_SOURCE_MAX_BYTES,
			});
			if (
				bytes.length !== source.source_bytes ||
				createHash("sha256").update(bytes).digest("hex") !==
					source.source_digest
			)
				throw new Error(
					"A retained app source failed its digest or size check. Re-read the project space before converting.",
				);
			const read = sourceFromBaseline(parseHqJsonText(bytes.toString("utf8")));
			if (
				Object.hasOwn(read.raw, "auto_gps_capture") &&
				typeof read.raw.auto_gps_capture !== "boolean"
			)
				throw new Error(
					"A retained app has an unreadable location choice. Re-read the project space before converting.",
				);
			retainedChoice = sourceCapturesLocation(read.raw);
		}
		const targets = byApp.get(mapping.app_id) ?? [];
		const prior = source?.ownership;
		const priorOwned =
			prior &&
			typeof prior === "object" &&
			"autoGpsCapture" in prior &&
			typeof prior.autoGpsCapture === "boolean"
				? prior.autoGpsCapture
				: null;
		targets.push({
			deploymentId: mapping.id,
			mappingId: mapping.mappingId,
			remoteId: mapping.remote_id,
			pushToken: mapping.push_token,
			claim,
			retainedRemoteId: source?.remote_app_id ?? null,
			retainedChoice,
			origin: source?.origin ?? null,
			priorLocationOwnership: priorOwned,
			server: mapping.server,
			domain: mapping.domain,
			digest: source?.source_digest ?? null,
			previous:
				claim === "held" && source?.remote_app_id === mapping.remote_id
					? retainedChoice
					: null,
		});
		byApp.set(mapping.app_id, targets);
	}
	const decisions: AppLocationDecision[] = apps.map((app) => {
		const targets = byApp.get(app.id) ?? [];
		return {
			appId: app.id,
			projectId: app.project_id,
			...locationDecision(targets),
			targets,
		};
	});
	return { decisions, digest: canonicalJsonDigest(decisions) };
}
