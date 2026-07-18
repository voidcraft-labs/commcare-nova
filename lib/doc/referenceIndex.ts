/**
 * Reference-index construction, per-mutation maintenance, and queries —
 * the machinery behind `BlueprintDoc.refIndex`
 * (`lib/domain/referenceIndex.ts` owns the shape and key vocabulary).
 *
 * Every reference operation in the write path answers "who references
 * X?" / "who declares X?" through these lookups instead of walking the
 * document: the rename cascade and `moveField`'s prose re-anchor pass
 * (`mutations/fields.ts`), the case-type retirement planner
 * (`caseTypeRetirement.ts`), and the peer-aware rename verdict
 * (`identifierVerdicts.ts`). Edges carry (carrier uuid, slot id),
 * never character positions — a consumer that needs structure walks
 * the named slot's leaves (AST slots) or re-locates the hashtag
 * substrings (prose), so nothing positional can go stale across
 * mutations.
 *
 * ## One extractor, two builders
 *
 * `buildReferenceIndex(doc)` derives the whole index from the doc alone
 * — it is both the hydration builder (store load, MCP blueprint load,
 * the chat route's working doc) and the fuzz oracle the incremental
 * maintenance is proven against (`__tests__/referenceIndex.fuzz.test.ts`
 * asserts incremental ≡ rebuild after every applied batch). Both paths
 * share the same per-carrier extraction, so they cannot diverge on what
 * an edge IS — a divergence is a maintenance bug by definition.
 *
 * ## Extraction discipline
 *
 * Expression slots store the XPath AST (`lib/domain/xpath`), so their
 * extraction is a pure leaf walk — identity leaves edge directly, no
 * parse, no resolution. Prose slots are located with the shared
 * hashtag matcher (`lib/domain/hashtagSegments.ts`) and their refs
 * resolved against the doc, never parsed as XPath.
 * Predicate/value-expression slots are walked structurally via
 * `lib/domain/predicate`'s term walkers, keying each `PropertyRef` on
 * the walk's DESTINATION type — the rename rewriter's matching rule.
 *
 * ## Maintenance shape
 *
 * `applyMutation(s)` (the one dispatch chokepoint in
 * `mutations/index.ts`) seeds the index on first contact and then, per
 * mutation, re-derives exactly the carriers the mutation could have
 * changed: the named entity (plus its subtree on removals, plus minted
 * clones on duplication), the carriers whose edges a rename re-keys
 * (peers via the declarations index, property referencers via the
 * `c:`-bucket), and two resolution-context groups —
 *
 *   - `local[form]`: carriers whose PROSE embeds form-local hashtag
 *     text. Prose refs resolve by id-path against the form's field
 *     tree at extraction, so any mutation that changes the form's
 *     id/path namespace (add/remove/move/rename/duplicate) can flip a
 *     ref between dangling and resolved WITHOUT touching the carrier.
 *     Re-deriving the bucket keeps the incremental index equal to a
 *     rebuild even for those at-a-distance shifts. AST slots never
 *     join: their identity leaves resolve at PRINT, and an unresolved
 *     leaf stays text forever — extraction has no resolution to track.
 *   - `ctx[module]`: carriers whose extraction read the module's case
 *     type (contextual `#case/…` refs, prose or transitional AST raw
 *     leaves). A module case-type change or a cross-module form move
 *     re-keys their `c:` edges the same way.
 *
 * Re-extraction is idempotent, so over-approximating a touched set
 * costs only repeated parses of that carrier's own slots — never
 * correctness.
 *
 * Everything here is total in the reducer sense: malformed shapes,
 * unresolvable references, and unparseable expressions extract to
 * fewer edges (or none), never to a throw.
 */

import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	buildHashtagRefRegex,
	casePropertyDeclKey,
	casePropertyTargetKey,
	caseTypeTargetKey,
	entityTargetKey,
	type Field,
	FORM_REFERENCE_SLOTS,
	type Form,
	fieldCasePropertyOn,
	fieldReferenceSlotsFor,
	isXPathExpression,
	MODULE_REFERENCE_SLOTS,
	type Module,
	type ReferenceIndex,
	readSlotStrings,
	readSlotValues,
	type Uuid,
	type XPathExpression,
} from "@/lib/domain";
import {
	type Predicate,
	type RelationPath,
	relationDestinationCaseType,
	type Term,
	type ValueExpression,
	walkExpressionTerms,
	walkTerms,
} from "@/lib/domain/predicate";
import { findContainingForm, walkFormFieldUuids } from "./mutations/helpers";

// ── Index primitives ────────────────────────────────────────────────

function emptyReferenceIndex(): ReferenceIndex {
	return { in: {}, out: {}, decl: {}, local: {}, ctx: {} };
}

function isEmptyRecord(record: object): boolean {
	for (const _ in record) return false;
	return true;
}

type SetBucket = Record<string, Record<string, true>>;

function addToBucket(bucket: SetBucket, key: string, member: string): void {
	const members = bucket[key] ?? {};
	members[member] = true;
	bucket[key] = members;
}

