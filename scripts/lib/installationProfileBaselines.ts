import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { type Kysely, sql } from "kysely";
import { readBuildProfiles } from "@/lib/commcare/hq/appSource";
import type { AppDatabase } from "@/lib/db/pg";

export async function scanInstallationProfileBaselines(
	db: Kysely<AppDatabase>,
) {
	const census = {
		empty: 0,
		named: 0,
		invalid: 0,
		unobserved: 0,
		privateWorkers: 0,
	};
	await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.execute(async (tx) => {
			await sql`SET TRANSACTION READ ONLY`.execute(tx);
			const rows = await tx
				.selectFrom("app_deployments")
				.select("id")
				.orderBy("id")
				.execute();
			for (const row of rows) {
				const baseline = await tx
					.selectFrom("app_deployment_baselines")
					.select(["source_gzip", "source_bytes", "source_digest"])
					.where("deployment_id", "=", row.id)
					.executeTakeFirst();
				if (!baseline?.source_gzip || !baseline.source_digest) {
					census.unobserved++;
					continue;
				}
				const source = gunzipSync(baseline.source_gzip, {
					maxOutputLength: Number(baseline.source_bytes),
				});
				if (
					createHash("sha256").update(source).digest("hex") !==
					baseline.source_digest
				)
					throw new Error("A retained app source failed its digest check.");
				const raw = JSON.parse(source.toString("utf8"));
				if (!Object.hasOwn(raw, "build_profiles")) {
					census.unobserved++;
					continue;
				}
				const profiles = readBuildProfiles(raw.build_profiles);
				if (
					!profiles ||
					!Array.isArray(raw.langs) ||
					profiles.some(
						(p) =>
							!p.langs.length ||
							new Set(p.langs).size !== p.langs.length ||
							p.langs.some((code) => !raw.langs.includes(code)),
					)
				) {
					census.invalid++;
					continue;
				}
				if (profiles.length) {
					census.named++;
					census.privateWorkers += profiles.filter(
						(p) => p.practiceWorkerId,
					).length;
				} else census.empty++;
			}
		});
	return census;
}
