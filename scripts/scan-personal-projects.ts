/**
 * Read-only scan for the Projects backfill: reports how many users lack a
 * personal Project (`auth_organization` row with the deterministic
 * `personal-<userId>` slug) and how many Firestore apps lack `project_id`.
 *
 * Run it before the backfill to size the work, and again after to confirm both
 * counts are zero. Never writes. Pairs with `backfill-personal-projects.ts`
 * and `backfill-apps-project-id.ts`.
 *
 *   npx tsx scripts/scan-personal-projects.ts
 */
import type { DocumentSnapshot } from "@google-cloud/firestore";
import { getAuthDb } from "@/lib/auth/db";
import { personalProjectSlug } from "@/lib/auth/provisionProject";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { db } from "./lib/firestore";
import { runMain } from "./lib/main";

async function main() {
	console.log("scan-personal-projects — SCAN (read-only)");

	const authDb = await getAuthDb();
	try {
		const users = await authDb.selectFrom("auth_user").select(["id"]).execute();
		const orgs = await authDb
			.selectFrom("auth_organization")
			.select(["slug"])
			.execute();
		const slugs = new Set(orgs.map((o) => o.slug));
		const missingPersonal = users.filter(
			(u) => !slugs.has(personalProjectSlug(u.id)),
		).length;
		console.log(
			`users: ${users.length}  ·  missing personal Project: ${missingPersonal}`,
		);

		let appsTotal = 0;
		let appsMissing = 0;
		const stream = db
			.collection("apps")
			.stream() as AsyncIterable<DocumentSnapshot>;
		for await (const snap of stream) {
			appsTotal += 1;
			// Apps written before `project_id` shipped have the field ABSENT (not
			// null), so check for nullish rather than querying `== null`.
			if (snap.get("project_id") == null) appsMissing += 1;
		}
		console.log(`apps: ${appsTotal}  ·  missing project_id: ${appsMissing}`);
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
