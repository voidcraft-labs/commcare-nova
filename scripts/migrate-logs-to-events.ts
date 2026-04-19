#!/usr/bin/env tsx
/**
 * One-time migration: apps/{appId}/logs (pre-Phase-4 StoredEvent) →
 *                     apps/{appId}/events (Event) + apps/{appId}/runs (RunSummaryDoc).
 *
 * Background. Before Phase 4 unified the event log, agent runs wrote a
 * heterogeneous `StoredEvent[]` stream to `apps/{appId}/logs/` — one doc
 * per step/emission/message/error/config, with per-event shape varying by
 * discriminator. Phase 4 replaced that with a single `Event[]` stream
 * (mutation + conversation) at `apps/{appId}/events/` plus a per-run
 * summary doc at `apps/{appId}/runs/{runId}`. This script translates
 * historical logs in-place so admin replay + inspect scripts work on every
 * app, including ones generated before the cutover.
 *
 * Idempotency. Destination doc IDs are deterministic (`{runId}_{seqPad}`
 * via `eventDocId`), so re-running overwrites identical content. Apps that
 * already have events are skipped by default — pass `--force` to
 * re-translate them (useful when the translator itself changes).
 *
 * `--dry-run` prints the translation plan without writing. Safe to run
 * against prod credentials.
 *
 * Production usage. Always take a Firestore export to GCS before running
 * against prod. Run against staging first and verify replay in the builder
 * UI before touching prod. The old `apps/{appId}/logs/` collection is NOT
 * deleted by this script — deletion is a separate decision once the new
 * collection is known-good across the historical dataset.
 *
 *   npx tsx scripts/migrate-logs-to-events.ts                   # every app
 *   npx tsx scripts/migrate-logs-to-events.ts --app=<id>        # one app
 *   npx tsx scripts/migrate-logs-to-events.ts --dry-run         # plan only
 *   npx tsx scripts/migrate-logs-to-events.ts --force           # re-migrate
 *   npx tsx scripts/migrate-logs-to-events.ts --verbose         # detail
 */

import "dotenv/config";
import { produce } from "immer";
import { collections, getDb } from "@/lib/db/firestore";
import { writeRunSummary } from "@/lib/db/runSummary";
import type { RunSummaryDoc } from "@/lib/db/types";
import { estimateCost } from "@/lib/db/usage";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { ConversationEvent, Event, MutationEvent } from "@/lib/log/types";
import { eventDocId } from "@/lib/log/types";
import { toDocMutations } from "./migrate/legacy-event-translator";

// ── CLI parsing ─────────────────────────────────────────────────────

/** Parsed CLI flags. Mutually combinable — no flag invalidates another. */
interface Flags {
	/** Restrict migration to a single app id. */
	app?: string;
	/** Print the translation plan without writing anything. */
	dryRun: boolean;
	/** Re-migrate apps that already have events (default: skip them). */
	force: boolean;
	/** Log per-app progress for apps that have no work to do. */
	verbose: boolean;
}

function parseFlags(): Flags {
	const args = process.argv.slice(2);
	return {
		app: args.find((a) => a.startsWith("--app="))?.split("=")[1],
		dryRun: args.includes("--dry-run"),
		force: args.includes("--force"),
		verbose: args.includes("--verbose"),
	};
}

// ── Legacy StoredEvent shape ────────────────────────────────────────

/**
 * Minimal subset of the pre-Phase-4 `StoredEvent` shape. The live Zod
 * schema for these docs was deleted when the legacy `lib/services/eventLogger`
 * was removed (Task 3 / Task 10), so we redeclare here only the fields the
 * translator actually reads. Reads from Firestore are intentionally untyped
 * at the SDK boundary (plain JS objects) and narrowed by the discriminant
 * switch inside `translateRun`.
 *
 * Kept local to this file — nothing else should depend on this shape, and
 * exporting it would invite resurrection of the legacy writer.
 */
