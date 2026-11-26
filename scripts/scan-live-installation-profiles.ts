/** Read-only, version-bound census of the named installations on each live deployment.
 * The report may contain deployment identifiers. Keep it in the operator's private evidence. */
import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import {
	type HqBuildProfile,
	readBuildProfiles,
} from "@/lib/commcare/hq/appSource";
import {
	readHqAppSaveCounter,
	readHqAppSourceAtVersion,
} from "@/lib/commcare/hq/appSourceAtVersion";
import { type ProjectAccess, resolveAppScope } from "@/lib/db/appAccess";
import { getAppDb } from "@/lib/db/pg";
import { getHqCredentials } from "@/lib/db/settings";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { verifiedInstallationBaseline } from "./lib/installationProfileBaselines";
import {
	crossDestinationInstallations,
	portableInstallationDigest,
} from "./lib/installationProfileCensus";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const options = new Command()
	.option("--prod", "Read production with the operator's connection.")
	.parse()
	.opts<{ prod?: boolean }>();
if (options.prod) targetProdDb();

function describe(
	profiles: readonly HqBuildProfile[],
	languages: readonly string[],
	translations: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
) {
	const invalid = profiles.filter(
		(p) =>
			!p.langs.length ||
			new Set(p.langs).size !== p.langs.length ||
			p.langs.some((code) => !languages.includes(code)),
	).length;
	const sorted = [...profiles].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	return {
		state: invalid
			? "needs-profile-edit"
			: profiles.length
				? "profiles"
				: "empty",
		count: profiles.length,
		invalid,
		portable: invalid
			? null
			: portableInstallationDigest(profiles, translations[languages[0] ?? ""]),
		withPractice: profiles.filter((p) => p.practiceWorkerId).length,
		digest: canonicalJsonDigest(sorted),
	};
}

async function scan() {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("app_deployments as d")
		.innerJoin("apps as a", "a.id", "d.app_id")
		.innerJoin("app_deployment_resources as r", "r.deployment_id", "d.id")
		.leftJoin("app_deployment_baselines as b", "b.deployment_id", "d.id")
		.select([
			"d.id",
			"d.app_id",
			"d.project_id",
			"d.server",
			"d.domain",
			"d.created_by",
			"r.remote_id",
			"r.adopted_by",
			"b.observed_by",
		])
		.where("d.state", "!=", "ended")
		.where("a.deleted_at", "is", null)
		.whereRef("a.project_id", "=", "d.project_id")
		.where("r.kind", "=", "app")
		.where("r.superseded_at", "is", null)
		.where("r.released_at", "is", null)
		.orderBy("d.id")
		.execute();
	const destinations: { app: string; portable: string | null }[] = [];
	for (const row of rows) {
		const id = row.id;
		const remote = canonicalJsonDigest([
			row.app_id,
			row.project_id,
			row.server,
			row.domain,
			row.remote_id,
		]);
		// Stream one retained source at a time. Only version and digests leave this process.
		const stored = await db
			.selectFrom("app_deployment_baselines")
			.select(["source_gzip", "source_bytes", "source_digest", "remote_app_id"])
			.where("deployment_id", "=", id)
			.executeTakeFirst();
		let baseline: ReturnType<typeof describe> | undefined;
		if (
			stored?.remote_app_id === row.remote_id &&
			stored.source_gzip &&
			stored.source_digest
		) {
			const bytes = verifiedInstallationBaseline({
				source_gzip: stored.source_gzip,
				source_bytes: stored.source_bytes,
				source_digest: stored.source_digest,
			});
			const source = JSON.parse(bytes.toString("utf8"));
			const profiles = readBuildProfiles(
				source.build_profiles,
				new Set(Array.isArray(source.langs) ? source.langs : []),
				Array.isArray(source.modules) ? source.modules.length : undefined,
			);
			if (profiles && Array.isArray(source.langs))
				baseline = describe(profiles, source.langs, source.translations);
		}
		let result: Record<string, unknown> = {
			state: "unknown",
			reason:
				"No current Project editor associated with this deployment has an approved connection to the destination.",
		};
		for (const actor of new Set([
			row.observed_by,
			row.adopted_by,
			row.created_by,
		])) {
			if (!actor) continue;
			let access: ProjectAccess;
			try {
				access = await resolveAppScope(row.app_id, actor, "edit");
			} catch {
				continue;
			}
			if (access.projectId !== row.project_id) continue;
			try {
				const connection = await getHqCredentials(actor, row.domain);
				if (!connection.ok || connection.creds.server !== row.server) continue;
				const version = await readHqAppSaveCounter(
					connection.creds,
					row.domain,
					row.remote_id,
				);
				if (typeof version !== "number") {
					result = {
						state: "unknown",
						reason: "Current save counter unavailable",
						status: version.status,
					};
					continue;
				}
				const read = await readHqAppSourceAtVersion(
					connection.creds,
					row.domain,
					row.remote_id,
					version,
				);
				if ("success" in read) {
					result = read.installationProfileKeyUnusable
						? {
								state: "needs-profile-edit",
								reason:
									"Recreate the profile whose ID cannot select a separate set of installation files on Releases, then check again.",
							}
						: {
								state: "unknown",
								reason: "Current source unavailable",
								status: read.status,
							};
					continue;
				}
				if (read.kind !== "source-at") {
					result = { state: "unknown", reason: read.kind };
					continue;
				}
				const live = describe(
					read.source.buildProfiles,
					read.source.langs,
					read.source.translations,
				);
				result = {
					...live,
					version,
					comparison: baseline
						? live.digest === baseline.digest
							? "agrees"
							: "split"
						: "no-retained-definition",
				};
				break;
			} catch (error) {
				result = {
					state: "unknown",
					reason: "Authorized connection could not complete the read",
					errorClass: error instanceof Error ? error.name : "unknown",
				};
			}
		}
		const app = canonicalJsonDigest([row.project_id, row.app_id]);
		destinations.push({
			app,
			portable: typeof result.portable === "string" ? result.portable : null,
		});
		console.log(
			JSON.stringify({
				app,
				deployment: id,
				target: remote,
				observedAt: new Date().toISOString(),
				baseline: baseline ?? null,
				live: result,
			}),
		);
	}
	console.log(
		JSON.stringify({
			completed: true,
			targets: rows.length,
			apps: crossDestinationInstallations(destinations),
		}),
	);
}
runMain(async () => {
	try {
		await scan();
	} finally {
		await closeCaseStoreDatabase();
	}
});