/** Remove `member` from `bucket[key]`, dropping the now-empty inner
 *  record — empty sub-records must not linger, or the incremental index
 *  stops deep-equaling a from-scratch rebuild. */
function removeFromBucket(
	bucket: SetBucket,
	key: string,
	member: string,
): void {
	const inner = bucket[key];
	if (!inner) return;
	delete inner[member];
	if (isEmptyRecord(inner)) delete bucket[key];
}

/**
 * The extraction context a carrier's references resolve in: the
 * containing form (form-local id-path resolution) and the owning
 * module (whose `caseType` contextualizes `#case/…` refs and the
 * module config's property slots).
 */
interface CarrierContext {
	formUuid?: Uuid;
	moduleUuid?: Uuid;
	moduleCaseType?: string;
}

/**
 * Resolve a carrier's context from current doc structure. Always
 * structural (never a cached mirror) so the incremental path and the
 * rebuild resolve identically — including in degenerate docs where a
 * mirror could have gone stale.
 *
 * Cost shape: `findContainingForm` walks parents via order-array scans,
 * so maintenance brackets at O(touched carriers × doc structure) per
 * mutation. Caching a per-carrier form mirror on the index entry would
 * make this O(1) but is rejected deliberately: total reducers can
 * replay degenerate states (an addField whose uuid already sits under
 * another parent leaves one uuid in two order arrays), and there a
 * stale mirror and a structural walk resolve differently — breaking
 * the incremental ≡ rebuild oracle, which is worth more than the
 * bracket. Reference LOOKUPS are unaffected either way: they read the
 * maintained buckets in O(1).
 */
function carrierContext(doc: BlueprintDoc, carrier: string): CarrierContext {
	const mod = doc.modules[carrier];
	if (mod) {
		return {
			moduleUuid: carrier as Uuid,
			...(mod.caseType !== undefined && { moduleCaseType: mod.caseType }),
		};
	}
	let formUuid: Uuid | undefined;
	if (doc.forms[carrier]) formUuid = carrier as Uuid;
	else if (doc.fields[carrier]) {
		formUuid = findContainingForm(doc, carrier as Uuid);
	} else return {};
	if (formUuid === undefined) return {};
	const moduleUuid = resolveFormModule(doc, formUuid);
	const moduleCaseType =
		moduleUuid !== undefined ? doc.modules[moduleUuid]?.caseType : undefined;
	return {
		formUuid,
		...(moduleUuid !== undefined && { moduleUuid }),
		...(moduleCaseType !== undefined && { moduleCaseType }),
	};
}

/** The module whose `formOrder` lists this form — first match in
 *  insertion order, the same rule on every resolution path. */
function resolveFormModule(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Uuid | undefined {
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		if (formUuids.includes(formUuid)) return moduleUuid as Uuid;
	}
	return undefined;
}

/**
 * Drop every trace of `carrier` from the index in O(its own edges),
 * via its `out` mirror entry.
 */
function unindexCarrier(index: ReferenceIndex, carrier: string): void {
	const entry = index.out[carrier];
	if (!entry) return;
	for (const target of Object.keys(entry.edges)) {
		const byCarrier = index.in[target];
		if (!byCarrier) continue;
		delete byCarrier[carrier];
		if (isEmptyRecord(byCarrier)) delete index.in[target];
	}
	if (entry.decl !== undefined) {
		removeFromBucket(index.decl, entry.decl, carrier);
	}
	if (entry.local !== undefined) {
		removeFromBucket(index.local, entry.local, carrier);
	}
	if (entry.ctx !== undefined) removeFromBucket(index.ctx, entry.ctx, carrier);
	delete index.out[carrier];
}

/**
 * Register a field's `(case_property_on, id)` case-property
 * contribution (`decl`). Runs for EVERY (re-)indexed field BEFORE any
 * edge extraction in the same pass.
 */
function registerFieldDeclarations(
	index: ReferenceIndex,
	doc: BlueprintDoc,
	carrier: string,
): void {
	const field = doc.fields[carrier];
	if (!field || field.id.length === 0) return;
	const caseType = fieldCasePropertyOn(field);
	if (caseType === undefined) return;
	const entry = index.out[carrier] ?? { edges: {} };
	index.out[carrier] = entry;
	const key = casePropertyDeclKey(caseType, field.id);
	entry.decl = key;
	addToBucket(index.decl, key, carrier);
}

// ── Edge sink ───────────────────────────────────────────────────────

interface EdgeSink {
	edge(targetKey: string, slot: string): void;
	markLocal(): void;
	markCtx(): void;
}

