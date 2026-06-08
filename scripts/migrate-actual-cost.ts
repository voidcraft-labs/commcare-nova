/**
 * ⚠️  WRITES TO PRODUCTION under --apply — Credit-system migration writer.
 *
 * Three independent, opt-in actions run the post-merge cut-over (with the user):
 *
 *   --rebaseline-cost  Re-baseline `usage/{owner}/months/{period}.cost_estimate`
 *                      from the authoritative run-ledger (the truer source the
 *                      usage docs historically under-count).
 *   --seed-credits     Seed every existing user's CURRENT-period credit doc so
 *                      the gate reads a real balance from day one.
 *   --delete-orphan    Delete the stashed `unadjusted_estimate` orphan key from
 *                      mmaher's April usage doc. A SEPARATE guarded pass run only
 *                      AFTER the April cost re-baseline is durably applied and
 *                      confirmed in PROD — its precondition refuses to delete
 *                      until April's `cost_estimate` has absorbed the stash.
 *
 * ## The decisive safety rule (re-baseline)
 *
 * Re-baselining a CLOSED month is reporting-only and safe, so closed-month
 * writes apply automatically. The CURRENT month's `cost_estimate` feeds the live
 * actual-cost backstop (`cost_estimate >= ACTUAL_COST_BACKSTOP_USD` → the chat
 * gate 429s every POST), so a current-month re-baseline can RE-BLOCK a user a
 * manual reset just unblocked. Therefore current-month cells are written ONLY
 * for owners named explicitly via a repeatable `--current-user <email>` flag;
 * every other current-month cell is surfaced (loudly when over the backstop) and
 * never silently written. The partition is computed by the pure `planRebaseline`.
 *
 * ## Create-only seed
 *
 * `--seed-credits` uses `ref.create()`, never `.set()`: an existing credit doc
 * is a LIVE balance (a user already spent this period, or an admin already
 * granted/reset). Clobbering it would erase real consumption. `create()` rejects
 * an existing doc with gRPC ALREADY_EXISTS (code 6) — caught and counted as
 * "skipped — already active"; any other error rethrows (a real write failure
 * must never masquerade as a benign skip).
 *
 * Dry run is the DEFAULT and performs ZERO writes — every `.set`/`.create`/
 * `.update` is reachable only under `--apply`. Run with `--help` for flags.
 */
import { FieldValue } from "@google-cloud/firestore";
import { Command } from "commander";
import {
	ACTUAL_COST_BACKSTOP_USD,
	MONTHLY_CREDIT_ALLOWANCE,
} from "@/lib/db/creditPolicy";
import { loadReconciliationData } from "./lib/creditMigrationData";
import {
	creditReconcile,
	planRebaseline,
	type RebaselineWrite,
} from "./lib/creditReconcile";
import { db } from "./lib/firestore";
import { runMain } from "./lib/main";

// ── CLI ─────────────────────────────────────────────────────────────

interface MigrateOptions {
	apply?: boolean;
	rebaselineCost?: boolean;
	seedCredits?: boolean;
	deleteOrphan?: boolean;
	orphanAcceptLedger?: boolean;
	/** Accumulated `--current-user` emails (commander `collect` into an array). */
	currentUser: string[];
}

/**
 * Commander variadic-option reducer: each repeated `--current-user <email>`
 * appends to the accumulating array (commander hands the prior value back).
 */
function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

const program = new Command();
program
	.name("migrate-actual-cost")
	.description(
		"Credit-system migration writer. Defaults to a dry run — pass --apply to write. Re-baselines closed-month cost automatically; current-month cost only for --current-user opt-ins. Seeds current-period credit docs create-only. Deletes the stashed unadjusted_estimate orphan (a separate guarded pass run AFTER the re-baseline is confirmed).",
	)
	.option("--apply", "actually write (default: dry run, writes nothing)")
	.option(
		"--rebaseline-cost",
		"re-baseline usage cost_estimate from the ledger",
	)
	.option("--seed-credits", "seed every user's current-period credit doc")
	.option(
		"--delete-orphan",
		"delete the stashed unadjusted_estimate orphan (run AFTER the re-baseline is confirmed)",
	)
	.option(
		"--orphan-accept-ledger",
		"delete the orphan even when the re-baselined cost_estimate lands slightly below the stash — accepts the run-ledger as the true cost (the stash over-counted). Bounded: a shortfall over $1 still refuses (proof the re-baseline never ran)",
	)
	.option(
		"--current-user <email>",
		"opt a user IN to a current-month cost re-baseline (repeatable)",
		collect,
		[],
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-actual-cost.ts --rebaseline-cost                       # dry run\n" +
			"  $ npx tsx scripts/migrate-actual-cost.ts --rebaseline-cost --current-user a@x.com # preview a's current month too\n" +
			"  $ npx tsx scripts/migrate-actual-cost.ts --rebaseline-cost --apply               # write closed months\n" +
			"  $ npx tsx scripts/migrate-actual-cost.ts --seed-credits                          # dry run\n" +
			"  $ npx tsx scripts/migrate-actual-cost.ts --seed-credits --apply                  # create-only seed\n" +
			"  $ npx tsx scripts/migrate-actual-cost.ts --delete-orphan                         # dry run\n" +
			"  $ npx tsx scripts/migrate-actual-cost.ts --delete-orphan --apply                 # delete orphan (after re-baseline confirmed)\n",
	);

