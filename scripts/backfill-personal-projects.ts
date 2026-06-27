/**
 * Backfill: provision a personal Project for every user who predates the
 * Projects feature. Idempotent — `ensurePersonalProject` is get-or-create, so
 * re-running is safe and only touches users still missing one. Run this BEFORE
 * `backfill-apps-project-id.ts` (which maps each app to its owner's personal
 * Project).
 *
 * Dry-run by default (reports the count it would provision). Pass `--apply`.
 *
 *   npx tsx scripts/backfill-personal-projects.ts            # dry run
 *   npx tsx scripts/backfill-personal-projects.ts --apply
 */
import { Command } from "commander";
import { getAuthDb } from "@/lib/auth/db";
import {
	ensurePersonalProject,
	personalProjectSlug,
} from "@/lib/auth/provisionProject";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";

interface Options {
	apply?: boolean;
}

const program = new Command();
program
	.description("Provision a personal Project for every pre-existing user")
	.option("--apply", "write to the database (default: dry run)");
program.parse();
const opts = program.opts<Options>();

async function main() {
	const apply = opts.apply === true;
	console.log(
		apply
			? "backfill-personal-projects — APPLY"
			: "backfill-personal-projects — SCAN (dry run)",
	);

	const authDb = await getAuthDb();
	try {
		const users = await authDb.selectFrom("auth_user").select(["id"]).execute();
		const orgs = await authDb
			.selectFrom("auth_organization")
			.select(["slug"])
			.execute();
		const slugs = new Set(orgs.map((o) => o.slug));
		const missing = users.filter((u) => !slugs.has(personalProjectSlug(u.id)));
		console.log(
			`${users.length} users  ·  ${missing.length} missing a personal Project`,
		);

		if (!apply) {
			console.log("\nmode: dry run — nothing written. Pass --apply to write.");
			return;
		}

		let provisioned = 0;
		for (const u of missing) {
			await ensurePersonalProject(u.id);
			provisioned += 1;
		}
		console.log(`provisioned: ${provisioned}`);
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