function makeSink(
	index: ReferenceIndex,
	carrier: string,
	ctx: CarrierContext,
): EdgeSink {
	const entry = () => {
		const existing = index.out[carrier] ?? { edges: {} };
		index.out[carrier] = existing;
		return existing;
	};
	return {
		edge(targetKey, slot) {
			const e = entry();
			const slots = e.edges[targetKey] ?? {};
			slots[slot] = true;
			e.edges[targetKey] = slots;
			const byCarrier = index.in[targetKey] ?? {};
			index.in[targetKey] = byCarrier;
			const inSlots = byCarrier[carrier] ?? {};
			inSlots[slot] = true;
			byCarrier[carrier] = inSlots;
		},
		markLocal() {
			if (ctx.formUuid === undefined) return;
			const e = entry();
			if (e.local !== undefined) return;
			e.local = ctx.formUuid;
			addToBucket(index.local, ctx.formUuid, carrier);
		},
		markCtx() {
			if (ctx.moduleUuid === undefined) return;
			const e = entry();
			if (e.ctx !== undefined) return;
			e.ctx = ctx.moduleUuid;
			addToBucket(index.ctx, ctx.moduleUuid, carrier);
		},
	};
}

// ── Per-carrier extraction ──────────────────────────────────────────

function extractCarrierEdges(
	index: ReferenceIndex,
	doc: BlueprintDoc,
	carrier: string,
	ctx: CarrierContext,
): void {
	const mod = doc.modules[carrier];
	if (mod) {
		extractModuleEdges(makeSink(index, carrier, ctx), mod);
		return;
	}
	const form = doc.forms[carrier];
	if (form) {
		extractFormEdges(makeSink(index, carrier, ctx), form, ctx);
		return;
	}
	const field = doc.fields[carrier];
	if (field) extractFieldEdges(makeSink(index, carrier, ctx), doc, field, ctx);
}

function extractFieldEdges(
	sink: EdgeSink,
	doc: BlueprintDoc,
	field: Field,
	ctx: CarrierContext,
): void {
	const repeatMode = field.kind === "repeat" ? field.repeat_mode : undefined;
	for (const slot of fieldReferenceSlotsFor(field.kind, repeatMode)) {
		switch (slot.kind) {
			case "xpath-ast":
				for (const value of readSlotValues(field, slot.path)) {
					if (isXPathExpression(value.value)) {
						extractAstRefs(sink, ctx, value.value, slot.slot);
					}
				}
				break;
			case "prose":
				for (const value of readSlotStrings(field, slot.path)) {
					extractProseRefs(sink, doc, ctx, value.text, slot.slot);
				}
				break;
			case "case-type-ref":
				// `case_property_on` — names the case type the field writes
				// to. The matching DECLARATION entry is registered separately
				// (`registerFieldDeclarations`); the edge here is what makes
				// the field show up as a referencer of the type.
				for (const value of readSlotStrings(field, slot.path)) {
					if (value.text.length > 0) {
						sink.edge(caseTypeTargetKey(value.text), slot.slot);
					}
				}
				break;
			case "predicate-ast":
			case "entity-uuid":
			case "case-property-ref":
				// No field slot carries these kinds today — kept explicit so
				// the registry's kind union stays exhaustively handled here,
				// the same contract the rename rewriters hold.
				break;
			default: {
				const _exhaustive: never = slot.kind;
				break;
			}
		}
	}
}

function extractFormEdges(
	sink: EdgeSink,
	form: Form,
	ctx: CarrierContext,
): void {
	for (const slot of FORM_REFERENCE_SLOTS) {
		switch (slot.slot) {
			case "form_link_condition":
			case "form_link_datum_xpath":
			case "assessment_user_score":
			case "deliver_entity_id":
			case "deliver_entity_name":
				// AST-stored form wiring (form-link conditions/datums reference
				// the form's OWN fields per CCHQ's end-of-form navigation
				// semantics; Connect bindings likewise) — a pure leaf walk,
				// same as the field expression slots.
				for (const value of readSlotValues(form, slot.path)) {
					if (isXPathExpression(value.value)) {
						extractAstRefs(sink, ctx, value.value, slot.slot);
					}
				}
				break;
			case "close_condition_field": {
				// The checked field's stable uuid — an UNCONDITIONAL identity
				// edge, like every AST leaf: no doc-dependent resolution, so
				// the incremental index can't drift from a rebuild when the
				// target appears or disappears at a distance. A legacy dangler
				// (id text the migration couldn't resolve) edges to a key
				// nothing ever queries.
				const ref = form.closeCondition?.field;
				if (typeof ref !== "string" || ref.length === 0) break;
				sink.edge(entityTargetKey(ref), slot.slot);
				break;
			}
			case "form_link_target": {
				// entity-uuid — the discriminated target value is read
				// structurally: both arms carry `moduleUuid`, the `form` arm
				// adds `formUuid`.
				for (const link of form.formLinks ?? []) {
					const target = link?.target as
						| { moduleUuid?: unknown; formUuid?: unknown }
						| undefined;
					if (
						typeof target?.moduleUuid === "string" &&
						target.moduleUuid.length > 0
					) {
						sink.edge(entityTargetKey(target.moduleUuid), slot.slot);
					}
					if (
						typeof target?.formUuid === "string" &&
						target.formUuid.length > 0
					) {
						sink.edge(entityTargetKey(target.formUuid), slot.slot);
					}
				}
				break;
			}
			default: {
				const _exhaustive: never = slot;
				break;
			}
		}
	}
}

