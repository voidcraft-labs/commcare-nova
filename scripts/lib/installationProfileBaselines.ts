import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { type Kysely, sql } from "kysely";
import {
	HQ_APP_SOURCE_MAX_BYTES,
	readBuildProfiles,
} from "@/lib/commcare/hq/appSource";
import type { AppDatabase } from "@/lib/db/pg";

/** Retained sources have the same upper bound as the source GET. A stored
 * length is a claim to verify, including when it is larger than the body. */
export function verifiedInstallationBaseline(row: {
	readonly source_gzip: Buffer;
	readonly source_bytes: number | null;
	readonly source_digest: string;
}): Buffer {
	const length = row.source_bytes;
	if (
		length === null ||
		!Number.isSafeInteger(length) ||
		length <= 0 ||
		length > HQ_APP_SOURCE_MAX_BYTES
	)
		throw new Error("A retained app source has an invalid declared length.");
	const source = gunzipSync(row.source_gzip, { maxOutputLength: length });
	if (source.length !== length)
		throw new Error(
			"A retained app source does not match its declared length.",
		);
	if (createHash("sha256").update(source).digest("hex") !== row.source_digest)
		throw new Error("A retained app source failed its digest check.");
	return source;
}

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
				const source = verifiedInstallationBaseline({
					source_gzip: baseline.source_gzip,
					source_bytes: baseline.source_bytes,
					source_digest: baseline.source_digest,
				});
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