program.parse();

const opts = program.opts<MigrateOptions>();
const apply = opts.apply === true;
const doRebaseline = opts.rebaselineCost === true;
const doSeed = opts.seedCredits === true;
const doDeleteOrphan = opts.deleteOrphan === true;
const orphanAcceptLedger = opts.orphanAcceptLedger === true;
/* Normalize opt-in emails (trim + lowercase) so an operator's casing/whitespace
 * can't silently miss a current-month cell at the live apply. The empty filter
 * is a PROD-write safety guard: a `--current-user "$VAR"` with an unset shell
 * var passes `""`, and an unresolved owner's email also folds to `""`, so an
 * empty opt-in entry would otherwise match EVERY unresolved-email current-month
 * cell at once — the exact silent current-month re-baseline the design forbids.
 * Dropping empties here (and refusing `""` in the planner) closes that hole. */
const currentUserEmails = new Set(
	opts.currentUser.map((e) => e.trim().toLowerCase()).filter((e) => e !== ""),
);

// ── USD formatting (local — the migrator prints its own plan) ───────

function usd(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

// ── Action: re-baseline cost ────────────────────────────────────────

/**
 * Re-baseline usage `cost_estimate` from the run-ledger.
 *
 * Reads via the SAME loader the scan previews with (so the apply matches the
 * preview), reconciles (pure), then partitions with `planRebaseline`: closed
 * writes + opted-in current writes apply; non-opted current cells are surfaced
 * and skipped. Under `--apply` each applied write is a MERGE set (so sibling
 * usage fields — request_count, tokens — survive), then re-read to confirm.
 */
async function rebaselineCost(): Promise<void> {
	const { runs, currentUsage, currentPeriod, emailOf } =
		await loadReconciliationData();
	const rows = creditReconcile(
		runs,
		currentUsage,
		currentPeriod,
		ACTUAL_COST_BACKSTOP_USD,
	);
	const plan = planRebaseline(rows, currentUserEmails, emailOf);

	const email = (ownerId: string): string => emailOf.get(ownerId) ?? ownerId;

	console.log(`── Re-baseline cost (current period ${currentPeriod}) ──\n`);

	// Echo any --current-user that matched no current-month cell so an operator
	// typo is VISIBLE rather than a silent no-op at the real apply.
	const matchedOptIns = new Set(
		plan.currentWrites.map((w) => email(w.ownerId).trim().toLowerCase()),
	);
	for (const requested of currentUserEmails) {
		if (!matchedOptIns.has(requested)) {
			console.log(
				`  ⚠️  --current-user ${requested} matched NO current-month cell ` +
					"(already baselined, or email typo / not an owner).",
			);
		}
	}

	// Closed months — always applied (reporting-only, safe).
	console.log(`\n  Closed-month writes (apply): ${plan.closedWrites.length}`);
	for (const w of plan.closedWrites) {
		console.log(
			`    ${email(w.ownerId)} ${w.period}: ${usd(w.from)} → ${usd(w.to)}`,
		);
	}

	// Opted-in current-month writes — applied because explicitly named.
	console.log(
		`\n  Current-month writes (opted in, apply): ${plan.currentWrites.length}`,
	);
	for (const w of plan.currentWrites) {
		console.log(
			`    ${email(w.ownerId)} ${w.period}: ${usd(w.from)} → ${usd(w.to)}`,
		);
	}

	// Skipped current-month cells — surfaced, never written; over-backstop loud.
	console.log(
		`\n  Current-month SKIPPED (not opted in): ${plan.currentSkipped.length}`,
	);
	for (const w of plan.currentSkipped) {
		const marker = w.overBackstop
			? `  ⚠️  OVER ${usd(ACTUAL_COST_BACKSTOP_USD)} — applying would RE-BLOCK`
			: "";
		console.log(
			`    ${email(w.ownerId)} ${w.period}: ${usd(w.from)} → ${usd(w.to)}` +
				`${marker}\n      opt in with --current-user ${email(w.ownerId)}`,
		);
	}

	// Every applicable write = closed + opted-in current.
	const toApply: RebaselineWrite[] = [
		...plan.closedWrites,
		...plan.currentWrites,
	];

	if (!apply) {
		console.log(
			`\n  DRY RUN — would set ${toApply.length} cell(s). Add --apply to write.`,
		);
		return;
	}

	console.log(`\n  Applying ${toApply.length} write(s)…`);
	// Accumulate confirmation failures across the loop. The per-write re-read is
	// only an honest guard if a mismatch actually changes the outcome — otherwise
	// a failed write still prints the green "complete" banner and exits 0, which
	// is exactly the "claim done while diagnostics remain" failure mode.
	let failed = 0;
	for (const w of toApply) {
		const ref = db
			.collection("usage")
			.doc(w.ownerId)
			.collection("months")
			.doc(w.period);
		// MERGE so request_count / tokens / other usage fields are untouched —
		// this re-baselines ONLY cost_estimate.
		await ref.set(
			{ cost_estimate: w.to, updated_at: FieldValue.serverTimestamp() },
			{ merge: true },
		);
		// Re-read and confirm the write landed (within float tolerance).
		const after = await ref.get();
		const wrote = (after.data() as { cost_estimate?: number } | undefined)
			?.cost_estimate;
		const ok = typeof wrote === "number" && Math.abs(wrote - w.to) < 1e-9;
		if (!ok) failed++;
		console.log(
			`    ${ok ? "✓" : "✗"} ${email(w.ownerId)} ${w.period}: ${usd(w.to)}` +
				(ok ? "" : `  (read back ${wrote ?? "undefined"})`),
		);
	}

	if (failed > 0) {
		// A confirmation failure is a real defect on a PROD writer — surface it
		// loudly and exit non-zero so the operator re-runs/investigates rather
		// than trusting a green banner.
		process.exitCode = 1;
		console.error(
			`\n  ✗ ${failed} of ${toApply.length} write(s) did not confirm — re-run or investigate.`,
		);
		return;
	}
	console.log("\n  ✓ Re-baseline complete.");
}

// ── Action: seed credit docs (create-only) ──────────────────────────

/** Whether an error is the gRPC ALREADY_EXISTS (code 6) `.create()` raises. */
function isAlreadyExists(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code: unknown }).code === 6
	);
}