function extractModuleEdges(sink: EdgeSink, mod: Module): void {
	const list = mod.caseListConfig;
	const search = mod.caseSearchConfig;
	for (const slot of MODULE_REFERENCE_SLOTS) {
		switch (slot.slot) {
			case "case_type":
				// The module's own type. Slot-tagged so consumers that treat
				// ownership separately from reference (the retirement planner)
				// can tell this edge apart from genuine reads of the type.
				if (typeof mod.caseType === "string" && mod.caseType.length > 0) {
					sink.edge(caseTypeTargetKey(mod.caseType), slot.slot);
				}
				break;
			case "case_list_column_field": {
				// Contextual property name — follows the module's own type.
				// No `t:` edge: the column never NAMES a type. The module
				// carrier needs no ctx mark — a case-type change arrives as
				// `updateModule`, which re-extracts the module itself.
				const caseType = mod.caseType;
				if (!caseType) break;
				for (const col of list?.columns ?? []) {
					if (col.kind === "calculated") continue;
					if (typeof col.field === "string" && col.field.length > 0) {
						sink.edge(casePropertyTargetKey(caseType, col.field), slot.slot);
					}
				}
				break;
			}
			case "case_list_column_expression":
				for (const col of list?.columns ?? []) {
					if (col.kind === "calculated") {
						expressionEdges(sink, slot.slot, col.expression);
					}
				}
				break;
			case "case_list_filter":
				if (list?.filter) predicateEdges(sink, slot.slot, list.filter);
				break;
			case "search_input_property": {
				// Contextual like the column slot, but the via walk can move
				// the read to an explicit destination type — the same rule the
				// rename rewriter matches on.
				for (const input of list?.searchInputs ?? []) {
					if (input.kind !== "simple") continue;
					if (typeof input.property !== "string" || input.property.length === 0)
						continue;
					const destination = relationDestinationCaseType(
						input.via,
						mod.caseType,
					);
					if (destination) {
						sink.edge(
							casePropertyTargetKey(destination, input.property),
							slot.slot,
						);
					}
				}
				break;
			}
			case "search_input_via":
				for (const input of list?.searchInputs ?? []) {
					if (input.kind === "simple") {
						relationHintEdges(sink, slot.slot, input.via);
					}
				}
				break;
			case "search_input_default":
				for (const input of list?.searchInputs ?? []) {
					if (input.default !== undefined) {
						expressionEdges(sink, slot.slot, input.default);
					}
				}
				break;
			case "search_input_predicate":
				for (const input of list?.searchInputs ?? []) {
					if (input.kind === "advanced") {
						predicateEdges(sink, slot.slot, input.predicate);
					}
				}
				break;
			case "search_button_display_condition":
				if (search?.searchButtonDisplayCondition) {
					predicateEdges(sink, slot.slot, search.searchButtonDisplayCondition);
				}
				break;
			case "excluded_owner_ids":
				if (search?.excludedOwnerIds) {
					expressionEdges(sink, slot.slot, search.excludedOwnerIds);
				}
				break;
			default: {
				const _exhaustive: never = slot;
				break;
			}
		}
	}
}

// ── AST leaf extraction ─────────────────────────────────────────────

/**
 * Edges for one AST term. A `prop` term names its ORIGIN type and any
 * relation-walk type hints (`t:` edges — the retirement planner's
 * vocabulary), and reads a property on the walk's DESTINATION type
 * (`c:` edge) when that destination is encoded. A walk without a hint
 * doesn't say where it lands, so no `c:` edge — mirroring the rename
 * rewriter, which deliberately leaves such refs alone.
 */
function termEdges(sink: EdgeSink, slot: string, term: Term): void {
	if (term.kind !== "prop") return;
	if (typeof term.caseType === "string" && term.caseType.length > 0) {
		sink.edge(caseTypeTargetKey(term.caseType), slot);
	}
	relationHintEdges(sink, slot, term.via);
	const destination = relationDestinationCaseType(term.via, term.caseType);
	if (
		destination &&
		typeof term.property === "string" &&
		term.property.length > 0
	) {
		sink.edge(casePropertyTargetKey(destination, term.property), slot);
	}
}

function relationHintEdges(
	sink: EdgeSink,
	slot: string,
	via: RelationPath | undefined,
): void {
	if (via === undefined || via.kind === "self") return;
	if (via.kind === "ancestor") {
		for (const step of via.via) {
			if (step.throughCaseType) {
				sink.edge(caseTypeTargetKey(step.throughCaseType), slot);
			}
		}
		return;
	}
	if (via.ofCaseType) sink.edge(caseTypeTargetKey(via.ofCaseType), slot);
}

/* The AST walkers throw on an unknown operator arm (their compile-time
 * exhaustiveness backstop). Extraction runs inside reducers, which stay
 * total — a malformed AST off a degenerate doc extracts zero edges from
 * that slot instead of taking the apply pipeline down. Both builders
 * catch identically, so parity holds either way. */
