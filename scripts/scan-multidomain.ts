/**
 * Read-only scan of `user_settings` to size the multi-domain backfill.
 *
 * Before this change, `verifyAndSaveCredentials` stored only the FIRST
 * project space a key reached, so a multi-space key's other spaces are
 * invisible until the user re-saves or refreshes. This scan reports how many
 * stored connections have a single stored space (the re-introspection
 * candidates) so the operator knows whether running `migrate-multidomain.ts`
 * is worthwhile.
 *
 * It cannot tell which single-space rows are ACTUALLY multi-space keys without
 * decrypting each key and re-querying HQ — that's the migrator's job. This
 * scan only counts shapes; it never decrypts a key or calls HQ.
 *
 * One-off — delete after the backfill runs (the source stays in git history).
 *
 * Usage:
 *   npx tsx scripts/scan-multidomain.ts        # read-only summary
 *   npx tsx scripts/scan-multidomain.ts --help
 */

import "dotenv/config";
import { getDb } from "@/lib/db/firestore";
import type { UserSettingsDoc } from "@/lib/db/types";
import { log } from "@/lib/logger";

const HELP_TEXT = `scan-multidomain — count user_settings by reachable-space shape (read-only)

Usage:
  npx tsx scripts/scan-multidomain.ts        Print the summary
  npx tsx scripts/scan-multidomain.ts --help Show this help

Reads every user_settings doc and reports the distribution of stored
approved_domains lengths plus how many have an active_domain default.
Makes no writes, no KMS decrypts, and no CommCare HQ calls.`;

interface ScanSummary {
	total: number;
	configured: number;
	singleSpace: number;
	multiSpace: number;
	withDefault: number;
	withoutDefault: number;
	/** Histogram of stored approved_domains length → doc count. */
	lengthDistribution: Record<number, number>;
}

async function run(): Promise<ScanSummary> {
	/* Read RAW (no Zod converter): a scan must tolerate pre-migration / partial
	 * rows. The strict `userSettingsConverter` would throw on the first
	 * non-conforming doc and abort the count; the per-row guards below treat
	 * every field as possibly-absent. */
	const snap = await getDb().collection("user_settings").get();

	let total = 0;
	let configured = 0;
	let singleSpace = 0;
	let multiSpace = 0;
	let withDefault = 0;
	let withoutDefault = 0;
	const lengthDistribution: Record<number, number> = {};

	for (const doc of snap.docs) {
		total += 1;
		const data = doc.data() as Partial<UserSettingsDoc>;
		const stored = data.approved_domains?.length ?? 0;

		/* A row missing the username or with zero stored spaces reads as
		 * unconfigured — out of scope for the backfill. */
		if (!data.commcare_username || stored === 0) continue;
		configured += 1;
		lengthDistribution[stored] = (lengthDistribution[stored] ?? 0) + 1;

		if (stored === 1) singleSpace += 1;
		else multiSpace += 1;

		if (data.active_domain) withDefault += 1;
		else withoutDefault += 1;
	}

	log.info(
		`[scan-multidomain] total_docs=${total} configured=${configured} ` +
			`single_space=${singleSpace} multi_space=${multiSpace} ` +
			`with_default=${withDefault} without_default=${withoutDefault}`,
	);
	log.info(
		`[scan-multidomain] length_distribution=${JSON.stringify(lengthDistribution)}`,
	);
	log.info(
		`[scan-multidomain] re-introspection candidates (single stored space, ` +
			`may actually be multi-space keys): ${singleSpace}`,
	);

	return {
		total,
		configured,
		singleSpace,
		multiSpace,
		withDefault,
		withoutDefault,
		lengthDistribution,
	};
}

// ── CLI entrypoint ───────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	if (process.argv.slice(2).includes("--help")) {
		console.log(HELP_TEXT);
		process.exit(0);
	}
	run().catch((err) => {
		console.error("Fatal:", err);
		process.exit(1);
	});
}