/**
 * Seed `credits/{uid}/months/{currentPeriod}` for every existing user.
 *
 * CREATE-ONLY: an existing doc is a live balance (real consumption / a prior
 * admin grant) and must never be clobbered, so dry run classifies via `.get()`
 * and apply uses `ref.create()`, catching ALREADY_EXISTS (code 6) as a benign
 * "already active" skip while rethrowing any other failure.
 */
async function seedCredits(): Promise<void> {
	const currentPeriod = new Date().toISOString().slice(0, 7);
	const usersSnap = await db.collection("auth_users").get();

	console.log(`── Seed credits (current period ${currentPeriod}) ──\n`);
	console.log(`  Users: ${usersSnap.size}`);

	const emailOf = new Map<string, string>();
	for (const doc of usersSnap.docs) {
		emailOf.set(doc.id, (doc.data() as { email?: string }).email ?? doc.id);
	}

	let seeded = 0;
	const skipped: string[] = [];

	for (const userDoc of usersSnap.docs) {
		const uid = userDoc.id;
		const ref = db
			.collection("credits")
			.doc(uid)
			.collection("months")
			.doc(currentPeriod);

		if (!apply) {
			// Dry run: classify WITHOUT writing — absent → would seed, present → skip.
			const existing = await ref.get();
			if (existing.exists) skipped.push(uid);
			else seeded++;
			continue;
		}

		try {
			// Build the write payload (incl. the serverTimestamp sentinel) ONLY on
			// the apply path — a fresh, untouched monthly balance.
			await ref.create({
				allowance: MONTHLY_CREDIT_ALLOWANCE,
				consumed: 0,
				bonus: 0,
				updated_at: FieldValue.serverTimestamp(),
			});
			seeded++;
		} catch (err) {
			// An existing doc is a live balance — count the skip, never clobber.
			if (isAlreadyExists(err)) skipped.push(uid);
			else throw err; // a real write failure must surface, not look benign
		}
	}

	const verb = apply ? "Seeded" : "Would seed";
	console.log(`\n  ${verb}:  ${seeded}`);
	console.log(`  Skipped (already active): ${skipped.length}`);
	for (const uid of skipped) {
		console.log(`    ${emailOf.get(uid) ?? uid}`);
	}

	if (!apply) {
		console.log("\n  DRY RUN — wrote nothing. Add --apply to seed.");
	} else {
		console.log("\n  ✓ Seed complete (create-only — no existing doc touched).");
	}
}