function predicateEdges(
	sink: EdgeSink,
	slot: string,
	predicate: Predicate,
): void {
	try {
		walkTerms(predicate, (term) => termEdges(sink, slot, term));
	} catch (err) {
		console.warn(
			`referenceIndex: couldn't walk the "${slot}" predicate for references — the stored shape has a node the walker doesn't recognize, so its references are not indexed.`,
			err,
		);
	}
}

function expressionEdges(
	sink: EdgeSink,
	slot: string,
	expression: ValueExpression,
): void {
	try {
		walkExpressionTerms(expression, (term) => termEdges(sink, slot, term));
	} catch (err) {
		console.warn(
			`referenceIndex: couldn't walk the "${slot}" expression for references — the stored shape has a node the walker doesn't recognize, so its references are not indexed.`,
			err,
		);
	}
}

// ── Expression-AST leaf extraction ──────────────────────────────────

/**
 * Edges for one stored expression AST — a pure leaf walk, no parse:
 *
 *   - `field-ref` / `path-ref` carry the target's uuid directly. No
 *     `local` mark: identity edges cannot shift with the form's id
 *     namespace, which is the whole point of the representation.
 *   - `case-ref` names its type (`t:`) and reads its property (`c:`).
 *   - `raw-ref` keeps the string extractor's namespace dispatch: a
 *     contextual `#case/<prop>` keys under the owning module's CURRENT
 *     type and marks the carrier context-dependent; an explicit
 *     namespace (always multi-segment here — single-segment explicit
 *     refs parse to `case-ref` leaves) names its type; dangling
 *     `#form/…` and `#user/…` shapes contribute nothing — an
 *     unresolved leaf stays text forever, so there is no resolution
 *     to track.
 */
function extractAstRefs(
	sink: EdgeSink,
	ctx: CarrierContext,
	expr: XPathExpression,
	slot: string,
): void {
	for (const part of expr.parts) {
		switch (part.kind) {
			case "text":
				break;
			case "field-ref":
			case "path-ref":
				sink.edge(entityTargetKey(part.uuid), slot);
				break;
			case "case-ref":
				sink.edge(caseTypeTargetKey(part.caseType), slot);
				sink.edge(casePropertyTargetKey(part.caseType, part.property), slot);
				break;
			case "user-ref":
				break;
			case "raw-ref":
				if (part.namespace === "case") {
					sink.markCtx();
					if (part.segments.length === 1 && ctx.moduleCaseType) {
						sink.edge(
							casePropertyTargetKey(ctx.moduleCaseType, part.segments[0]),
							slot,
						);
					}
				} else if (part.namespace !== "form" && part.namespace !== "user") {
					sink.edge(caseTypeTargetKey(part.namespace), slot);
				}
				break;
			default: {
				const _exhaustive: never = part;
				break;
			}
		}
	}
}

// ── Prose extraction ────────────────────────────────────────────────

/**
 * Edges for one prose string. Only the bare-hashtag substrings the
 * shared matcher locates are reference-bearing — the surrounding text
 * is never parsed as XPath, exactly like the prose rewrite path.
 */
function extractProseRefs(
	sink: EdgeSink,
	doc: BlueprintDoc,
	ctx: CarrierContext,
	text: string,
	slot: string,
): void {
	if (!text?.includes("#")) return;
	const re = buildHashtagRefRegex("g");
	for (let match = re.exec(text); match !== null; match = re.exec(text)) {
		const parts = match[0].slice(1).split("/");
		hashtagEdges(sink, doc, ctx, slot, parts[0] ?? "", parts.slice(1));
	}
}

/**
 * Namespace dispatch shared by the XPath and prose extractors:
 *
 *   - `form` — form-local; a `u:` edge per resolved anchored prefix.
 *   - `user` — built-in user properties, outside the doc; no edge.
 *   - `case` — contextual; keys under the owning module's CURRENT case
 *     type (single-segment refs only — multi-segment `#case/…` is a
 *     shape the property-rename rewriter never matches), and marks the
 *     carrier context-dependent either way so a later type change
 *     re-extracts it.
 *   - anything else — an explicit case-type namespace: a `t:` edge
 *     always, plus the `c:` property edge for the single-segment form.
 */
function hashtagEdges(
	sink: EdgeSink,
	doc: BlueprintDoc,
	ctx: CarrierContext,
	slot: string,
	namespace: string,
	segments: string[],
): void {
	if (namespace.length === 0) return;
	if (namespace === "form") {
		sink.markLocal();
		for (const uuid of resolveIdChain(doc, ctx.formUuid, segments)) {
			sink.edge(entityTargetKey(uuid), slot);
		}
		return;
	}
	if (namespace === "user") return;
	if (namespace === "case") {
		sink.markCtx();
		if (segments.length === 1 && ctx.moduleCaseType) {
			sink.edge(casePropertyTargetKey(ctx.moduleCaseType, segments[0]), slot);
		}
		return;
	}
	sink.edge(caseTypeTargetKey(namespace), slot);
	if (segments.length === 1) {
		sink.edge(casePropertyTargetKey(namespace, segments[0]), slot);
	}
}

