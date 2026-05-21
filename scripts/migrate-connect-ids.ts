/**
 * ONE-TIME heal of connect ids on existing apps.
 *
 * The connect-id redesign forces NEW data correct at the source —
 * `deriveConnectId` autofills at creation, the UI/tool guards reject bad
 * explicit input, and `buildConnectSlugMap`'s `narrowId` throws at emit if a
 * block somehow reaches the wire id-less. But apps persisted BEFORE that
 * landed may carry connect ids that are missing, illegal as XML element
 * names, over Connect's 50-char slug column, or duplicated across blocks.
 * Such a doc would trip the emit invariant (compile/upload failure) or 500
 * at opportunity-init on the Connect side.
 *
 * This script heals existing apps once. After it runs, every persisted
 * doc's connect ids are present, valid, ≤50, and unique — so emission and
 * upload are safe. It is throwaway: there is NO permanent load-boundary
 * code, and the heal LOOP lives here (not in `lib/`); it only reuses the
 * permanent shared helpers (`deriveConnectId`, `connectIdError`) so the
 * heal can never drift from what the source layer considers valid.
 *
 * Heal rule, per connect block (learn_module / assessment / deliver_unit /
 * task), in document order (`moduleOrder` → `formOrder[mod]` → fixed kind
 * order learn_module → assessment → deliver_unit → task):
 *   - id missing/empty → autofill via `deriveConnectId(name, existingIds)`.
 *   - id present but invalid (`connectIdError(id) != null`) → re-derive
 *     (normalize). Safe: every upload creates a fresh HQ app, so there's no
 *     slug identity to preserve across re-sync.
 *   - id present, valid, but already taken by an earlier block → re-derive
 *     the later occurrence (first in document order wins).
 * The derive name mirrors `deriveConnectDefaults` exactly: learn_module /
 * deliver_unit from the module name, assessment / task from
 * `<module> <form>`.
 *
 * Two passes make it correct: pass 1 classifies each id as keep-verbatim
 * (valid + first occurrence) or needs-derive, building `existingIds` from
 * only the keep set; pass 2 derives the needs-derive blocks in document
 * order, accumulating each minted id so derived ids stay mutually unique.
 * An invalid id being replaced is NOT reserved in `existingIds` — reserving
 * the bad slot could let a derived id collide back into it, and the bad id
 * may itself be the cause of a downstream duplicate.
 *
 * Idempotent: after a heal every id is valid + unique, so a re-run
 * classifies all as keep-verbatim and changes nothing.
 *
 * Usage:
 *   npx tsx scripts/migrate-connect-ids.ts                 # dry-run (default): report only
 *   npx tsx scripts/migrate-connect-ids.ts --apply         # write healed blueprints
 *   npx tsx scripts/migrate-connect-ids.ts --app-id=abc123 # one app (dry-run)
 *   npx tsx scripts/migrate-connect-ids.ts --help
 *
 * Timing is NOT load-bearing: the source-enforcement keeps new data safe, so
 * this can run any time before the next compile/upload cycle for existing
 * apps. Dry-run prints what WOULD change; `--apply` writes + prints the same
 * report.
 */

import "dotenv/config";
import {
	CONNECT_SLUG_MAX_LENGTH,
	connectIdError,
	deriveConnectId,
} from "@/lib/commcare/connectSlugs";
import { getDb } from "@/lib/db/firestore";
import type { BlueprintDoc, ConnectConfig } from "@/lib/domain";
import { log } from "@/lib/logger";

// ── Heal transform (pure) ────────────────────────────────────────────

/** The four connect kinds, in the document order the heal walks them —
 *  matches `deriveConnectDefaults`'s within-form kind order so the heal's
 *  "first occurrence wins" tie-break is stable and identical. */
const CONNECT_KINDS = [
	"learn_module",
	"assessment",
	"deliver_unit",
	"task",
] as const;
type ConnectKind = (typeof CONNECT_KINDS)[number];

/** Why a single id was healed — surfaced in the per-app report. */
type HealReason = "missing" | "invalid-chars" | "too-long" | "duplicate";

/** One healed id, for reporting. */
export interface ConnectIdChange {
	formId: string;
	kind: ConnectKind;
	oldId: string | undefined;
	newId: string;
	reason: HealReason;
}

/** Result of healing one app's blueprint. `doc` is a fresh object graph
 *  when anything changed; the same reference (untouched) otherwise. */
export interface HealResult {
	doc: BlueprintDoc;
	changes: ConnectIdChange[];
}

/** The derive name for a kind, mirroring `deriveConnectDefaults`. */
function deriveName(
	kind: ConnectKind,
	moduleName: string,
	formName: string,
): string {
	switch (kind) {
		case "learn_module":
		case "deliver_unit":
			return moduleName;
		case "assessment":
		case "task":
			return `${moduleName} ${formName}`;
	}
}