interface LegacyStoredEvent {
	run_id: string;
	sequence: number;
	request: number;
	timestamp: string;
	event:
		| { type: "message"; id: string; text: string }
		| {
				type: "step";
				step_index: number;
				text: string;
				reasoning: string;
				tool_calls: Array<{
					name: string;
					args: unknown;
					output: unknown;
					generation: {
						model: string;
						input_tokens: number;
						output_tokens: number;
						cache_read_tokens: number;
						cache_write_tokens: number;
						cost: number;
					} | null;
					reasoning: string;
				}>;
				usage: {
					model: string;
					input_tokens: number;
					output_tokens: number;
					cache_read_tokens: number;
					cache_write_tokens: number;
					cost: number;
				};
		  }
		| {
				type: "emission";
				step_index: number;
				emission_type: string;
				emission_data: unknown;
		  }
		| {
				type: "config";
				prompt_mode: "build" | "edit";
				fresh_edit: boolean;
				app_ready: boolean;
				cache_expired: boolean;
				module_count: number;
		  }
		| {
				type: "error";
				error_type: string;
				error_message: string;
				error_raw: string;
				error_fatal: boolean;
				error_context: string;
		  };
}

// ── Skip / translate classifiers ────────────────────────────────────

/**
 * Emissions whose sole purpose was to drive transient UI (progress phases,
 * fix-attempt markers, the run-id handshake). They carry no persisted
 * state under the Phase 4 model and are dropped silently.
 *
 * `data-error` is separately skipped here because the ErrorEvent branch of
 * `StoredEvent` is the authoritative source — the legacy code occasionally
 * doubled errors onto the emission stream, and we only want one.
 *
 * `data-blueprint-updated` is skipped in the main stream (see
 * `translateRun` for the per-run counter that reports it) — edit-mode
 * full-doc replacements cannot be losslessly decomposed into `Mutation[]`
 * without a diff vs the prior doc.
 */
const EPHEMERAL_EMISSION_TYPES = new Set([
	"data-done",
	"data-phase",
	"data-start-build",
	"data-fix-attempt",
	"data-partial-scaffold",
	"data-app-saved",
	"data-run-id",
	"data-error",
	"data-blueprint-updated",
]);

/**
 * Emissions that carry doc-affecting payloads in the legacy wire format.
 * Each translates to zero-or-more domain mutations via `toDocMutations`
 * against a running `BlueprintDoc` snapshot so the translator's index-based
 * lookups (moduleIndex, formIndex) resolve to the UUIDs the live SA would
 * have seen at that moment in the run.
 */
const LEGACY_WIRE_EMISSION_TYPES = new Set([
	"data-schema",
	"data-scaffold",
	"data-module-done",
	"data-form-done",
	"data-form-fixed",
	"data-form-updated",
]);

// ── Running doc seed ────────────────────────────────────────────────

/**
 * Matches the chat route's initial `sessionDoc` shape. Index lookups in
 * `toDocMutations` start from this empty doc and advance as we apply each
 * legacy wire emission's translated mutations, so the second module's
 * `data-module-done` correctly resolves `moduleIndex=1` to the UUID
 * `data-scaffold` just minted for it.
 */
