/**
 * Unwritten-property reads — the informational "where does this data
 * come from?" derivation.
 *
 * A case property the app READS (a visibility or validation
 * expression, a case-list column or filter, a search input, a prose
 * mention…) while no form in the app WRITES it gets its values from
 * outside the app: another app on the same case type, an integration,
 * or staged sample data. That is a normal, often deliberate state — a
 * viewer app over externally-managed cases is exactly this for every
 * property it shows — so this is a FACT to surface, never a finding:
 * nothing here gates a commit, blocks an export, or asks anyone to fix
 * anything.
 *
 * Three consumers, one derivation:
 *   - the app-settings "written outside this app" dialog
 *     (`components/builder/detail/appSettings/`), via
 *     `useUnwrittenProperties`;
 *   - the blueprint summary's closing `<system_reminder>` block
 *     (`lib/agent/summarizeBlueprint.ts`) — background knowledge for
 *     the SA, explicitly not for relaying to the user;
 *   - `getField`'s per-field `<system_reminder>` when the field it
 *     returns reads one.
 *
 * ## The rule
 *
 * A DECLARED catalog property appears iff something references it from
 * any registry slot (`referencingSlotsOf` — every read edge in the
 * reference index) and no field writes it (`declarersOf` — the same
 * `(case_property_on, id)` derivation `effectiveCaseTypes` types
 * properties from). CommCare standard properties (`case_name`,
 * `date_opened`, …) and `case_id` are excluded — the runtime writes
 * those on every case.
 *
 * Iterating declared entries is complete in a valid doc: the
 * validator's admission set only accepts references to properties the
 * effective view carries, and an effective-view property that is NOT
 * declared is writer-derived — i.e. it has a writer and can't appear.
 *
 * Writer EXISTENCE is the whole check. Whether the writers can reach a
 * particular value some expression compares against is a different
 * (value-level) question this derivation never claims to answer — the
 * copy says "no form writes it", nothing stronger.
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

/** Which entity record holds the reading slot. */
export type UnwrittenReadEntity = "field" | "form" | "module";

/** One read of an unwritten property: who reads it, from which
 *  registry slot. */
export interface UnwrittenPropertyRead {
	readonly carrier: Uuid;
	readonly entity: UnwrittenReadEntity;
	readonly slot: string;
}

/** One unwritten property: a `(caseType, property)` pair the app reads
 *  while no form in it writes. */
export interface UnwrittenProperty {
	readonly caseType: string;
	readonly property: string;
	readonly reads: readonly UnwrittenPropertyRead[];
}

const CACHE = new WeakMap<object, readonly UnwrittenProperty[]>();

const ENTITY_RANK: Record<UnwrittenReadEntity, number> = {
	field: 0,
	form: 1,
	module: 2,
};

/**
 * Every unwritten property the doc currently reads, in catalog order
 * (types, then properties, as declared) with reads deterministically
 * sorted — same doc, same output, on every surface.
 */
export function unwrittenProperties(
	doc: BlueprintDoc,
): readonly UnwrittenProperty[] {
	const cached = CACHE.get(doc);
	if (cached !== undefined) return cached;
	const built = build(doc);
	CACHE.set(doc, built);
	return built;
}

function build(doc: BlueprintDoc): readonly UnwrittenProperty[] {
	const result: UnwrittenProperty[] = [];
	for (const ct of doc.caseTypes ?? []) {
		const seen = new Set<string>();
		for (const prop of ct.properties) {
			if (seen.has(prop.name)) continue;
			seen.add(prop.name);
			// The runtime writes the standard properties (and allocates
			// `case_id`) on every case — "no in-app writer" is their normal
			// state, not information.
			if (isStandardCaseListProperty(prop.name) || prop.name === "case_id") {
				continue;
			}
			// Writer check first — one O(1) index lookup skips the read
			// collection (map build + entity resolution + sort) for the
			// steady-state majority: written properties.
			if (declarersOf(doc, ct.name, prop.name).length > 0) continue;
			const reads = readsOf(doc, ct.name, prop.name);
			if (reads.length === 0) continue;
			result.push({ caseType: ct.name, property: prop.name, reads });
		}
	}
	return result;
}