/**
 * Classify why a present id needs re-derivation, or `null` to keep it
 * verbatim. `taken` is the set of ids already claimed by earlier (kept)
 * blocks in document order.
 *
 * `connectIdError` is the validity gate (it owns the format + length rule);
 * the `HealReason` is just a report label, so when an id is invalid we tag
 * it by length vs. character shape directly off the primitives — no parsing
 * of the error message. A duplicate is a valid id already taken.
 */
function reclassify(
	id: string | undefined,
	taken: ReadonlySet<string>,
): HealReason | null {
	if (!id) return "missing";
	if (connectIdError(id) !== null) {
		return id.length > CONNECT_SLUG_MAX_LENGTH ? "too-long" : "invalid-chars";
	}
	if (taken.has(id)) return "duplicate";
	return null;
}

/**
 * Heal every connect id in `doc`. Pure: returns a new doc + the list of
 * changes, never mutating the input. Non-Connect apps return unchanged with
 * no changes.
 */
export function healConnectIds(doc: BlueprintDoc): HealResult {
	if (!doc.connectType) return { doc, changes: [] };

	// Walk every (form, kind) with a present connect block, in document order.
	const blocks: Array<{
		formUuid: string;
		formId: string;
		kind: ConnectKind;
		id: string | undefined;
		name: string;
	}> = [];
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (!mod) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (!form?.connect) continue;
			for (const kind of CONNECT_KINDS) {
				const sub = form.connect[kind];
				if (!sub) continue;
				blocks.push({
					formUuid,
					formId: form.id,
					kind,
					id: sub.id,
					name: deriveName(kind, mod.name, form.name),
				});
			}
		}
	}

	// Pass 1: classify. `existingIds` collects only the ids that survive
	// verbatim (valid + first occurrence); a needs-derive id is NOT reserved.
	const existingIds = new Set<string>();
	const classified = blocks.map((b) => {
		const reason = reclassify(b.id, existingIds);
		if (reason === null && b.id) existingIds.add(b.id);
		return { ...b, reason };
	});

	// Pass 2: derive ids for the needs-derive blocks, in document order,
	// accumulating each minted id so derived ids stay mutually unique. Each
	// entry pairs the target block (form + kind) with its new id for the
	// apply step below.
	const changes: ConnectIdChange[] = [];
	const newIdByBlock = new Map<
		{ formUuid: string; kind: ConnectKind },
		string
	>();
	for (const b of classified) {
		if (b.reason === null) continue;
		const newId = deriveConnectId(b.name, existingIds);
		existingIds.add(newId);
		newIdByBlock.set({ formUuid: b.formUuid, kind: b.kind }, newId);
		changes.push({
			formId: b.formId,
			kind: b.kind,
			oldId: b.id,
			newId,
			reason: b.reason,
		});
	}

	if (changes.length === 0) return { doc, changes: [] };

	// Apply the derived ids onto a shallow-cloned doc (forms + the touched
	// connect sub-configs cloned; everything else shared by reference). The
	// per-kind switch keeps each discriminated arm precisely typed — no
	// dynamic-index write that would need a cast.
	const forms: BlueprintDoc["forms"] = { ...doc.forms };
	for (const [block, newId] of newIdByBlock) {
		const form = forms[block.formUuid];
		if (!form?.connect) continue;
		const connect: ConnectConfig = { ...form.connect };
		switch (block.kind) {
			case "learn_module":
				if (connect.learn_module)
					connect.learn_module = { ...connect.learn_module, id: newId };
				break;
			case "assessment":
				if (connect.assessment)
					connect.assessment = { ...connect.assessment, id: newId };
				break;
			case "deliver_unit":
				if (connect.deliver_unit)
					connect.deliver_unit = { ...connect.deliver_unit, id: newId };
				break;
			case "task":
				if (connect.task) connect.task = { ...connect.task, id: newId };
				break;
		}
		forms[block.formUuid] = { ...form, connect };
	}

	return { doc: { ...doc, forms }, changes };
}

// ── CLI surface ──────────────────────────────────────────────────────

interface MigrateOptions {
	/** Default true — writes happen only with `--apply`. */
	readonly dryRun: boolean;
	/** Narrow to one app id; otherwise bulk-scan complete apps. */
	readonly appId: string | undefined;
	readonly help: boolean;
}

