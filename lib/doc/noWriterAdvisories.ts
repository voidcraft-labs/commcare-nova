/**
 * No-writer advisories — the workflow-dead-end detector (#243).
 *
 * "Valid by construction" proves every entity sound, but a WORKFLOW can
 * still dead-end: a case property that GATES behavior (a field's
 * visibility or validation, a form link's condition, a module's
 * case-list filter or search-button condition) while no form in the app
 * writes it means records can never reach the gated state from within
 * the app. Every individual piece is valid; the loop never closes.
 *
 * This is deliberately an ADVISORY, never a commit-gate rule: a
 * no-writer gate is legitimate whenever something OUTSIDE the app
 * writes the property — another app on the same case type, HQ, an
 * integration. That is exactly what the catalog's `external` marking
 * (`casePropertySchema.external`) records, and the derivation excludes
 * marked properties — so one declaration silences the finding on every
 * surface at once (builder chips, SA tool-result notes, blueprint
 * summaries), because all of them derive from this one function.
 *
 * ## The rule
 *
 * For each DECLARED catalog property: it draws an advisory iff
 *
 *   1. some carrier reads it from a GATE slot (`GATE_SLOTS` below —
 *      behavior-gating reads only; display columns, calculates, and
 *      prose mentions never fire it),
 *   2. no field writes it (`declarersOf` — the same
 *      `(case_property_on, id)` derivation `effectiveCaseTypes` types
 *      properties from),
 *   3. it is not a CommCare standard property (`case_name`,
 *      `date_opened`, … — the runtime writes those) or `case_id`, and
 *   4. it is not declared `external`.
 *
 * Iterating declared entries is complete in a valid doc: the
 * validator's admission set only accepts references to properties the
 * effective view carries, and an effective-view property that is NOT
 * declared is writer-derived — i.e. it has a writer and can't fire.
 * (A degenerate legacy doc could hold a gate-read of a property that is
 * neither — that read simply doesn't flag, which is the right failure
 * direction for an advisory.)
 *
 * v1 checks writer EXISTENCE only. A writer that can only ever set
 * `'ordered'` still dead-ends a `= 'delivered'` gate — value-level
 * reachability is a future refinement, and the copy here stays honest
 * about what is checked ("no form writes it", never "the value is
 * unreachable" when a writer exists).
 *
 * Derived and memoized per doc reference like `effectiveCaseTypes` —
 * the store replaces the doc reference on every mutation, so staleness
 * is unreachable and consumers get one stable array per doc state.
 */

import type {
	BlueprintDoc,
	FieldSlotId,
	FormSlotId,
	ModuleSlotId,
	Uuid,
} from "@/lib/domain";
import {
	casePropertyTargetKey,
	isStandardCaseListProperty,
} from "@/lib/domain";
import { findContainingForm } from "./mutations/helpers";
import { declarersOf, referencingSlotsOf } from "./referenceIndex";

/**
 * The behavior-gating slots — a reference from one of these makes the
 * property load-bearing for whether something happens/appears. The
 * `satisfies` pins each id to the reference-slot registry
 * (`lib/domain/referenceSlots.ts`), so a slot rename breaks this build
 * instead of silently un-gating the advisory.
 *
 * Deliberately NOT here: `calculate` / `default_value` /
 * `case_list_column_field` / search-input slots / prose — data flow
 * and display, not gates. An always-empty column is a lesser smell,
 * and search inputs routinely target externally-owned data; including
 * them would flood the signal the gate set exists to keep high.
 * `required` is also out: a required-condition reading a never-written
 * property just means the field is never required — benign, not a
 * dead end.
 */
const GATE_SLOTS: ReadonlySet<string> = new Set([
	"relevant",
	"validate",
	"form_link_condition",
	"case_list_filter",
	"search_button_display_condition",
] satisfies readonly (FieldSlotId | FormSlotId | ModuleSlotId)[]);