function readsOf(
	doc: BlueprintDoc,
	caseType: string,
	property: string,
): UnwrittenPropertyRead[] {
	const bySlot = referencingSlotsOf(
		doc,
		casePropertyTargetKey(caseType, property),
	);
	const reads: UnwrittenPropertyRead[] = [];
	for (const [carrier, slots] of bySlot) {
		const entity: UnwrittenReadEntity | undefined = doc.fields[carrier]
			? "field"
			: doc.forms[carrier]
				? "form"
				: doc.modules[carrier]
					? "module"
					: undefined;
		if (entity === undefined) continue;
		for (const slot of slots) {
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

/**
 * The unwritten properties any of `carriers` reads — `getField`'s
 * reminder lookup (the returned field plus, for containers, every
 * field in its subtree). A plain filter over the memoized flat list:
 * the list is small and per-doc-stable, so a second index would be
 * caching noise.
 */
export function unwrittenPropertiesReadBy(
	doc: BlueprintDoc,
	carriers: ReadonlySet<string>,
): readonly UnwrittenProperty[] {
	return unwrittenProperties(doc).filter((entry) =>
		entry.reads.some((read) => carriers.has(read.carrier)),
	);
}

// ── Person-readable rendering ───────────────────────────────────────

/** Field-slot phrasing: what the slot DOES with the value. Slots not
 *  named here fall back to the generic expression phrase. Each map is
 *  `satisfies`-pinned to the reference-slot registry
 *  (`lib/domain/referenceSlots.ts`) so a slot rename breaks this build
 *  instead of silently degrading every mention of that slot to the
 *  generic fallback (and a typo'd key can't sit here unmatched). */
const FIELD_SLOT_NOUNS: Readonly<Record<string, string>> = {
	relevant: "the visibility",
	validate: "the validation",
	calculate: "the calculation",
	default_value: "the default value",
	required: "the required condition",
	repeat_count: "the repeat count",
	ids_query: "the repeat data source",
	label: "the display text",
	hint: "the display text",
	help: "the display text",
	validate_msg: "the display text",
	option_label: "the display text",
} satisfies Partial<Record<FieldSlotId, string>>;

const MODULE_SLOT_PHRASES: Readonly<Record<string, string>> = {
	case_list_filter: "the case-list filter on module",
	case_list_column_field: "a case-list column of module",
	case_list_column_expression: "a case-list column of module",
	search_input_property: "a search input of module",
	search_input_via: "a search input of module",
	search_input_default: "a search input of module",
	search_input_predicate: "a search input of module",
	search_button_display_condition: "the search-button condition on module",
	excluded_owner_ids: "the owner filter on module",
} satisfies Partial<Record<ModuleSlotId, string>>;

const FORM_SLOT_PHRASES: Readonly<Record<string, string>> = {
	form_link_condition: "a form link condition on",
	form_link_datum_xpath: "a form link datum on",
	assessment_user_score: "the Connect config of",
	deliver_entity_id: "the Connect config of",
	deliver_entity_name: "the Connect config of",
} satisfies Partial<Record<FormSlotId, string>>;

/**
 * One read as a human surface ("the visibility of "dose" in form
 * "Administer Medication"", "a case-list column of module "Orders"").
 * Total over the slot vocabulary — an unmapped slot phrases
 * generically rather than dropping. `undefined` only when the carrier
 * vanished from the doc between derivation and rendering (unreachable
 * on the memoized same-doc path).
 */
export function describePropertyRead(
	doc: BlueprintDoc,
	read: UnwrittenPropertyRead,
): string | undefined {
	if (read.entity === "field") {
		const field = doc.fields[read.carrier];
		if (!field) return undefined;
		const formUuid = findContainingForm(doc, read.carrier);
		const form = formUuid !== undefined ? doc.forms[formUuid] : undefined;
		const where = form ? ` in form "${form.name}"` : "";
		const noun = FIELD_SLOT_NOUNS[read.slot] ?? "an expression";
		return `${noun} of "${field.id}"${where}`;
	}
	if (read.entity === "form") {
		const form = doc.forms[read.carrier];
		if (!form) return undefined;
		const phrase = FORM_SLOT_PHRASES[read.slot] ?? "an expression on form";
		return `${phrase} "${form.name}"`;
	}
	const mod = doc.modules[read.carrier];
	if (!mod) return undefined;
	const phrase = MODULE_SLOT_PHRASES[read.slot] ?? "an expression on module";
	return `${phrase} "${mod.name}"`;
}

/**
 * One unwritten property as a factual line — the property, its case
 * type, and where it is read. Deliberately carries no advice and no
 * alarm: the consumers own their own framing (the dialog explains
 * once at the top, the reminders wrap it in for-your-knowledge
 * context).
 */
export function describeUnwrittenProperty(
	doc: BlueprintDoc,
	entry: UnwrittenProperty,
): string {
	const deduped = describedReadsOf(doc, entry);
	const shown =
		deduped.length > 4
			? [...deduped.slice(0, 3), `${deduped.length - 3} more`]
			: deduped;
	return `\`${entry.property}\` (case type \`${entry.caseType}\`) — read by ${shown.join("; ")}`;
}

function describedReadsOf(
	doc: BlueprintDoc,
	entry: UnwrittenProperty,
): readonly string[] {
	const surfaces = entry.reads
		.map((read) => describePropertyRead(doc, read))
		.filter((s): s is string => typeof s === "string");
	return [...new Set(surfaces)];
}

/** One unwritten property pre-rendered for display: the pair plus its
 *  deduped human-readable read locations. */
export interface UnwrittenPropertyCard {
	readonly caseType: string;
	readonly property: string;
	readonly reads: readonly string[];
}

const CARDS_CACHE = new WeakMap<object, readonly UnwrittenPropertyCard[]>();

/**
 * The display projection the app-settings dialog renders — the same
 * derivation with each read resolved to prose here (doc in hand),
 * because components reach the doc only through named hooks and a
 * per-render resolve would defeat referential stability. Memoized per
 * doc reference like the derivation itself.
 */
export function unwrittenPropertyCards(
	doc: BlueprintDoc,
): readonly UnwrittenPropertyCard[] {
	const cached = CARDS_CACHE.get(doc);
	if (cached !== undefined) return cached;
	const built = unwrittenProperties(doc).map((entry) => ({
		caseType: entry.caseType,
		property: entry.property,
		reads: describedReadsOf(doc, entry),
	}));
	CARDS_CACHE.set(doc, built);
	return built;
}