/**
 * Resolve an id path stepwise from the form root, returning the field
 * uuid landed on at each step (stopping at the first unresolvable
 * segment). Resolution follows `fieldOrder` structure by semantic id —
 * the same anchored-prefix walk the rewriters' segment matching
 * performs textually.
 */
function resolveIdChain(
	doc: BlueprintDoc,
	formUuid: Uuid | undefined,
	segments: readonly string[],
): Uuid[] {
	if (formUuid === undefined) return [];
	const resolved: Uuid[] = [];
	let parent: Uuid = formUuid;
	for (const segment of segments) {
		const children = doc.fieldOrder[parent] ?? [];
		const next = children.find((uuid) => doc.fields[uuid]?.id === segment);
		if (next === undefined) break;
		resolved.push(next);
		parent = next;
	}
	return resolved;
}

// ── Builders + accessors ────────────────────────────────────────────

/**
 * Derive the whole index from the doc alone — the hydration builder
 * AND the oracle the incremental maintenance is fuzz-proven against.
 * Two phases: declarations first (every field's case-property
 * contribution), then edges — same order the maintenance pass keeps,
 * so the two builders settle identical structures.
 */
export function buildReferenceIndex(doc: BlueprintDoc): ReferenceIndex {
	const index = emptyReferenceIndex();
	const contexts = new Map<string, CarrierContext>();
	const carriers = [
		...Object.keys(doc.modules),
		...Object.keys(doc.forms),
		...Object.keys(doc.fields),
	];
	for (const carrier of carriers) {
		contexts.set(carrier, carrierContext(doc, carrier));
	}
	for (const carrier of Object.keys(doc.fields)) {
		registerFieldDeclarations(index, doc, carrier);
	}
	for (const carrier of carriers) {
		extractCarrierEdges(index, doc, carrier, contexts.get(carrier) ?? {});
	}
	return index;
}

/** Seed `doc.refIndex` when absent (every apply entry point and
 *  hydration site calls this); returns the live index. */
export function ensureReferenceIndex(doc: BlueprintDoc): ReferenceIndex {
	doc.refIndex ??= buildReferenceIndex(doc);
	return doc.refIndex;
}

/**
 * The index for a doc a caller cannot (or must not) mutate. Falls back
 * to a fresh build when the slot is absent — same answers, one-off
 * O(doc) cost — so reference queries stay total over docs that never
 * passed a hydration site (read-only widenings, test fixtures).
 */
function getReferenceIndex(doc: BlueprintDoc): ReferenceIndex {
	return doc.refIndex ?? buildReferenceIndex(doc);
}

// ── Queries ─────────────────────────────────────────────────────────

/** Carrier uuids holding ≥1 edge to `targetKey` ("who references X?"). */
export function referencingCarrierUuids(
	doc: BlueprintDoc,
	targetKey: string,
): string[] {
	return Object.keys(getReferenceIndex(doc).in[targetKey] ?? {});
}

/** Field uuids declaring the `(caseType, property)` pair — the
 *  case-property peer lookup ("who declares X / is this the last
 *  declarer?"). */
export function declarersOf(
	doc: BlueprintDoc,
	caseType: string,
	property: string,
): string[] {
	return Object.keys(
		getReferenceIndex(doc).decl[casePropertyDeclKey(caseType, property)] ?? {},
	);
}

// ── Per-mutation maintenance ────────────────────────────────────────

/**
 * The carriers a mutation can change, captured BEFORE the reducer runs
 * (removed subtrees and re-keyed-edge carriers are only knowable from
 * pre-state). `duplicated` defers clone discovery to the post-dispatch
 * step — `duplicateField` mints uuids inside the reducer.
 */
export interface ReferenceIndexMaintenance {
	carriers: Set<string>;
	duplicated?: { parentUuid: string; before: Set<string> };
}

const NO_MAINTENANCE: ReferenceIndexMaintenance = { carriers: new Set() };

