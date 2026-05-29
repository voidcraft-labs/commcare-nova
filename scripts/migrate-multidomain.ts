/**
 * Backfill `user_settings.approved_domains` for keys that reach more spaces
 * than were stored, and stamp an explicit `active_domain` default.
 *
 * Before the multi-domain change, `verifyAndSaveCredentials` stored only the
 * FIRST project space a key reached. This script re-introspects each stored
 * key (decrypt → list domains → probe each in parallel via
 * `discoverAccessibleDomains`) and, when the key actually reaches more spaces
 * than were stored, replaces `approved_domains` with the full set. It also
 * sets `active_domain` to the user's CURRENT effective target (the old first
 * stored space) so uploads keep landing where they did — the user gains
 * visibility of the other spaces without their default silently moving.
 *
 * Safety contract:
 *   - **Dry-run is the default.** A bare invocation reads + classifies +
 *     prints the per-user diff with NO writes. Pass `--write` to persist.
 *   - An HQ API error for a key (revoked / expired) logs and SKIPS that user —
 *     it never clears a user's stored spaces on a transient failure.
 *   - A row whose discovered set equals its stored set is left untouched.
 *   - `--user-id=<id>` migrates a single user for surgical retry.
 *
 * Requires Application Default Credentials + GOOGLE_CLOUD_PROJECT (KMS decrypt
 * + HQ network calls). One-off — delete after the backfill runs.
 *
 * Usage:
 *   npx tsx scripts/migrate-multidomain.ts                     # dry-run (default)
 *   npx tsx scripts/migrate-multidomain.ts --write             # persist changes
 *   npx tsx scripts/migrate-multidomain.ts --user-id=abc --write
 *   npx tsx scripts/migrate-multidomain.ts --help
 */

import "dotenv/config";
import { FieldValue } from "@google-cloud/firestore";
import {
	type CommCareDomain,
	discoverAccessibleDomains,
} from "@/lib/commcare/client";
import { decrypt } from "@/lib/commcare/encryption";
import { getDb } from "@/lib/db/firestore";
import type { UserSettingsDoc } from "@/lib/db/types";
import { log } from "@/lib/logger";

const HELP_TEXT = `migrate-multidomain — backfill the full reachable-space set per stored key

Usage:
  npx tsx scripts/migrate-multidomain.ts              Dry-run (default): print diffs, no writes
  npx tsx scripts/migrate-multidomain.ts --write      Persist the backfill
  npx tsx scripts/migrate-multidomain.ts --user-id=<id> [--write]   Single user
  npx tsx scripts/migrate-multidomain.ts --help       Show this help

Re-introspects each stored API key and, when it reaches more project spaces
than were stored, replaces approved_domains with the full set and stamps
active_domain = the user's current effective target. Decrypts keys via KMS and
calls CommCare HQ, so it needs ADC + GOOGLE_CLOUD_PROJECT.`;

interface MigrateOptions {
	write: boolean;
	userId?: string;
	help: boolean;
}

function parseArgs(argv: string[]): MigrateOptions {
	const opts: MigrateOptions = { write: false, help: false };
	for (const arg of argv) {
		if (arg === "--help") opts.help = true;
		else if (arg === "--write") opts.write = true;
		else if (arg.startsWith("--user-id="))
			opts.userId = arg.slice("--user-id=".length);
		else throw new Error(`unknown argument: ${arg}`);
	}
	return opts;
}

/** Set equality on domain slugs — order-independent. */
function sameSpaceSet(a: CommCareDomain[], b: CommCareDomain[]): boolean {
	if (a.length !== b.length) return false;
	const names = new Set(a.map((d) => d.name));
	return b.every((d) => names.has(d.name));
}