/** Which entity record holds the gate-reading carrier. */
export type AdvisoryReadEntity = "field" | "form" | "module";

/** One gate-slot read of the advisory's property. */
export interface AdvisoryGateRead {
	readonly carrier: Uuid;
	readonly entity: AdvisoryReadEntity;
	readonly slot: string;
}

/** One no-writer finding: a `(caseType, property)` pair that gates
 *  behavior with no in-app writer and no external declaration. */
export interface NoWriterAdvisory {
	readonly caseType: string;
	readonly property: string;
	readonly reads: readonly AdvisoryGateRead[];
}

const ADVISORIES_CACHE = new WeakMap<object, readonly NoWriterAdvisory[]>();

const ENTITY_RANK: Record<AdvisoryReadEntity, number> = {
	field: 0,
	form: 1,
	module: 2,
};

/**
 * Every no-writer advisory the doc currently carries, in catalog order
 * (types, then properties, as declared) with reads deterministically
 * sorted — same doc, same output, on every surface.
 */
export function noWriterAdvisories(
	doc: BlueprintDoc,
): readonly NoWriterAdvisory[] {
	const cached = ADVISORIES_CACHE.get(doc);
	if (cached !== undefined) return cached;
	const built = buildAdvisories(doc);
	ADVISORIES_CACHE.set(doc, built);
	return built;
}

function buildAdvisories(doc: BlueprintDoc): readonly NoWriterAdvisory[] {
	const advisories: NoWriterAdvisory[] = [];
	for (const ct of doc.caseTypes ?? []) {
		const seen = new Set<string>();
		for (const prop of ct.properties) {
			if (seen.has(prop.name)) continue;
			seen.add(prop.name);
			if (prop.external !== undefined) continue;
			// The runtime writes the standard properties (and allocates
			// `case_id`) on every case — a "no in-app writer" read of one
			// is the normal state, not a dead end.
			if (isStandardCaseListProperty(prop.name) || prop.name === "case_id") {
				continue;
			}
			const reads = gateReads(doc, ct.name, prop.name);
			if (reads.length === 0) continue;
			if (declarersOf(doc, ct.name, prop.name).length > 0) continue;
			advisories.push({ caseType: ct.name, property: prop.name, reads });
		}
	}
	return advisories;
}

function gateReads(
	doc: BlueprintDoc,
	caseType: string,
	property: string,
): AdvisoryGateRead[] {
	const bySlot = referencingSlotsOf(
		doc,
		casePropertyTargetKey(caseType, property),
	);
	const reads: AdvisoryGateRead[] = [];
	for (const [carrier, slots] of bySlot) {
		const entity: AdvisoryReadEntity | undefined = doc.fields[carrier]
			? "field"
			: doc.forms[carrier]
				? "form"
				: doc.modules[carrier]
					? "module"
					: undefined;
		if (entity === undefined) continue;
		for (const slot of slots) {
			if (!GATE_SLOTS.has(slot)) continue;
			reads.push({ carrier: carrier as Uuid, entity, slot });
		}
	}
	reads.sort(
		(a, b) =>
			ENTITY_RANK[a.entity] - ENTITY_RANK[b.entity] ||
			a.carrier.localeCompare(b.carrier) ||
			a.slot.localeCompare(b.slot),
	);
	return reads;
}

const BY_CARRIER_CACHE = new WeakMap<
	object,
	ReadonlyMap<string, readonly NoWriterAdvisory[]>
>();

/**
 * The advisories grouped by gate-reading carrier — the builder's
 * per-row lookup (which advisories does THIS field's chip announce?).
 * Same memoization convention as the flat list.
 */
