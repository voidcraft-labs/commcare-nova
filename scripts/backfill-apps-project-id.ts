/**
 * Backfill: stamp `project_id` onto every Firestore app that predates the
 * Projects feature, mapping each app to its OWNER's personal Project. This is
 * the expand-phase data migration that must complete before the listing /
 * authorization reads switch from `owner` to `project_id` (P2/P3).
 *
 * `ensurePersonalProject` is get-or-create, so this also self-heals a user
 * whose personal Project the prior backfill missed — but run
 * `backfill-personal-projects.ts` first to keep this pass a pure stamp.
 *
 * The write is a TARGETED `update({ project_id })` only — it deliberately does
 * NOT route through the blueprint-snapshot writers, so it never rotates
 * `blueprint_token` (a live builder tab must not 409 over a metadata stamp).
 * Idempotent: an app that already has `project_id` is skipped. Owner → Project
 * id is cached so a multi-app owner resolves once.
 *
 * Dry-run by default. Pass `--apply` to write.
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
			: "backfill-apps-project-id — SCAN (dry run)",
	);

	const ownerToProject = new Map<string, string>();
	let total = 0;
	let stamped = 0;
	let alreadySet = 0;
	let ownerless = 0;

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
			let projectId = ownerToProject.get(owner);
			if (projectId === undefined) {
				projectId = await ensurePersonalProject(owner);
				ownerToProject.set(owner, projectId);
			}
			stamped += 1;
			if (apply) await snap.ref.update({ project_id: projectId });
		}

		console.log("");
		console.log(`apps total:        ${total}`);
		console.log(`already stamped:   ${alreadySet}`);
		console.log(`${apply ? "stamped" : "would stamp"}:        ${stamped}`);
		if (ownerless > 0) console.log(`ownerless (skipped): ${ownerless}`);
		if (!apply) {
			console.log("\nmode: dry run — nothing written. Pass --apply to write.");
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