// ── Action: delete the stashed unadjusted_estimate orphan ───────────

/* The ONE known orphan this action exists to remove. During an operational
 * reset an off-schema `unadjusted_estimate` key was hand-stashed into mmaher's
 * April usage doc as the only PROD record of his pre-reset April actual-cost.
 * These constants pin the action to that single, specific cell — this is a
 * one-shot cleanup of a known artifact, not a general-purpose key remover. */
const ORPHAN_USER = "w4KlwedcG1WijXOK0hVz"; // mmaher
const ORPHAN_PERIOD = "2026-04"; // a CLOSED month
const ORPHAN_KEY = "unadjusted_estimate";
/** Ledger-as-truth ceiling for `--orphan-accept-ledger`. The re-baseline writes
 *  the run-ledger's true April cost; when the stash over-counted, that lands a few
 *  cents BELOW the stash. Accept the ledger in that case — but only when the
 *  shortfall is under this much. A forgotten re-baseline leaves cost at the
 *  near-zero pre-reset value (a shortfall far over this), which still refuses, so
 *  the override can never silently discard the real cost. */
const MAX_ORPHAN_LEDGER_SHORTFALL_USD = 1;

/**
 * Delete the stashed `unadjusted_estimate` orphan key from mmaher's April
 * usage doc — a SEPARATE, idempotent pass run AFTER the April cost re-baseline
 * is durably applied and confirmed in PROD.
 *
 * ## Why a distinct action (not folded into --rebaseline-cost)
 *
 * The orphan is the only surviving record of the under-counted pre-reset April
 * cost. `--rebaseline-cost --apply` overwrites April's `cost_estimate` with the
 * truer ledger sum (which is ≥ the stash) — that fold is what makes the orphan
 * safe to drop. Deleting it is therefore strictly downstream of the fold, and
 * keeping it a separate flag lets us confirm the fold landed in PROD *first*,
 * then delete in a second, deliberate pass rather than racing both in one run.
 *
 * ## Why the precondition guard
 *
 * We refuse to delete unless April's live `cost_estimate` is a finite number
 * `>= orphan`. That is the proof the fold already absorbed the stashed value;
 * deleting before the fold would discard the only record of cost the ledger
 * baseline hadn't yet replaced. The guard throws (via `runMain` → exit 1) so a
 * premature run fails loudly and writes nothing.
 *
 * ## Why idempotent
 *
 * The cleanup may be re-run for confirmation. A missing doc or an
 * already-removed key is a clean no-op, not an error — so a second `--apply`
 * (after a successful delete) reports "already deleted" and exits 0.
 */