export function noWriterAdvisoriesByCarrier(
	doc: BlueprintDoc,
): ReadonlyMap<string, readonly NoWriterAdvisory[]> {
	const cached = BY_CARRIER_CACHE.get(doc);
	if (cached !== undefined) return cached;
	const map = new Map<string, NoWriterAdvisory[]>();
	for (const advisory of noWriterAdvisories(doc)) {
		for (const read of advisory.reads) {
			const list = map.get(read.carrier);
			if (list === undefined) map.set(read.carrier, [advisory]);
			else if (!list.includes(advisory)) list.push(advisory);
		}
	}
	BY_CARRIER_CACHE.set(doc, map);
	return map;
}

// ── Person-readable rendering ───────────────────────────────────────

/** One gate read as a human surface ("visibility of \"dose\" in form
 *  \"Administer Medication\""). `undefined` when the carrier vanished
 *  from the doc between derivation and rendering (unreachable on the
 *  memoized same-doc path; total anyway). */
function readSurface(
	doc: BlueprintDoc,
	read: AdvisoryGateRead,
): string | undefined {
	if (read.entity === "field") {
		const field = doc.fields[read.carrier];
		if (!field) return undefined;
		const formUuid = findContainingForm(doc, read.carrier);
		const form = formUuid !== undefined ? doc.forms[formUuid] : undefined;
		const where = form ? ` in form "${form.name}"` : "";
		const noun = read.slot === "validate" ? "the validation" : "the visibility";
		return `${noun} of "${field.id}"${where}`;
	}
	if (read.entity === "form") {
		const form = doc.forms[read.carrier];
		if (!form) return undefined;
		return `a form link condition on "${form.name}"`;
	}
	const mod = doc.modules[read.carrier];
	if (!mod) return undefined;
	return read.slot === "case_list_filter"
		? `the case-list filter on module "${mod.name}"`
		: `the search-button condition on module "${mod.name}"`;
}

/**
 * The advisory as one honest sentence: what reads the property, that
 * nothing in the app writes it, and what that means for records. The
 * shared renderer behind the SA tool-result note, the blueprint
 * summary's advisory section, and any other prose surface — one
 * wording, everywhere.
 */
export function describeNoWriterAdvisory(
	doc: BlueprintDoc,
	advisory: NoWriterAdvisory,
): string {
	const surfaces = advisory.reads
		.map((read) => readSurface(doc, read))
		.filter((s): s is string => typeof s === "string");
	const shown =
		surfaces.length > 4
			? [...surfaces.slice(0, 3), `${surfaces.length - 3} more`]
			: surfaces;
	const readsText = shown.join("; ");
	return `\`${advisory.property}\` (case type \`${advisory.caseType}\`) is read by ${readsText}, but no form in this app writes it — records can only reach the gated state if something outside this app sets that property.`;
}

const advisoryKey = (a: NoWriterAdvisory): string =>
	`${a.caseType} ${a.property}`;

/**
 * The delta note for a committed batch: the advisories the batch
 * INTRODUCED (present after, absent before), rendered person-to-person
 * with the two honest remediations. `undefined` when the batch
 * introduced none — the common case, so mutating tool results stay
 * quiet. Resolved advisories are deliberately silent: the fix is its
 * own confirmation.
 *
 * Both mutating-tool chokepoints consume this — the chat SA's
 * `wrapMutating` and the MCP adapter — so every mutating tool reports
 * the same way with no per-tool wiring.
 */
export function describeIntroducedAdvisories(
	prevDoc: BlueprintDoc,
	nextDoc: BlueprintDoc,
): string | undefined {
	const before = new Set(noWriterAdvisories(prevDoc).map(advisoryKey));
	const introduced = noWriterAdvisories(nextDoc).filter(
		(a) => !before.has(advisoryKey(a)),
	);
	if (introduced.length === 0) return undefined;
	return [
		"Heads-up — after this change, gated behavior depends on case properties nothing in the app writes:",
		...introduced.map((a) => `- ${describeNoWriterAdvisory(nextDoc, a)}`),
		"Add a field that writes the property, or — if another app or system genuinely sets it — record that on the property (markPropertyExternal) so this stops flagging.",
	].join("\n");
}