async function run(opts: MigrateOptions): Promise<{ failed: number }> {
	/* Read RAW (no Zod converter): a backfill must tolerate pre-migration /
	 * partial rows. The strict `userSettingsConverter` would throw on the
	 * first non-conforming doc and abort the whole run; the per-row guards
	 * below treat every field as possibly-absent instead. */
	const settingsCollection = getDb().collection("user_settings");
	const docs = opts.userId
		? [await settingsCollection.doc(opts.userId).get()]
		: (await settingsCollection.get()).docs;

	if (opts.userId && !docs[0]?.exists) {
		log.warn(
			`[migrate-multidomain] user=${opts.userId} not found — nothing to do`,
		);
	}

	let scanned = 0;
	let migrated = 0;
	let unchanged = 0;
	let skipped = 0;
	let failed = 0;

	for (const doc of docs) {
		if (!doc.exists) continue;
		scanned += 1;
		const data = doc.data() as Partial<UserSettingsDoc> | undefined;
		const stored = data?.approved_domains ?? [];

		/* Unconfigured rows have nothing to re-introspect. */
		if (
			!data?.commcare_username ||
			!data.commcare_api_key ||
			stored.length === 0
		) {
			skipped += 1;
			continue;
		}

		let discovered: CommCareDomain[] | { status: number };
		try {
			const apiKey = await decrypt(data.commcare_api_key);
			const result = await discoverAccessibleDomains({
				username: data.commcare_username,
				apiKey,
			});
			discovered = Array.isArray(result) ? result : { status: result.status };
		} catch (err) {
			failed += 1;
			log.error(
				`[migrate-multidomain] user=${doc.id} decrypt/list failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			continue;
		}

		/* An HQ error (revoked/expired key) must NOT clear the stored set —
		 * skip and leave the row as-is. */
		if (!Array.isArray(discovered)) {
			failed += 1;
			log.error(
				`[migrate-multidomain] user=${doc.id} HQ error status=${discovered.status} — left unchanged`,
			);
			continue;
		}

		if (discovered.length === 0 || sameSpaceSet(discovered, stored)) {
			unchanged += 1;
			continue;
		}

		/* Preserve the user's CURRENT effective target without ever inventing
		 * one: an explicit prior default if still reachable; else — ONLY for a
		 * row that stored exactly one space — that space (what
		 * `approved_domains[0]` actually resolved to before this change); else
		 * the sole discovered space; otherwise leave the default unset. The
		 * `stored.length === 1` guard is load-bearing: a multi-space row saved
		 * with no default is a *deliberate* must-choose state, and binding it to
		 * `stored[0]` here would re-create the silent-wrong-target bug (#12) the
		 * whole change exists to kill. */
		const priorActive = data.active_domain;
		const oldEffective = stored.length === 1 ? stored[0]?.name : undefined;
		const inDiscovered = (name: string | undefined) =>
			!!name && discovered.some((d) => d.name === name);
		const activeName =
			(inDiscovered(priorActive) && priorActive) ||
			(inDiscovered(oldEffective) && oldEffective) ||
			(discovered.length === 1 ? discovered[0].name : undefined);

		/* Order the written set so the resolved default sits at index 0. The
		 * migration may run BEFORE the multi-domain code deploys, and the
		 * still-deployed app reads `approved_domains[0]` as the upload target
		 * (it has no `active_domain` concept). Keeping the preserved target
		 * first means an upload through the old app can't be silently
		 * redirected by a reordered set in the pre-deploy window; the new code
		 * reads `active_domain` and lands on the same space. */
		const reachable = activeName
			? [
					...discovered.filter((d) => d.name === activeName),
					...discovered.filter((d) => d.name !== activeName),
				]
			: discovered;

		log.info(
			`[migrate-multidomain] user=${doc.id} stored=${stored.length} ` +
				`discovered=${reachable.length} [${reachable
					.map((d) => d.name)
					.join(", ")}] active=${activeName ?? "(unset — must choose)"} ` +
				`write=${opts.write}`,
		);

		if (opts.write) {
			await doc.ref.set(
				{
					approved_domains: reachable,
					active_domain: activeName ?? FieldValue.delete(),
					updated_at: FieldValue.serverTimestamp(),
				},
				{ merge: true },
			);
		}
		migrated += 1;
	}

	log.info(
		`[migrate-multidomain] scanned=${scanned} migrated=${migrated} ` +
			`unchanged=${unchanged} skipped=${skipped} failed=${failed} write=${opts.write}`,
	);
	return { failed };
}

// ── CLI entrypoint ───────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	let opts: MigrateOptions;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		console.error("");
		console.error(HELP_TEXT);
		process.exit(2);
	}
	if (opts.help) {
		console.log(HELP_TEXT);
		process.exit(0);
	}
	run(opts)
		.then((summary) => {
			if (summary.failed > 0) process.exit(1);
		})
		.catch((err) => {
			console.error("Fatal:", err);
			process.exit(1);
		});
}
