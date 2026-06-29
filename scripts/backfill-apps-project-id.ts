/**
 * Backfill: stamp `project_id` onto every Firestore app that predates the
 * Projects feature, mapping each app to its OWNER's personal Project. This is
 * the expand-phase data migration the listing / authorization reads depend on.
 *
 * `ensurePersonalProject` is get-or-create, so this also self-heals a user
 * whose personal Project an earlier backfill missed — run
 * `backfill-personal-projects.ts` first to keep this pass a pure stamp.
 *
 * The write is a TARGETED `update({ project_id })` only — it deliberately does
 * NOT route through the blueprint-snapshot writers, so it never rotates
 * `blueprint_token` (a live builder tab must not 409 over a metadata stamp).
 * Idempotent: an app that already has `project_id` is skipped.
 *
 * Dry-run by default and strictly READ-ONLY in that mode (it does not resolve
 * or create any Project). Pass `--apply` to provision + stamp. A per-app
 * try/catch isolates a single failure (e.g. an app whose owner no longer has an
 * `auth_user` row) so one bad row can't abort the run; the script exits non-zero
 * if any app failed so the operator knows to investigate.
 *
 *   npx tsx scripts/backfill-apps-project-id.ts            # dry run
 *   npx tsx scripts/backfill-apps-project-id.ts --apply
 */
import type { DocumentSnapshot } from "@google-cloud/firestore";
import { Command } from "commander";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { db } from "./lib/firestore";
import { runMain } from "./lib/main";

interface Options {
	apply?: boolean;
}

const program = new Command();
program
	.description(
		"Stamp project_id (owner's personal Project) onto pre-existing apps",
	)
	.option("--apply", "write to Firestore (default: dry run)");
program.parse();
const opts = program.opts<Options>();

async function main() {
	const apply = opts.apply === true;
	console.log(
		apply
			? "backfill-apps-project-id — APPLY"
			: "backfill-apps-project-id — SCAN (dry run, read-only)",
	);

	const ownerToProject = new Map<string, string>();
	let total = 0;
	let stamped = 0;
	let alreadySet = 0;
	let ownerless = 0;
	let failed = 0;

	try {
		const stream = db
			.collection("apps")
			.stream() as AsyncIterable<DocumentSnapshot>;
		for await (const snap of stream) {
			total += 1;
			// Pre-`project_id` rows have the field ABSENT (not null); nullish covers
			// both. An app that already carries a project id is left untouched.
			if (snap.get("project_id") != null) {
				alreadySet += 1;
				continue;
			}
			const owner = snap.get("owner") as string | undefined;
			if (!owner) {
				ownerless += 1;
				console.warn(`  ! app ${snap.id}: no owner — skipped`);
				continue;
			}
			// Dry run is read-only: count what WOULD be stamped without resolving
			// (which would create a Project) or writing.
			if (!apply) {
				stamped += 1;
				continue;
			}
			try {
				let projectId = ownerToProject.get(owner);
				if (projectId === undefined) {
					projectId = await ensurePersonalProject(owner);
					ownerToProject.set(owner, projectId);
				}
				await snap.ref.update({ project_id: projectId });
				stamped += 1;
			} catch (err) {
				failed += 1;
				console.warn(`  ! app ${snap.id} (owner ${owner}): stamp failed`, err);
			}
		}

		console.log("");
		console.log(`apps total:        ${total}`);
		console.log(`already stamped:   ${alreadySet}`);
		console.log(`${apply ? "stamped" : "would stamp"}:        ${stamped}`);
		if (ownerless > 0) console.log(`ownerless (skipped): ${ownerless}`);
		if (failed > 0) console.log(`FAILED:            ${failed}`);
		if (!apply) {
			console.log("\nmode: dry run — nothing written. Pass --apply to write.");
		}
		// A real failure must not report as success — a deploy step keys on the
		// exit code, and the migration is incomplete until every app is stamped.
		if (failed > 0) {
			console.error(
				`\n${failed} app(s) FAILED to stamp (see warnings). Fix the cause (often an owner with no auth_user row) and re-run; it is idempotent.`,
			);
			process.exitCode = 1;
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