function emptyDoc(appId: string): BlueprintDoc {
	return {
		appId,
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

// ── Per-run translation ─────────────────────────────────────────────

/** Result of translating one run's `StoredEvent[]` stream. */
interface TranslatedRun {
	/** Destination events in chronological order (seq assigned here). */
	events: Event[];
	/** The summary doc derived from aggregated step usage + config seed. */
	summary: RunSummaryDoc;
	/** Count of edit-mode full-doc replacements we had to drop. */
	skippedBlueprintUpdated: number;
}

/**
 * Walk one run's StoredEvent stream in sequence order and emit the new
 * `Event[]` + `RunSummaryDoc` pair. Pure function — reads only from
 * `stored`, writes nothing. All side effects live in `writeRun` below.
 *
 * Ordering invariants:
 *   - The per-run `seq` counter is assigned here, not copied from legacy
 *     `sequence` — legacy sequence ordered across mixed event kinds; the
 *     new model assigns one seq per emitted `Event`, and one StepEvent
 *     expands into multiple events (reasoning + text + call + result × N).
 *   - `ts` copies from the legacy `timestamp` (ISO string → ms via
 *     `Date.parse`) so chronological order matches the original run.
 */
function translateRun(
	appId: string,
	runId: string,
	stored: LegacyStoredEvent[],
): TranslatedRun {
	const events: Event[] = [];
	let seq = 0;
	let doc = emptyDoc(appId);

	/* Per-run accumulators for the summary doc. Populated in-line as we
	 * walk the stream so the summary is a by-product of translation, not
	 * a second pass. */
	let cfg: Extract<LegacyStoredEvent["event"], { type: "config" }> | null =
		null;
	let stepCount = 0;
	let toolCallCount = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let lastModel = "unknown";
	let skippedBlueprintUpdated = 0;

	/* Summary timestamps — ISO strings, matching the RunSummaryDoc schema.
	 * Fall back to "now" for empty runs, which would otherwise leave these
	 * undefined and fail the schema's required-field validation on write. */
	const startedAt = stored[0]?.timestamp ?? new Date().toISOString();
	const finishedAt =
		stored[stored.length - 1]?.timestamp ?? new Date().toISOString();

	for (const s of stored) {
		const ts = Date.parse(s.timestamp);

		// ── message → user-message conversation event ────────────
		if (s.event.type === "message") {
			const ev: ConversationEvent = {
				kind: "conversation",
				runId,
				ts,
				seq: seq++,
				payload: { type: "user-message", text: s.event.text },
			};
			events.push(ev);
			continue;
		}

		// ── config → seed the run summary; no stream event ───────
		if (s.event.type === "config") {
			cfg = s.event;
			continue;
		}

		// ── error → error conversation event ─────────────────────
		if (s.event.type === "error") {
			events.push({
				kind: "conversation",
				runId,
				ts,
				seq: seq++,
				payload: {
					type: "error",
					error: {
						type: s.event.error_type,
						message: s.event.error_message,
						fatal: s.event.error_fatal,
					},
				},
			});
			continue;
		}

		// ── step → reasoning + text + tool-call + tool-result ────
		if (s.event.type === "step") {
			stepCount++;
			lastModel = s.event.usage.model;
			inputTokens += s.event.usage.input_tokens;
			outputTokens += s.event.usage.output_tokens;
			cacheReadTokens += s.event.usage.cache_read_tokens;
			cacheWriteTokens += s.event.usage.cache_write_tokens;

			if (s.event.reasoning) {
				events.push({
					kind: "conversation",
					runId,
					ts,
					seq: seq++,
					payload: { type: "assistant-reasoning", text: s.event.reasoning },
				});
			}
			if (s.event.text) {
				events.push({
					kind: "conversation",
					runId,
					ts,
					seq: seq++,
					payload: { type: "assistant-text", text: s.event.text },
				});
			}
			const stepIndex = s.event.step_index;
			s.event.tool_calls.forEach((tc, tIdx) => {
				toolCallCount++;
				/* Fold sub-generation cost into the run totals — this is where
				 * the old EventLogger's `pendingSubResults` / sub-result
				 * accumulator landed its per-tool usage. */
				if (tc.generation) {
					inputTokens += tc.generation.input_tokens;
					outputTokens += tc.generation.output_tokens;
					cacheReadTokens += tc.generation.cache_read_tokens;
					cacheWriteTokens += tc.generation.cache_write_tokens;
				}
				/* Synthesize a tool call id. Legacy logs didn't persist SDK
				 * ids, so any value will do as long as it pairs the result
				 * back to its call within the run — which the deterministic
				 * `${runId}-${stepIdx}-${toolIdx}` shape guarantees. */
				const toolCallId = `${runId}-${stepIndex}-${tIdx}`;
				events.push({
					kind: "conversation",
					runId,
					ts,
					seq: seq++,
					payload: {
						type: "tool-call",
						toolCallId,
						toolName: tc.name,
						input: tc.args,
					},
				});
				if (tc.output !== null && tc.output !== undefined) {
					events.push({
						kind: "conversation",
						runId,
						ts,
						seq: seq++,
						payload: {
							type: "tool-result",
							toolCallId,
							toolName: tc.name,
							output: tc.output,
						},
					});
				}
			});
			continue;
		}

		// ── emission → mutation event(s) OR skip ─────────────────
		if (s.event.type === "emission") {
			const type = s.event.emission_type;

			if (type === "data-blueprint-updated") {
				/* Full-doc replacement from edit mode. Dropping loses edit-run
				 * mutation fidelity in replay but preserves conversation events.
				 * Counted + reported so the operator can spot-check affected
				 * apps manually. */
				skippedBlueprintUpdated++;
				continue;
			}
			if (EPHEMERAL_EMISSION_TYPES.has(type)) continue;

			if (type === "data-mutations") {
				const data = s.event.emission_data as {
					mutations?: Mutation[];
					stage?: string;
				};
				const stage = data.stage;
				for (const m of data.mutations ?? []) {
					const ev: MutationEvent = {
						kind: "mutation",
						runId,
						ts,
						seq: seq++,
						actor: "agent",
						/* `stage` is an optional field on MutationEvent — only
						 * spread it when present so Firestore doesn't persist
						 * a literal `undefined` that then fails schema parse
						 * on read. */
						...(stage && { stage }),
						mutation: m,
					};
					events.push(ev);
					/* Advance the running doc so subsequent legacy emissions
					 * (which resolve indexes into `moduleOrder` / `formOrder`)
					 * see the same state the live SA would have seen. */
					doc = produce(doc, (draft) => {
						applyMutations(draft, [m]);
					});
				}
				continue;
			}

			if (LEGACY_WIRE_EMISSION_TYPES.has(type)) {
				const stage = deriveLegacyStage(
					type,
					s.event.emission_data as Record<string, unknown>,
				);
				const mutations = toDocMutations(
					type,
					s.event.emission_data as Record<string, unknown>,
					doc,
				);
				for (const m of mutations) {
					events.push({
						kind: "mutation",
						runId,
						ts,
						seq: seq++,
						actor: "agent",
						...(stage && { stage }),
						mutation: m,
					});
				}
				/* Apply the whole batch atomically so the next legacy emission's
				 * index lookup sees final post-batch state, matching what the
				 * live SA's dispatcher would have committed after the stream
				 * event was handled. */
				doc = produce(doc, (draft) => {
					applyMutations(draft, mutations);
				});
				continue;
			}

			/* Unknown emission type. Warn, don't fail — forward-compat lets
			 * this script survive a future log where someone added a new
			 * emission kind without updating this script. */
			console.warn(
				`[migrate] app ${appId} run ${runId}: unknown emission type ${type}, skipping`,
			);
		}
	}

	/* Build the run summary. `costEstimate` uses the same `estimateCost`
	 * helper the live accumulator runs, so migrated runs show identical
	 * numbers to what the new pipeline would compute for a fresh run. */
	const summary: RunSummaryDoc = {
		runId,
		startedAt,
		finishedAt,
		promptMode: cfg?.prompt_mode ?? "build",
		freshEdit: cfg?.fresh_edit ?? false,
		appReady: cfg?.app_ready ?? false,
		cacheExpired: cfg?.cache_expired ?? false,
		moduleCount: cfg?.module_count ?? 0,
		stepCount,
		model: lastModel,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		costEstimate: estimateCost(
			lastModel,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
		),
		toolCallCount,
	};

	return { events, summary, skippedBlueprintUpdated };
}

/**
 * Derive a semantic stage tag from a legacy wire-event type + payload.
 *
 * Stage tags are supplemental metadata on MutationEvents — the replay UI
 * groups mutations into chapters ("Scaffold", "Module 0", "Form 0-1") by
 * matching on this string. Matching the live SA's stage format keeps
 * migrated runs visually indistinguishable from fresh ones in the admin
 * replay view.
 */
function deriveLegacyStage(
	type: string,
	data: Record<string, unknown>,
): string | undefined {
	if (type === "data-schema") return "schema";
	if (type === "data-scaffold") return "scaffold";
	if (type === "data-module-done") {
		const i = data.moduleIndex as number | undefined;
		return typeof i === "number" ? `module:${i}` : "module";
	}
	if (type.startsWith("data-form-")) {
		const m = data.moduleIndex as number | undefined;
		const f = data.formIndex as number | undefined;
		return typeof m === "number" && typeof f === "number"
			? `form:${m}-${f}`
			: "form";
	}
	return undefined;
}

// ── Firestore sink ──────────────────────────────────────────────────

/**
 * Commit a run's translated events + summary to Firestore.
 *
 * Events go in 450-op chunks — the Firestore `WriteBatch` hard limit is
 * 500, and running below that leaves headroom in case we ever need to
 * slip a companion write in (e.g. a progress marker doc) without
 * re-chunking. Chunks are committed sequentially: migrations are offline,
 * so parallelism would only risk rate-limiting the same project from
 * itself for no throughput gain on a one-shot run.
 *
 * The run summary writes outside the event loop via `writeRunSummary`,
 * which is fire-and-forget. Intentional — if the events landed but the
 * summary write fails, re-running the script regenerates the summary
 * deterministically from the same input.
 */
async function writeRun(
	appId: string,
	runId: string,
	translated: TranslatedRun,
	dryRun: boolean,
): Promise<void> {
	if (dryRun) {
		console.log(
			`[dry-run] ${appId}/${runId}: ${translated.events.length} events + summary (cost $${translated.summary.costEstimate.toFixed(4)}, ${translated.summary.stepCount} steps)` +
				(translated.skippedBlueprintUpdated > 0
					? ` — skipped ${translated.skippedBlueprintUpdated} blueprint-updated emissions`
					: ""),
		);
		return;
	}

	const db = getDb();
	const eventsCol = collections.events(appId);
	const CHUNK = 450;
	for (let i = 0; i < translated.events.length; i += CHUNK) {
		const slice = translated.events.slice(i, i + CHUNK);
		const batch = db.batch();
		for (const ev of slice) {
			batch.set(eventsCol.doc(eventDocId(ev)), ev);
		}
		await batch.commit();
	}

	/* Summary is a single set() outside the batch loop. Fire-and-forget
	 * inside the helper — its errors log via `log.error` and don't throw. */
	writeRunSummary(appId, runId, translated.summary);
}

// ── Per-app driver ──────────────────────────────────────────────────

/**
 * Per-app migration outcome. The main loop aggregates these into a
 * summary line so the operator can sanity-check the overall run at a
 * glance without grepping through per-app output.
 */
interface AppResult {
	runsMigrated: number;
	eventsWritten: number;
	blueprintUpdatedSkipped: number;
}

/**
 * Read every log doc under `apps/{appId}/logs/`, group by `run_id`, sort
 * each group by legacy `sequence`, translate, and write.
 *
 * Idempotency guard: unless `--force` is passed, we skip apps that
 * already have at least one doc in `apps/{appId}/events/` — a signal
 * that either the live writer or a previous migration run already
 * populated them. A single-doc probe (`limit(1)`) keeps the guard
 * cheap on apps with large event collections.
 */
async function migrateApp(appId: string, flags: Flags): Promise<AppResult> {
	const db = getDb();
	const logsSnap = await db
		.collection("apps")
		.doc(appId)
		.collection("logs")
		.get();
	if (logsSnap.empty) {
		if (flags.verbose) {
			console.log(`[migrate] ${appId}: no legacy logs — skipping`);
		}
		return { runsMigrated: 0, eventsWritten: 0, blueprintUpdatedSkipped: 0 };
	}

	if (!flags.force) {
		const existing = await collections.events(appId).limit(1).get();
		if (!existing.empty) {
			console.log(
				`[migrate] ${appId}: already has events — use --force to re-migrate. Skipping.`,
			);
			return { runsMigrated: 0, eventsWritten: 0, blueprintUpdatedSkipped: 0 };
		}
	}

	/* Firestore SDK returns plain `DocumentData` here — no converter is
	 * registered on the legacy `logs` path, and the Zod schema was deleted
	 * with the EventLogger. The translator's discriminant switch is the
	 * validation layer. */
	const allStored = logsSnap.docs.map((d) => d.data() as LegacyStoredEvent);

	/* Group by run_id, then sort each group by legacy `sequence` so the
	 * translator walks events in their original emission order. */
	const byRun = new Map<string, LegacyStoredEvent[]>();
	for (const s of allStored) {
		const bucket = byRun.get(s.run_id);
		if (bucket) {
			bucket.push(s);
		} else {
			byRun.set(s.run_id, [s]);
		}
	}
	for (const arr of byRun.values()) {
		arr.sort((a, b) => a.sequence - b.sequence);
	}

	console.log(
		`[migrate] app ${appId} — found ${allStored.length} logs across ${byRun.size} runs`,
	);

	let runsMigrated = 0;
	let eventsWritten = 0;
	let blueprintUpdatedSkipped = 0;
	for (const [runId, stored] of byRun) {
		const translated = translateRun(appId, runId, stored);
		await writeRun(appId, runId, translated, flags.dryRun);
		runsMigrated++;
		eventsWritten += translated.events.length;
		blueprintUpdatedSkipped += translated.skippedBlueprintUpdated;
		console.log(
			`[migrate]   run ${runId} (${stored.length} logs) → ${translated.events.length} events + summary (cost $${translated.summary.costEstimate.toFixed(4)}, ${translated.summary.stepCount} steps)`,
		);
	}
	if (blueprintUpdatedSkipped > 0) {
		console.log(
			`[migrate]   legacy blueprint-updated events skipped: ${blueprintUpdatedSkipped}`,
		);
	}
	return { runsMigrated, eventsWritten, blueprintUpdatedSkipped };
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const flags = parseFlags();
	const db = getDb();

	/* App discovery: one app (explicit) or every app in the project. The
	 * root `apps/` collection listing is a single query — scales fine for
	 * any realistic commcare-nova dataset (tens of thousands at most). */
	const appIds = flags.app
		? [flags.app]
		: (await db.collection("apps").get()).docs.map((d) => d.id);

	let appsMigrated = 0;
	let totalRuns = 0;
	let totalEvents = 0;
	let totalSkipped = 0;
	for (const appId of appIds) {
		try {
			const r = await migrateApp(appId, flags);
			if (r.runsMigrated > 0) appsMigrated++;
			totalRuns += r.runsMigrated;
			totalEvents += r.eventsWritten;
			totalSkipped += r.blueprintUpdatedSkipped;
		} catch (err) {
			/* Per-app failure shouldn't halt the whole migration. The error is
			 * logged with the app id so the operator can re-run with
			 * `--app=<id>` once the root cause is addressed. */
			console.error(`[migrate] ${appId}: FAILED`, err);
		}
	}

	console.log(
		`[migrate] done. Apps migrated: ${appsMigrated}, runs migrated: ${totalRuns}, events written: ${totalEvents}` +
			(totalSkipped > 0 ? `, blueprint-updated skipped: ${totalSkipped}` : ""),
	);
}

main().catch((err) => {
	console.error("[migrate] fatal", err);
	process.exit(1);
});