async function deleteOrphan(): Promise<void> {
	console.log(
		`── Delete orphan key \`${ORPHAN_KEY}\` (usage/${ORPHAN_USER}/months/${ORPHAN_PERIOD}) ──\n`,
	);

	const ref = db
		.collection("usage")
		.doc(ORPHAN_USER)
		.collection("months")
		.doc(ORPHAN_PERIOD);
	const snap = await ref.get();

	// Idempotent: a missing doc means there is nothing to clean up. Not an error.
	if (!snap.exists) {
		console.log(
			`  usage/${ORPHAN_USER}/months/${ORPHAN_PERIOD} doesn't exist — nothing to delete.`,
		);
		return;
	}

	// Type the read to the two keys this action reasons about. The orphan key is
	// spelled literally here (TS can't use the `ORPHAN_KEY` value as a type key);
	// it MUST stay in sync with the `ORPHAN_KEY` const above.
	const data = (snap.data() ?? {}) as {
		cost_estimate?: number;
		unadjusted_estimate?: number;
	};
	const orphan = data[ORPHAN_KEY];

	// Idempotent: an already-removed (or never-present) key is a clean no-op, so a
	// second --apply after a successful delete reports done and exits 0.
	if (orphan === undefined) {
		console.log(
			`  no \`${ORPHAN_KEY}\` key present — already deleted (or never existed); nothing to do.`,
		);
		return;
	}

	// The precondition: April's live cost must be a finite number that has absorbed
	// the stashed value. Normally that means `cost >= orphan` — proof the re-baseline
	// fold ran. But the run-ledger (the authoritative source the re-baseline writes)
	// can land slightly BELOW the stash when the stash over-counted; `--orphan-accept-
	// ledger` opts into deleting anyway, treating the ledger as truth — but ONLY when
	// the shortfall is under the ceiling, so a forgotten re-baseline (cost still at the
	// near-zero pre-reset value) still refuses rather than discard the real cost.
	const cost = data.cost_estimate;
	if (!(typeof cost === "number" && Number.isFinite(cost))) {
		throw new Error(
			`cost_estimate (${cost}) is not a finite number for ` +
				`usage/${ORPHAN_USER}/months/${ORPHAN_PERIOD} — run \`--rebaseline-cost --apply\` first.`,
		);
	}
	if (cost < orphan) {
		const shortfall = orphan - cost;
		if (!(orphanAcceptLedger && shortfall <= MAX_ORPHAN_LEDGER_SHORTFALL_USD)) {
			throw new Error(
				`cost_estimate (${cost}) is below the stashed unadjusted_estimate (${orphan}) ` +
					`for usage/${ORPHAN_USER}/months/${ORPHAN_PERIOD}. Run \`--rebaseline-cost --apply\`, ` +
					"confirm it, then re-run `--delete-orphan`" +
					(orphanAcceptLedger
						? ` — the $${shortfall.toFixed(4)} shortfall exceeds the $${MAX_ORPHAN_LEDGER_SHORTFALL_USD} ` +
							"ledger-acceptance ceiling, so the re-baseline hasn't landed yet."
						: " (or pass `--orphan-accept-ledger` to accept the run-ledger as truth)."),
			);
		}
		console.log(
			`  ledger-as-truth: cost_estimate ${cost} is $${shortfall.toFixed(4)} under the ` +
				`stash ${orphan} — accepting the ledger, discarding the over-count.`,
		);
	}

	// Dry run is the default and deletes nothing — only describe the planned write.
	if (!apply) {
		console.log(
			`  would delete \`${ORPHAN_KEY}\`=${orphan} from ` +
				`usage/${ORPHAN_USER}/months/${ORPHAN_PERIOD} ` +
				`(cost_estimate=${cost}). Add --apply to delete.`,
		);
		return;
	}

	// Remove ONLY the orphan key — a field delete sentinel leaves cost_estimate
	// and every sibling usage field untouched.
	await ref.update({ [ORPHAN_KEY]: FieldValue.delete() });

	// Re-read and confirm the key is actually gone before claiming success — a
	// silent failed delete must not print the green check (mirrors the
	// re-baseline's read-back confirm). Confirm failure sets a non-zero exit code
	// rather than throwing: the write was attempted, so this is a "did not land"
	// diagnostic, not the pre-write refusal the precondition throw signals.
	const reread = await ref.get();
	const stillPresent = ORPHAN_KEY in (reread.data() ?? {});
	if (stillPresent) {
		process.exitCode = 1;
		console.error(
			`  ✗ \`${ORPHAN_KEY}\` is still present after the delete — re-run or investigate.`,
		);
		return;
	}
	console.log(
		`  ✓ deleted \`${ORPHAN_KEY}\` from usage/${ORPHAN_USER}/months/${ORPHAN_PERIOD}.`,
	);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const header = apply
		? "⚠️  CREDIT MIGRATION (writes to production)"
		: "CREDIT MIGRATION — dry run (writes nothing)";
	console.log(`${header}\n`);

	// At least one action is required. Running with no action flag is a usage
	// error (not a silent no-op) — the operator clearly meant to do something, so
	// surface the help on stderr and exit non-zero rather than appear to succeed.
	if (!doRebaseline && !doSeed && !doDeleteOrphan) {
		console.error(
			"Nothing to do. Pass --rebaseline-cost, --seed-credits, and/or --delete-orphan.\n",
		);
		program.help({ error: true }); // prints usage to stderr, exits 1
	}

	if (doRebaseline) await rebaselineCost();
	if (doSeed) {
		if (doRebaseline) console.log("");
		await seedCredits();
	}
	// Delete LAST so a combined `--rebaseline-cost --delete-orphan --apply` folds
	// April's true cost into cost_estimate before the precondition reads it — the
	// guard then sees the post-fold value and the combined path stays consistent.
	if (doDeleteOrphan) {
		if (doRebaseline || doSeed) console.log("");
		await deleteOrphan();
	}
}

runMain(main);
