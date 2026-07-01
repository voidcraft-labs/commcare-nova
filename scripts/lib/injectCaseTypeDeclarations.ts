/**
 * Pure transform behind the missing-case-declare event-log migration.
 *
 * P2 removed `ensureCatalogProperty`'s auto-mint: a field write to an
 * undeclared case type no longer creates the type — the `declareCaseType`
 * chokepoint owns that. Pre-P2 event logs recorded such a write with NO
 * `declareCaseType`, relying on the auto-mint side effect, so a from-events
 * replay (`resetBuilder` → `applyMany` per event) reconstructs a doc MISSING
 * the type, and its case list renders broken in the admin replay/inspect view.
 * Live apps are unaffected (they hydrate from the full snapshot).
 *
 * This walks one app's ordered event stream and injects a synthetic
 * `declareCaseType` immediately before the first field-write to a type nothing
 * earlier declared — faithfully recording a creation the run genuinely
 * performed. Deterministic + idempotent: a stream whose declares are already
 * present (post-migration, or a run that declared explicitly) injects nothing.
 *
 * The paired scripts drive it: `scan-missing-case-declares.ts` (read-only,
 * sizes the work) and `migrate-missing-case-declares.ts` (the writer). The
 * writer persists each synthetic declare as an APPEND-ONLY new event whose doc
 * id ties on `(ts, seq)` with its trigger and wins Firestore's implicit
 * `__name__` tiebreak — so it reads back immediately before the trigger with
 * ZERO edits to any existing event.
 */

import type { Mutation } from "@/lib/doc/types";
import { fieldCasePropertyOn } from "@/lib/domain";
import type { Event, MutationEvent } from "@/lib/log/types";

/** Case types a mutation makes exist in the catalog on replay — the sources
 *  that seed the running "declared" set. `addModule`'s own case type is
 *  included because a module type is always materialized separately (via
 *  `setCaseTypes`), so its field writes never relied on the auto-mint. */
function caseTypesDeclaredBy(mutation: Mutation): string[] {
	switch (mutation.kind) {
		case "declareCaseType":
			return [mutation.caseType];
		case "setCaseTypes":
			return (mutation.caseTypes ?? []).map((ct) => ct.name);
		case "addModule":
			return mutation.module.caseType ? [mutation.module.caseType] : [];
		default:
			return [];
	}
}

/** The case type a field-write mutation targets — the writes that pre-P2
 *  auto-minted the type (`ensureCatalogProperty` fired on both). `addField`
 *  is the dominant subcase / child-case path; `updateField` covers an edit
 *  that re-targets a field onto a brand-new type. */
function caseTypeWrittenBy(mutation: Mutation): string | undefined {
	if (mutation.kind === "addField") return fieldCasePropertyOn(mutation.field);
	if (mutation.kind === "updateField") {
		const value = (mutation.patch as { case_property_on?: unknown })
			.case_property_on;
		return typeof value === "string" && value.length > 0 ? value : undefined;
	}
	return undefined;
}

export interface CaseDeclareInjection {
	/** The case type the synthetic `declareCaseType` declares. */
	caseType: string;
	/** Index of the synthetic event in the RETURNED array (immediately before
	 *  its triggering field-write). */
	index: number;
	/** Which field-write kind triggered it — for the scan's report. */
	trigger: "addField" | "updateField";
}

export interface InjectResult {
	/** The event stream with synthetic declares spliced in. Original events are
	 *  the SAME references (identity-stable), so a caller can tell an injected
	 *  event from an original by reference. */
	events: Event[];
	injections: CaseDeclareInjection[];
}

/** The synthetic `declareCaseType` event — same envelope (runId / ts / seq /
 *  source / actor / stage) as its trigger, so it lands in the trigger's replay
 *  chapter. It shares the trigger's `(ts, seq)`; the writer's doc id wins the
 *  `__name__` tiebreak to sort it just BEFORE the trigger. */
function syntheticDeclare(
	trigger: MutationEvent,
	caseType: string,
): MutationEvent {
	return {
		runId: trigger.runId,
		ts: trigger.ts,
		seq: trigger.seq,
		source: trigger.source,
		kind: "mutation",
		actor: trigger.actor,
		...(trigger.stage !== undefined && { stage: trigger.stage }),
		mutation: { kind: "declareCaseType", caseType },
	};
}

/**
 * Splice a synthetic `declareCaseType` before the first field-write to each
 * case type nothing earlier in the stream declared.
 */
export function injectMissingCaseTypeDeclarations(
	events: readonly Event[],
): InjectResult {
	const declared = new Set<string>();
	const out: Event[] = [];
	const injections: CaseDeclareInjection[] = [];
	for (const event of events) {
		if (event.kind === "mutation") {
			const written = caseTypeWrittenBy(event.mutation);
			if (written !== undefined && !declared.has(written)) {
				out.push(syntheticDeclare(event, written));
				injections.push({
					caseType: written,
					index: out.length - 1,
					trigger: event.mutation.kind as "addField" | "updateField",
				});
				declared.add(written);
			}
			for (const ct of caseTypesDeclaredBy(event.mutation)) declared.add(ct);
		}
		out.push(event);
	}
	return { events: out, injections };
}