export function planReferenceIndexMaintenance(
	doc: BlueprintDoc,
	mut: Mutation,
): ReferenceIndexMaintenance {
	const index = doc.refIndex;
	if (!index) return NO_MAINTENANCE;
	const carriers = new Set<string>();
	const addLocalCarriers = (formUuid: string | undefined): void => {
		if (formUuid === undefined) return;
		for (const carrier of Object.keys(index.local[formUuid] ?? {})) {
			carriers.add(carrier);
		}
	};
	const addFieldSubtree = (uuid: Uuid): void => {
		carriers.add(uuid);
		for (const descendant of walkFormFieldUuids(doc, uuid)) {
			carriers.add(descendant);
		}
	};
	const containingFormOf = (uuid: Uuid): Uuid | undefined =>
		doc.forms[uuid] ? uuid : findContainingForm(doc, uuid);

	switch (mut.kind) {
		// App-level slots are never indexed (the case-type catalog is
		// root-level data the planner reads directly), so the catalog kinds —
		// wholesale and granular alike — are no-ops here.
		case "setAppName":
		case "setConnectType":
		case "setAppLogo":
		case "setCaseTypes":
		case "declareCaseType":
		case "retireCaseType":
		case "addCaseProperty":
		case "setCaseProperty":
		case "removeCaseProperty":
		case "setCaseTypeMeta":
			break;
		case "addModule":
			carriers.add(mut.module.uuid);
			break;
		case "removeModule":
			carriers.add(mut.uuid);
			for (const formUuid of doc.formOrder[mut.uuid] ?? []) {
				carriers.add(formUuid);
				for (const fieldUuid of walkFormFieldUuids(doc, formUuid)) {
					carriers.add(fieldUuid);
				}
			}
			break;
		case "moveModule":
			// Order-only — no slot, declaration, or context changes.
			break;
		case "renameModule":
		case "setModuleMedia":
			// Nothing indexed changes (module ids and media aren't
			// references), but a uniform named-entity re-extract is cheap
			// and keeps the maintenance shape unconditional.
			carriers.add(mut.uuid);
			break;
		case "updateModule": {
			carriers.add(mut.uuid);
			// A case-type change re-keys every context-dependent ref in the
			// module's forms (`#case/…` extracts under the module's type).
			if ("caseType" in mut.patch) {
				const previous = doc.modules[mut.uuid]?.caseType;
				if (mut.patch.caseType !== previous) {
					for (const carrier of Object.keys(index.ctx[mut.uuid] ?? {})) {
						carriers.add(carrier);
					}
				}
			}
			break;
		}
		case "addForm":
			carriers.add(mut.form.uuid);
			break;
		case "removeForm":
			carriers.add(mut.uuid);
			for (const fieldUuid of walkFormFieldUuids(doc, mut.uuid)) {
				carriers.add(fieldUuid);
			}
			break;
		case "moveForm": {
			carriers.add(mut.uuid);
			// Crossing modules changes the case-type context the form's
			// subtree extracted under.
			const oldModule = resolveFormModule(doc, mut.uuid);
			if (oldModule !== undefined && oldModule !== mut.toModuleUuid) {
				const subtree = new Set<string>([
					mut.uuid,
					...walkFormFieldUuids(doc, mut.uuid),
				]);
				for (const carrier of Object.keys(index.ctx[oldModule] ?? {})) {
					if (subtree.has(carrier)) carriers.add(carrier);
				}
			} else if (oldModule === undefined) {
				// An unowned form (degenerate) gains a module — every carrier
				// in its subtree may now resolve context it couldn't before.
				for (const fieldUuid of walkFormFieldUuids(doc, mut.uuid)) {
					carriers.add(fieldUuid);
				}
			}
			break;
		}
		case "renameForm":
		case "updateForm":
		case "setFormMedia":
			carriers.add(mut.uuid);
			break;
		case "addField":
			carriers.add(mut.field.uuid);
			addLocalCarriers(containingFormOf(mut.parentUuid));
			break;
		case "removeField":
			addFieldSubtree(mut.uuid);
			addLocalCarriers(containingFormOf(mut.uuid));
			break;
		case "moveField":
			// The moved field's path (and possibly its dedup-renamed id)
			// changes; same-form refs re-anchor textually but resolution can
			// shift for refs the rewrite never matched.
			carriers.add(mut.uuid);
			addLocalCarriers(containingFormOf(mut.uuid));
			break;
		case "renameField": {
			const field = doc.fields[mut.uuid];
			if (!field || field.id === mut.newId) break;
			carriers.add(mut.uuid);
			addLocalCarriers(containingFormOf(mut.uuid));
			const caseType = fieldCasePropertyOn(field);
			if (caseType !== undefined && field.id.length > 0) {
				// Peers rename in lockstep (their declarations re-key, and
				// their forms' local namespaces change with them)…
				const declKey = casePropertyDeclKey(caseType, field.id);
				for (const peer of Object.keys(index.decl[declKey] ?? {})) {
					if (peer === mut.uuid) continue;
					carriers.add(peer);
					addLocalCarriers(
						doc.fields[peer]
							? findContainingForm(doc, peer as Uuid)
							: undefined,
					);
				}
				// …and every carrier reading the property re-keys from
				// `c:<type>/<old>` to `c:<type>/<new>`.
				const propertyKey = casePropertyTargetKey(caseType, field.id);
				for (const carrier of Object.keys(index.in[propertyKey] ?? {})) {
					carriers.add(carrier);
				}
			}
			break;
		}
		case "duplicateField": {
			addLocalCarriers(containingFormOf(mut.uuid));
			// The clone subtree's uuids are minted inside the reducer —
			// snapshot the parent's order so the post-dispatch step can diff
			// them out.
			const parentUuid = findParentOf(doc, mut.uuid);
			if (parentUuid !== undefined) {
				return {
					carriers,
					duplicated: {
						parentUuid,
						before: new Set(doc.fieldOrder[parentUuid] ?? []),
					},
				};
			}
			break;
		}
		case "convertField":
		case "setFieldMedia":
			carriers.add(mut.kind === "setFieldMedia" ? mut.fieldUuid : mut.uuid);
			break;
		// Case-list collection edits re-derive the OWNING MODULE's reference
		// slots exactly as `updateModule` does — the module's calc-column /
		// search-input AST edges + the always-on filter live on the module
		// carrier, so a re-extract of the module keeps the index current (a
		// later rename must find these edges, so they cannot be stubbed away).
		case "addColumn":
		case "updateColumn":
		case "removeColumn":
		case "moveColumn":
		case "addSearchInput":
		case "updateSearchInput":
		case "removeSearchInput":
		case "moveSearchInput":
			carriers.add(mut.moduleUuid);
			break;
		case "setCaseListMeta":
			carriers.add(mut.uuid);
			break;
		// Option edits re-derive the OWNING FIELD's reference slots exactly as
		// `updateField` does — an option label's `#<type>/<prop>` prose edges
		// live on the field carrier.
		case "addOption":
		case "updateOption":
		case "removeOption":
		case "moveOption":
			carriers.add(mut.fieldUuid);
			break;
		case "updateField": {
			carriers.add(mut.uuid);
			// The generic patch CAN carry `id` (the rename mutation is the
			// designed path, but replayed events are total) — an id change
			// shifts the form's namespace like a rename does.
			const patch = mut.patch as Record<string, unknown>;
			const field = doc.fields[mut.uuid];
			if (field && typeof patch.id === "string" && patch.id !== field.id) {
				addLocalCarriers(containingFormOf(mut.uuid));
			}
			break;
		}
		default: {
			const _exhaustive: never = mut;
			break;
		}
	}
	return { carriers };
}