const HELP_TEXT = [
	"migrate-connect-ids — ONE-TIME heal of connect ids on existing apps.",
	"",
	"Heals every app's per-form connect ids so they are present, a legal XML",
	"element name, <=50 chars, and unique across the app. Reuses the same",
	"validity helpers the source layer uses. Idempotent.",
	"",
	"Dry-run by default; pass --apply to write healed blueprints to Firestore.",
	"",
	"Flags:",
	"  --apply            Write healed blueprints. Without it, report only.",
	"  --app-id=<id>      Heal one app by id (still dry-run unless --apply).",
	"  --help             Show this help.",
	"",
	"Examples:",
	"  npx tsx scripts/migrate-connect-ids.ts",
	"  npx tsx scripts/migrate-connect-ids.ts --apply",
	"  npx tsx scripts/migrate-connect-ids.ts --app-id=abc123 --apply",
].join("\n");

/** Parse argv into options. Dry-run is the default; `--apply` opts into
 *  writes. `--app-id=` requires a non-empty value. */
export function parseArgs(argv: readonly string[]): MigrateOptions {
	let dryRun = true;
	let appId: string | undefined;
	let help = false;

	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--apply") {
			dryRun = false;
		} else if (arg.startsWith("--app-id=")) {
			const value = arg.slice("--app-id=".length).trim();
			if (!value) {
				throw new Error("--app-id= requires a non-empty app id");
			}
			appId = value;
		}
	}

	return { dryRun, appId, help };
}

/** Render one app's changes as report lines. */
function reportApp(appId: string, changes: ConnectIdChange[]): string {
	const lines = changes.map(
		(c) =>
			`    ${c.formId} ${c.kind}: ${c.oldId === undefined ? "(unset)" : `"${c.oldId}"`} → "${c.newId}" [${c.reason}]`,
	);
	return `  app ${appId} — ${changes.length} id(s) healed:\n${lines.join("\n")}`;
}

/** App doc shape this script reads — only `blueprint` matters. */
interface AppDocSnapshot {
	id: string;
	data(): { blueprint?: unknown } | undefined;
	ref: { update(patch: { blueprint: unknown }): Promise<unknown> };
	exists?: boolean;
}

/** Heal one app doc; write back only when changed AND not dry-run. */
async function processApp(
	app: AppDocSnapshot,
	dryRun: boolean,
): Promise<ConnectIdChange[]> {
	const data = app.data();
	const blueprint = data?.blueprint;
	if (!blueprint || typeof blueprint !== "object") return [];

	const { doc, changes } = healConnectIds(blueprint as BlueprintDoc);
	if (changes.length === 0) return [];

	console.log(reportApp(app.id, changes));
	if (!dryRun) await app.ref.update({ blueprint: doc });
	return changes;
}

export async function run(options: MigrateOptions): Promise<void> {
	const { dryRun, appId } = options;
	const db = getDb() as unknown as {
		collection(name: string): {
			where(
				field: string,
				op: string,
				value: unknown,
			): {
				where(
					field: string,
					op: string,
					value: unknown,
				): { get(): Promise<{ docs: AppDocSnapshot[] }> };
			};
			doc(id: string): { get(): Promise<AppDocSnapshot> };
		};
	};

	const docs: AppDocSnapshot[] = [];
	if (appId !== undefined) {
		// Surgical path — read one app by id even if status/soft-delete would
		// exclude it from the bulk scan.
		const snap = await db.collection("apps").doc(appId).get();
		if (snap.exists) docs.push(snap);
	} else {
		// Bulk path — same server-side filter the other migrations use:
		// skip soft-deletes; only complete apps have a settled blueprint.
		const result = await db
			.collection("apps")
			.where("deleted_at", "==", null)
			.where("status", "==", "complete")
			.get();
		for (const snap of result.docs) docs.push(snap);
	}

	let scanned = 0;
	let appsChanged = 0;
	let idsHealed = 0;
	const byReason: Record<HealReason, number> = {
		missing: 0,
		"invalid-chars": 0,
		"too-long": 0,
		duplicate: 0,
	};

	for (const app of docs) {
		scanned += 1;
		const changes = await processApp(app, dryRun);
		if (changes.length > 0) {
			appsChanged += 1;
			idsHealed += changes.length;
			for (const c of changes) byReason[c.reason] += 1;
		}
	}

	log.info(
		`[migrate-connect-ids] apps_scanned=${scanned} apps_changed=${appsChanged} ids_healed=${idsHealed} ` +
			`missing=${byReason.missing} invalid_chars=${byReason["invalid-chars"]} too_long=${byReason["too-long"]} duplicate=${byReason.duplicate} ` +
			`dryRun=${dryRun}`,
	);
	if (dryRun && appsChanged > 0) {
		console.log(
			"\n  (dry-run — nothing written. Re-run with --apply to write.)",
		);
	}
}

// ── Entrypoint ───────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	let opts: MigrateOptions;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	if (opts.help) {
		console.log(HELP_TEXT);
		process.exit(0);
	}
	run(opts).catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
