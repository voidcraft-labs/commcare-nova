/**
 * One-time media → Project tenancy migration. Media moved from per-owner to
 * per-Project scope: every asset now carries `project_id` (the tenant + the
 * only access gate) and its bytes live at `projects/<project_id>/…` instead of
 * `users/<owner>/…`. This stamps `project_id` (the owner's personal Project,
 * matching `backfill-apps-project-id`) AND relocates the bytes + the document
 * extract sibling so the stored `gcsObjectKey` points at the new path.
 *
 * Run AFTER `backfill-personal-projects` (it resolves each owner's personal
 * Project via `ensurePersonalProject`, get-or-create) AND after
 * `backfill-apps-project-id` — apps must carry `project_id` first, because the
 * media deletion guard scopes a referencing app by its `project_id`; stamping
 * media before apps would let the guard skip a still-referencing, not-yet-
 * stamped app and orphan its reference. Run it BEFORE the project-scoped code
 * serves traffic — the new code reads/writes the new paths and filters by
 * `project_id`. Reads use the stored `gcsObjectKey`, so the OLD code keeps
 * working against relocated bytes during the window (it ignores the extra
 * `project_id` field and queries by `owner`, which is untouched).
 *
 * Idempotent: an asset whose `gcsObjectKey` already starts with `projects/` is
 * skipped (already relocated). READY assets relocate their bytes; a PENDING row
 * (transient, reaped by the bucket lifecycle) only gets `project_id` stamped.
 *
 * Dry-run by default (read-only — counts what would move, resolves/writes
 * nothing). Pass `--apply` to migrate.
 *
 *   npx tsx scripts/backfill-media-project-id.ts            # scan
 *   npx tsx scripts/backfill-media-project-id.ts --apply
 */
import type { DocumentSnapshot } from "@google-cloud/firestore";
import { Command } from "commander";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import {
	extractGcsObjectKeyFor,
	gcsObjectKeyFor,
} from "@/lib/domain/multimedia";
import {
	copyAssetObject,
	deleteAsset as deleteGcsObject,
	getStoredObjectSize,
} from "@/lib/storage/media";
import { db } from "./lib/firestore";
import { runMain } from "./lib/main";

interface Options {
	apply?: boolean;
}

const program = new Command();
program
	.description(
		"Stamp project_id + relocate bytes (users/ → projects/) for media assets",
	)
	.option("--apply", "write to Firestore + GCS (default: dry run)");
program.parse();
const opts = program.opts<Options>();

/** A document asset's extract sibling under the OLD per-owner namespace —
 *  computed inline because the live `extractGcsObjectKeyFor` now emits the NEW
 *  project path. Only documents that recorded an extract have one. */
function oldExtractKey(
	owner: string,
	contentHash: string,
	version: number,
): string {
	return `users/${owner}/${contentHash}.extract.v${version}.md`;
}

/** Copy `src` → `dst` then delete `src`, but only if `src` exists. Returns
 *  whether bytes moved. Copy-before-delete so a crash leaves the source intact
 *  (the row's key still points at it) — re-running completes the move. */
async function relocateObject(src: string, dst: string): Promise<boolean> {
	if ((await getStoredObjectSize(src)) === null) return false;
	if ((await getStoredObjectSize(dst)) === null) {
		await copyAssetObject(src, dst);
	}
	await deleteGcsObject(src);
	return true;
}

async function main() {
	const apply = opts.apply === true;
	console.log(
		apply
			? "backfill-media-project-id — APPLY"
			: "backfill-media-project-id — SCAN (dry run, read-only)",
	);

	const ownerToProject = new Map<string, string>();
	let total = 0;
	let alreadyMigrated = 0;
	let ownerless = 0;
	let relocated = 0;
	let pendingStamped = 0;
	let extractsMoved = 0;
	let failed = 0;

	try {
		const stream = db
			.collection("mediaAssets")
			.stream() as AsyncIterable<DocumentSnapshot>;
		for await (const snap of stream) {
			total += 1;
			const gcsObjectKey = snap.get("gcsObjectKey") as string | undefined;
			// Already at a project path → relocated on a prior run.
			if (gcsObjectKey?.startsWith("projects/")) {
				alreadyMigrated += 1;
				continue;
			}
			const owner = snap.get("owner") as string | undefined;
			if (!owner) {
				ownerless += 1;
				console.warn(`  ! asset ${snap.id}: no owner — skipped`);
				continue;
			}
			const status = snap.get("status") as string | undefined;
			if (!apply) {
				// Read-only: count without resolving (which would create a Project).
				if (status === "ready") relocated += 1;
				else pendingStamped += 1;
				continue;
			}
			try {
				let projectId = ownerToProject.get(owner);
				if (projectId === undefined) {
					projectId = await ensurePersonalProject(owner);
					ownerToProject.set(owner, projectId);
				}

				// PENDING rows are transient (their bytes age out via the bucket
				// lifecycle); just stamp the tenant so the schema parses + a later
				// confirm scopes correctly.
				if (status !== "ready") {
					await snap.ref.update({ project_id: projectId });
					pendingStamped += 1;
					continue;
				}

				const contentHash = snap.get("contentHash") as string;
				const extension = snap.get("extension") as string;
				const kind = snap.get("kind") as string;
				const extractVersion = snap.get("extract.version") as
					| number
					| undefined;

				const newKey = gcsObjectKeyFor(projectId, contentHash, extension);
				if (gcsObjectKey) await relocateObject(gcsObjectKey, newKey);

				// Move the document extract sibling, if one was recorded.
				if (extractVersion !== undefined) {
					const moved = await relocateObject(
						oldExtractKey(owner, contentHash, extractVersion),
						extractGcsObjectKeyFor(projectId, contentHash, extractVersion),
					);
					if (moved) extractsMoved += 1;
				}

				await snap.ref.update({ project_id: projectId, gcsObjectKey: newKey });
				relocated += 1;
				// `kind` is read only to keep the scan output honest about document
				// extract relocation; no behavior depends on it here.
				void kind;
			} catch (err) {
				failed += 1;
				console.warn(
					`  ! asset ${snap.id} (owner ${owner}): migrate failed`,
					err,
				);
			}
		}

		console.log("");
		console.log(`assets total:          ${total}`);
		console.log(`already migrated:      ${alreadyMigrated}`);
		console.log(
			`${apply ? "relocated (ready)" : "would relocate"}:    ${relocated}`,
		);
		console.log(
			`${apply ? "pending stamped" : "pending to stamp"}:    ${pendingStamped}`,
		);
		if (apply) console.log(`extract siblings moved: ${extractsMoved}`);
		if (ownerless > 0) console.log(`ownerless (skipped):   ${ownerless}`);
		if (failed > 0) console.log(`FAILED:                ${failed}`);
		if (!apply) {
			console.log(
				"\nmode: dry run — nothing written. Pass --apply to migrate.",
			);
		}
		if (failed > 0) {
			console.error(
				`\n${failed} asset(s) FAILED to migrate (see warnings). Fix the cause and re-run; it is idempotent (already-relocated rows are skipped).`,
			);
			process.exitCode = 1;
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