/** The parent (form or container) whose order lists `uuid`. */
function findParentOf(doc: BlueprintDoc, uuid: Uuid): string | undefined {
	for (const [parentUuid, order] of Object.entries(doc.fieldOrder)) {
		if (order.includes(uuid)) return parentUuid;
	}
	return undefined;
}

/**
 * Re-derive the planned carriers against post-reducer state: resolve
 * contexts, un-index, re-register declarations (all of them, before
 * any edge extraction — same phase order as the rebuild), then extract
 * edges. A carrier the reducer deleted simply extracts to nothing.
 */
export function applyReferenceIndexMaintenance(
	doc: BlueprintDoc,
	plan: ReferenceIndexMaintenance,
): void {
	const index = doc.refIndex;
	if (!index) return;
	const carriers = new Set(plan.carriers);
	if (plan.duplicated) {
		const after = doc.fieldOrder[plan.duplicated.parentUuid] ?? [];
		for (const uuid of after) {
			if (plan.duplicated.before.has(uuid)) continue;
			carriers.add(uuid);
			for (const descendant of walkFormFieldUuids(doc, uuid)) {
				carriers.add(descendant);
			}
		}
	}
	if (carriers.size === 0) return;
	const contexts = new Map<string, CarrierContext>();
	for (const carrier of carriers) {
		contexts.set(carrier, carrierContext(doc, carrier));
	}
	for (const carrier of carriers) unindexCarrier(index, carrier);
	for (const carrier of carriers) {
		registerFieldDeclarations(index, doc, carrier);
	}
	for (const carrier of carriers) {
		extractCarrierEdges(index, doc, carrier, contexts.get(carrier) ?? {});
	}
}

// ── Dev-mode parity tripwire ────────────────────────────────────────

let lastParityCheckAt = 0;

/**
 * Development-only batch-end assertion that the incrementally
 * maintained index still deep-equals a from-scratch rebuild. The
 * load-bearing proof is the CI fuzz; this tripwire catches live-editing
 * shapes the fuzz alphabet doesn't reach. Throttled because a rebuild
 * is O(doc) and agent streams apply hundreds of batches — a once-per-
 * second sample still surfaces any real divergence within a session.
 * Reports, never throws: a divergence means lookups may be stale, not
 * that the doc is wrong.
 */
export function devAssertReferenceIndexParity(doc: BlueprintDoc): void {
	if (process.env.NODE_ENV !== "development") return;
	if (!doc.refIndex) return;
	const now = Date.now();
	if (now - lastParityCheckAt < 1000) return;
	lastParityCheckAt = now;
	const rebuilt = buildReferenceIndex(doc);
	if (!plainDeepEqual(doc.refIndex, rebuilt)) {
		console.error(
			"referenceIndex: the incrementally maintained index diverged from a from-scratch rebuild — a maintenance bug. Reference lookups (rename cascades, retirement checks, peer scans) may be stale until the next full load. Compare the two structures to find the missing/extra edges.",
			{ incremental: doc.refIndex, rebuilt },
		);
	}
}

/** Structural equality over plain JSON records (the index holds no
 *  arrays), insertion-order-insensitive — incremental maintenance and a
 *  rebuild legitimately insert keys in different orders. */
function plainDeepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	) {
		return false;
	}
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (
			!plainDeepEqual(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
			)
		) {
			return false;
		}
	}
	return true;
}
