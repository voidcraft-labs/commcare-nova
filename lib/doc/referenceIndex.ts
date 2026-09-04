/**
 * Reference-index construction, per-mutation maintenance, and queries —
 * the machinery behind `BlueprintDoc.refIndex`
 * (`lib/domain/referenceIndex.ts` owns the shape and key vocabulary).
 *
 * Every reference operation in the write path answers "who references
 * X?" / "who declares X?" through these lookups instead of walking the
 * document: the case-property rename cascade (`mutations/fields.ts`), the
 * case-type retirement planner
 * (`caseTypeRetirement.ts`), the peer-aware rename verdict
 * (`identifierVerdicts.ts`), and the unwritten-property derivation
 * (`unwrittenProperties.ts`). Edges carry (carrier uuid, slot id),
 * never character positions — a consumer that needs structure walks the
 * named slot's typed AST/template leaves, so nothing positional can go stale
 * across mutations.
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
 * Expression slots store the XPath AST (`lib/domain/xpath`) and prose slots
 * store typed templates, so extraction is a pure leaf walk — identity atoms
 * edge directly, with no parse or name resolution.
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
 * clones on duplication), every carrier for the explicit app-wide property
 * rename, and the `ctx[module]` group whose extraction read the module's
 * case-type context. A module case-type change or a cross-module form move
 * re-keys those edges.
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
	type Automation,
	assignedLocationUuids,
	automationsOf,
	type BlueprintDoc,
	casePropertyDeclKey,
	casePropertyTargetKey,
	caseTypeTargetKey,
	entityTargetKey,
	type Field,
	FORM_REFERENCE_SLOTS,
	type Form,
	fieldCaseWrite,
	fieldReferenceSlotsFor,
	isOwnerOnlyCaseSearchConfig,
	isOwnRecord,
	isXPathExpression,
	type LocationProperty,
	locationPropertiesOf,
	locationTargetKey,
	MODULE_REFERENCE_SLOTS,
	type Module,
	type OrganizationLevel,
	organizationLevelsOf,
	ownRecordValue,
	type Persona,
	type ProseTemplate,
	personasOf,
	type ReferenceIndex,
	readSlotStrings,
	readSlotValues,
	recordFromEntries,
	searchInputDefault,
	searchInputOptions,
	USER_PROPERTY_TARGET_PREFIX,
	type Uuid,
	userPropertyTargetKey,
	uuidSchema,
	type XPathExpression,
} from "@/lib/domain";
import {
	type Predicate,
	type RelationPath,
	relationDestinationCaseType,
	type Term,
	type ValueExpression,
	walkExpressionNodes,
	walkExpressionPredicateNodes,
	walkExpressionTerms,
	walkPredicateExpressionNodes,
	walkPredicateNodes,
	walkTerms,
} from "@/lib/domain/predicate";
import { findContainingForm, walkFormFieldUuids } from "./mutations/helpers";

// ── Index primitives ────────────────────────────────────────────────

function emptyReferenceIndex(): ReferenceIndex {
	return {
		in: recordFromEntries([]),
		out: recordFromEntries([]),
		decl: recordFromEntries([]),
		ctx: recordFromEntries([]),
	};
}

function isEmptyRecord(record: object): boolean {
	return Object.keys(record).length === 0;
}

type SetBucket = Record<string, Record<string, true>>;

function addToBucket(bucket: SetBucket, key: string, member: string): void {
	const members = ownRecordValue(bucket, key) ?? recordFromEntries<true>([]);
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
	const inner = ownRecordValue(bucket, key);
	if (!inner) return;
	delete inner[member];
	if (isEmptyRecord(inner)) delete bucket[key];
}

/**
 * The owning-module context a carrier's references resolve in.
 */
interface CarrierContext {
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
	const identity = uuidSchema.safeParse(carrier);
	if (!identity.success) return {};
	const mod = ownRecordValue(doc.modules, carrier);
	if (mod) {
		return {
			moduleUuid: identity.data,
			...(mod.caseType !== undefined && { moduleCaseType: mod.caseType }),
		};
	}
	let formUuid: Uuid | undefined;
	if (ownRecordValue(doc.forms, carrier)) formUuid = identity.data;
	else if (ownRecordValue(doc.fields, carrier)) {
		formUuid = findContainingForm(doc, identity.data);
	} else if (
		ownRecordValue(organizationLevelsOf(doc), carrier) ||
		ownRecordValue(locationPropertiesOf(doc), carrier) ||
		ownRecordValue(personasOf(doc), carrier) ||
		ownRecordValue(automationsOf(doc), carrier)
	) {
		return {};
	} else return {};
	if (formUuid === undefined) return {};
	const moduleUuid = resolveFormModule(doc, formUuid);
	const moduleCaseType =
		moduleUuid !== undefined
			? ownRecordValue(doc.modules, moduleUuid)?.caseType
			: undefined;
	return {
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
		if (formUuids.includes(formUuid)) {
			const parsedModuleUuid = uuidSchema.safeParse(moduleUuid);
			if (parsedModuleUuid.success) return parsedModuleUuid.data;
		}
	}
	return undefined;
}

/**
 * Drop every trace of `carrier` from the index in O(its own edges),
 * via its `out` mirror entry.
 */
function unindexCarrier(index: ReferenceIndex, carrier: string): void {
	const entry = ownRecordValue(index.out, carrier);
	if (!entry) return;
	for (const target of Object.keys(entry.edges)) {
		const byCarrier = ownRecordValue(index.in, target);
		if (!byCarrier) continue;
		delete byCarrier[carrier];
		if (isEmptyRecord(byCarrier)) delete index.in[target];
	}
	if (entry.decl !== undefined) {
		removeFromBucket(index.decl, entry.decl, carrier);
	}
	for (const declaration of entry.decls ?? []) {
		removeFromBucket(index.decl, declaration, carrier);
	}
	if (entry.ctx !== undefined) removeFromBucket(index.ctx, entry.ctx, carrier);
	delete index.out[carrier];
}

/**
 * Register a field's explicit `(caseWrite.caseType, caseWrite.property)`
 * case-property
 * contribution (`decl`). Runs for EVERY (re-)indexed field BEFORE any
 * edge extraction in the same pass.
 */
function registerFieldDeclarations(
	index: ReferenceIndex,
	doc: BlueprintDoc,
	carrier: string,
): void {
	const field = ownRecordValue(doc.fields, carrier);
	if (!field) return;
	const write = fieldCaseWrite(field);
	if (write === undefined) return;
	const entry = ownRecordValue(index.out, carrier) ?? {
		edges: recordFromEntries([]),
	};
	index.out[carrier] = entry;
	const key = casePropertyDeclKey(write.caseType, write.property);
	entry.decl = key;
	addToBucket(index.decl, key, carrier);
}

/** Register every property written by a form's case operations. The
 * destination is the operation's post-retype type, matching effective
 * property materialization and the mutation validator. */
function registerFormDeclarations(
	index: ReferenceIndex,
	doc: BlueprintDoc,
	carrier: string,
): void {
	const form = ownRecordValue(doc.forms, carrier);
	if (!form) return;
	const declarations = new Set<string>();
	for (const operation of form.caseOperations ?? []) {
		const caseType = operation.retype ?? operation.caseType;
		if (caseType.length === 0) continue;
		for (const write of operation.writes ?? []) {
			if (write.property.length === 0) continue;
			declarations.add(casePropertyDeclKey(caseType, write.property));
		}
	}
	if (declarations.size === 0) return;
	const entry = ownRecordValue(index.out, carrier) ?? {
		edges: recordFromEntries([]),
	};
	index.out[carrier] = entry;
	entry.decls = [...declarations];
	for (const declaration of declarations) {
		addToBucket(index.decl, declaration, carrier);
	}
}

// ── Edge sink ───────────────────────────────────────────────────────

interface EdgeSink {
	edge(targetKey: string, slot: string): void;
	markCtx(): void;
}

function makeSink(
	index: ReferenceIndex,
	carrier: string,
	ctx: CarrierContext,
): EdgeSink {
	const entry = () => {
		const existing = ownRecordValue(index.out, carrier) ?? {
			edges: recordFromEntries([]),
		};
		index.out[carrier] = existing;
		return existing;
	};
	return {
		edge(targetKey, slot) {
			const e = entry();
			const slots =
				ownRecordValue(e.edges, targetKey) ?? recordFromEntries<true>([]);
			slots[slot] = true;
			e.edges[targetKey] = slots;
			const byCarrier =
				ownRecordValue(index.in, targetKey) ?? recordFromEntries([]);
			index.in[targetKey] = byCarrier;
			const inSlots =
				ownRecordValue(byCarrier, carrier) ?? recordFromEntries<true>([]);
			inSlots[slot] = true;
			byCarrier[carrier] = inSlots;
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
	const mod = ownRecordValue(doc.modules, carrier);
	if (mod) {
		extractModuleEdges(makeSink(index, carrier, ctx), mod);
		return;
	}
	const form = ownRecordValue(doc.forms, carrier);
	if (form) {
		extractFormEdges(makeSink(index, carrier, ctx), form);
		return;
	}
	const field = ownRecordValue(doc.fields, carrier);
	if (field) {
		extractFieldEdges(makeSink(index, carrier, ctx), field);
		return;
	}
	const level = ownRecordValue(organizationLevelsOf(doc), carrier);
	if (level) {
		extractOrganizationLevelEdges(makeSink(index, carrier, ctx), level);
		return;
	}
	const property = ownRecordValue(locationPropertiesOf(doc), carrier);
	if (property) {
		extractLocationPropertyEdges(makeSink(index, carrier, ctx), property);
		return;
	}
	const persona = ownRecordValue(personasOf(doc), carrier);
	if (persona) {
		extractPersonaLocationEdges(makeSink(index, carrier, ctx), persona);
		return;
	}
	const automation = ownRecordValue(automationsOf(doc), carrier);
	if (automation) {
		extractAutomationEdges(makeSink(index, carrier, ctx), doc, automation);
	}
}

function automationScopeCaseType(
	doc: BlueprintDoc,
	automation: Automation,
	scope: "case" | "parent" | "host",
): string | undefined {
	if (scope === "case") return automation.caseType;
	const source = doc.caseTypes?.find(
		(type) => type.name === automation.caseType,
	);
	if (source?.parent_type === undefined) return undefined;
	if (scope === "host" && source.relationship !== "extension") {
		return undefined;
	}
	return source.parent_type;
}

function extractAutomationEdges(
	sink: EdgeSink,
	doc: BlueprintDoc,
	automation: Automation,
): void {
	sink.edge(caseTypeTargetKey(automation.caseType), "automation_case_type");
	for (const criterion of automation.criteria) {
		if (criterion.kind === "match-property") {
			const caseType = automationScopeCaseType(
				doc,
				automation,
				criterion.scope,
			);
			if (caseType !== undefined) {
				sink.edge(
					casePropertyTargetKey(caseType, criterion.property),
					"automation_criterion_property",
				);
			}
		} else if (criterion.kind === "location") {
			sink.edge(
				locationTargetKey(criterion.locationUuid),
				"automation_criterion_location",
			);
		}
	}
	if (automation.kind === "case-update") {
		for (const update of automation.updates) {
			for (const target of [
				update.target,
				...(update.value.kind === "case-property" ? [update.value.source] : []),
			]) {
				const caseType = automationScopeCaseType(doc, automation, target.scope);
				if (caseType !== undefined) {
					sink.edge(
						casePropertyTargetKey(caseType, target.property),
						"automation_update_property",
					);
				}
			}
		}
		return;
	}
	for (const recipient of automation.recipients) {
		if (recipient.kind === "location") {
			sink.edge(
				locationTargetKey(recipient.locationUuid),
				"automation_recipient_location",
			);
		} else if (
			recipient.kind === "case-property-username" ||
			recipient.kind === "case-property-user-id" ||
			recipient.kind === "case-property-email"
		) {
			sink.edge(
				casePropertyTargetKey(automation.caseType, recipient.property),
				"automation_recipient_property",
			);
		}
	}
	for (const levelUuid of automation.locationLevelUuids) {
		sink.edge(entityTargetKey(levelUuid), "automation_location_level");
	}
	for (const filter of automation.userDataFilters) {
		sink.edge(
			userPropertyTargetKey(filter.userPropertyUuid),
			"automation_user_data_filter",
		);
		for (const value of filter.values) {
			if (value.kind !== "case-property") continue;
			sink.edge(
				casePropertyTargetKey(value.caseType, value.property),
				"automation_user_data_filter_value",
			);
		}
	}
	for (const property of [
		automation.resetCaseProperty,
		automation.stopDateCaseProperty,
	]) {
		if (property !== undefined) {
			sink.edge(
				casePropertyTargetKey(automation.caseType, property),
				"automation_alert_property",
			);
		}
	}
	if (
		automation.schedule.kind === "timed" &&
		automation.schedule.start.kind === "case-property"
	) {
		sink.edge(
			casePropertyTargetKey(
				automation.caseType,
				automation.schedule.start.property,
			),
			"automation_schedule_property",
		);
	}
	const schedule = automation.schedule;
	if (schedule.kind === "timed") {
		for (const event of schedule.events) {
			if (event.timing.kind !== "case-property-time") continue;
			sink.edge(
				casePropertyTargetKey(automation.caseType, event.timing.property),
				"automation_schedule_property",
			);
		}
	}
	for (const event of schedule.events) {
		if (
			event.content.kind === "sms-survey" ||
			event.content.kind === "ivr" ||
			event.content.kind === "connect-survey"
		) {
			sink.edge(
				entityTargetKey(event.content.formUuid),
				"automation_content_form",
			);
		}
		const templates =
			event.content.kind === "email"
				? [
						event.content.subject,
						event.content.body.kind === "plain-text"
							? event.content.body.message
							: event.content.body.html,
					]
				: event.content.kind === "sms" ||
						event.content.kind === "sms-callback" ||
						event.content.kind === "connect-message"
					? [event.content.message]
					: [];
		for (const template of templates) {
			for (const part of template.parts) {
				if (part.kind !== "case-property") continue;
				sink.edge(
					casePropertyTargetKey(part.caseType, part.property),
					"automation_template_property",
				);
			}
		}
	}
}

function extractOrganizationLevelEdges(
	sink: EdgeSink,
	level: OrganizationLevel,
): void {
	const targets = new Set<string>();
	if (level.parentLevelUuid !== undefined) targets.add(level.parentLevelUuid);
	if (level.caseFlow.workers === "assigned") {
		const descendants = level.caseFlow.descendantCases;
		if (descendants.kind === "down-to") targets.add(descendants.levelUuid);
	}
	const book = level.addressBook;
	if (book.reach === "own-branch-limited") {
		for (const uuid of book.levelUuids) targets.add(uuid);
	} else if (book.reach === "shared-branch") {
		targets.add(book.fromLevelUuid);
	}
	if (book.reach !== "own-branch-limited") {
		if (book.downToLevelUuid !== undefined) targets.add(book.downToLevelUuid);
	}
	if (
		(book.reach === "own-branch" || book.reach === "own-branch-limited") &&
		book.alsoIncludeTopDownToLevelUuid !== undefined
	) {
		targets.add(book.alsoIncludeTopDownToLevelUuid);
	}
	for (const target of targets) {
		sink.edge(entityTargetKey(target), "organization_level_setting");
	}
}

function extractLocationPropertyEdges(
	sink: EdgeSink,
	property: LocationProperty,
): void {
	for (const levelUuid of property.levelUuids ?? []) {
		sink.edge(entityTargetKey(levelUuid), "location_property_level");
	}
}

function extractPersonaLocationEdges(sink: EdgeSink, persona: Persona): void {
	for (const locationUuid of assignedLocationUuids(persona.locations)) {
		sink.edge(locationTargetKey(locationUuid), "persona_location");
	}
}

function extractFieldEdges(sink: EdgeSink, field: Field): void {
	const repeatMode = field.kind === "repeat" ? field.repeat_mode : undefined;
	for (const slot of fieldReferenceSlotsFor(field.kind, repeatMode)) {
		switch (slot.kind) {
			case "xpath-ast":
				for (const value of readSlotValues(field, slot.path)) {
					if (isXPathExpression(value.value)) {
						extractAstRefs(sink, value.value, slot.slot);
					}
				}
				break;
			case "prose":
				for (const value of readSlotValues(field, slot.path)) {
					extractProseRefs(sink, value.value as ProseTemplate, slot.slot);
				}
				break;
			case "case-type-ref":
				// `caseWrite.caseType` — names the case type the field writes
				// to. The matching DECLARATION entry is registered separately
				// (`registerFieldDeclarations`); the edge here is what makes
				// the field show up as a referencer of the type.
				for (const value of readSlotStrings(field, slot.path)) {
					if (value.text.length > 0) {
						sink.edge(caseTypeTargetKey(value.text), slot.slot);
					}
				}
				break;
			case "lookup-carrier":
				if (
					(field.kind === "single_select" || field.kind === "multi_select") &&
					field.optionsSource.kind === "lookup" &&
					field.optionsSource.filter !== undefined
				) {
					predicateEdges(sink, slot.slot, field.optionsSource.filter);
				}
				break;
			case "case-property-ref": {
				const write = fieldCaseWrite(field);
				if (write !== undefined) {
					sink.edge(
						casePropertyTargetKey(write.caseType, write.property),
						slot.slot,
					);
				}
				break;
			}
			case "predicate-ast":
			case "entity-uuid":
				break;
			default: {
				const _exhaustive: never = slot.kind;
				break;
			}
		}
	}
}

function extractFormEdges(sink: EdgeSink, form: Form): void {
	for (const slot of FORM_REFERENCE_SLOTS) {
		switch (slot.slot) {
			case "form_display_condition":
				if (form.displayCondition) {
					predicateEdges(sink, slot.slot, form.displayCondition);
				}
				break;
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
						extractAstRefs(sink, value.value, slot.slot);
					}
				}
				break;
			case "case_operation_case_type":
			case "case_operation_retype":
			case "case_operation_link_target_type":
				for (const value of readSlotStrings(form, slot.path)) {
					if (value.text.length > 0) {
						sink.edge(caseTypeTargetKey(value.text), slot.slot);
					}
				}
				break;
			case "case_operation_target_op":
			case "case_operation_target_id_from":
			case "case_operation_repeat":
			case "case_operation_link_target_op":
			case "case_operation_link_target_id_from":
				for (const value of readSlotStrings(form, slot.path)) {
					if (value.text.length > 0) {
						sink.edge(entityTargetKey(value.text), slot.slot);
					}
				}
				break;
			case "case_operation_target_expression":
			case "case_operation_name":
			case "case_operation_owner":
			case "case_operation_rename":
			case "case_operation_write_value":
			case "case_operation_link_target_expression":
				for (const value of readSlotValues(form, slot.path)) {
					expressionEdges(sink, slot.slot, value.value as ValueExpression);
				}
				break;
			case "case_operation_condition":
			case "case_operation_write_condition":
				for (const value of readSlotValues(form, slot.path)) {
					predicateEdges(sink, slot.slot, value.value as Predicate);
				}
				break;
			case "case_operation_write_property":
				for (const value of readSlotStrings(form, slot.path)) {
					const operation = form.caseOperations?.[value.indices[0] ?? -1];
					const caseType = operation?.retype ?? operation?.caseType;
					if (caseType && value.text.length > 0) {
						sink.edge(casePropertyTargetKey(caseType, value.text), slot.slot);
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
			case "module_parent":
				if (mod.parentModuleUuid !== undefined) {
					sink.edge(entityTargetKey(mod.parentModuleUuid), slot.slot);
				}
				break;
			case "module_display_condition":
				if (mod.displayCondition) {
					predicateEdges(sink, slot.slot, mod.displayCondition);
				}
				break;
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
					const defaultValue = searchInputDefault(input);
					if (defaultValue !== undefined) {
						expressionEdges(sink, slot.slot, defaultValue);
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
			case "search_input_options":
				// The table and column identities belong to the lookup-reference
				// registry (`lookupReferences.ts`); only the row filter can name
				// form or case entities.
				for (const input of list?.searchInputs ?? []) {
					const options = searchInputOptions(input);
					if (options?.filter !== undefined) {
						predicateEdges(sink, slot.slot, options.filter);
					}
				}
				break;
			case "search_input_required_when":
				for (const input of list?.searchInputs ?? []) {
					if (input.kind !== "hidden" && input.required?.when !== undefined) {
						predicateEdges(sink, slot.slot, input.required.when);
					}
				}
				break;
			case "search_input_validation_rule":
				for (const input of list?.searchInputs ?? []) {
					if (input.kind !== "hidden" && input.validation !== undefined) {
						predicateEdges(sink, slot.slot, input.validation.rule);
					}
				}
				break;
			case "search_input_hidden_value":
				for (const input of list?.searchInputs ?? []) {
					if (input.kind === "hidden") {
						expressionEdges(sink, slot.slot, input.value);
					}
				}
				break;
			case "search_button_display_condition":
				if (
					search !== undefined &&
					!isOwnerOnlyCaseSearchConfig(search) &&
					search.searchButtonDisplayCondition
				) {
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
	if (term.kind === "field") {
		sink.edge(entityTargetKey(term.uuid), slot);
		return;
	}
	if (term.kind === "session-user-property") {
		sink.edge(userPropertyTargetKey(term.userPropertyUuid), slot);
		return;
	}
	if (term.kind === "fixed-location") {
		sink.edge(locationTargetKey(term.locationUuid), slot);
		return;
	}
	if (term.kind === "owner-location-at-level") {
		sink.edge(entityTargetKey(term.levelUuid), slot);
		sink.edge(caseTypeTargetKey(term.ownerCaseType), slot);
		return;
	}
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
		walkPredicateNodes(predicate, (node) => {
			if (node.kind === "exists" || node.kind === "missing") {
				relationHintEdges(sink, slot, node.via);
			}
		});
		walkPredicateExpressionNodes(predicate, (expression) => {
			if (expression.kind === "id-of") {
				sink.edge(entityTargetKey(expression.opUuid), slot);
			}
			if (expression.kind === "count") {
				relationHintEdges(sink, slot, expression.via);
			}
		});
	} catch (err) {
		console.warn(
			`referenceIndex: couldn't walk the "${slot}" predicate for references, the stored shape has a node the walker doesn't recognize, so its references are not indexed.`,
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
		walkExpressionNodes(expression, (node) => {
			if (node.kind === "id-of") {
				sink.edge(entityTargetKey(node.opUuid), slot);
			}
			if (node.kind === "count") relationHintEdges(sink, slot, node.via);
		});
		walkExpressionPredicateNodes(expression, (node) => {
			if (node.kind === "exists" || node.kind === "missing") {
				relationHintEdges(sink, slot, node.via);
			}
		});
	} catch (err) {
		console.warn(
			`referenceIndex: couldn't walk the "${slot}" expression for references, the stored shape has a node the walker doesn't recognize, so its references are not indexed.`,
			err,
		);
	}
}

// ── Expression-AST leaf extraction ──────────────────────────────────

/**
 * Edges for one stored expression AST — a pure leaf walk, no parse:
 *
 *   - `field-ref` / `path-ref` carry the target's UUID directly.
 *   - `case-ref` names its type (`t:`) and reads its property (`c:`).
 */
function extractAstRefs(
	sink: EdgeSink,
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
			case "user-property-ref":
				sink.edge(userPropertyTargetKey(part.userPropertyUuid), slot);
				break;
			case "search-answer-ref":
				// The Search prompt is an entity of its module's case list;
				// `referencingCarrierUuids(inputUuid)` is what lets the removal
				// planner name the form fields that carry its answer.
				sink.edge(entityTargetKey(part.searchInputUuid), slot);
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
 * Edges for one canonical prose template. Text parts are always inert,
 * including hashtag-looking text; only typed parts are references.
 */
function extractProseRefs(
	sink: EdgeSink,
	template: ProseTemplate,
	slot: string,
): void {
	if (!template || !Array.isArray(template.parts)) return;
	for (const part of template.parts) {
		switch (part.kind) {
			case "text":
			case "user-ref":
				break;
			case "field-ref":
				sink.edge(entityTargetKey(part.uuid), slot);
				break;
			case "case-ref":
				sink.edge(caseTypeTargetKey(part.caseType), slot);
				sink.edge(casePropertyTargetKey(part.caseType, part.property), slot);
				break;
			case "user-property-ref":
				sink.edge(userPropertyTargetKey(part.userPropertyUuid), slot);
				break;
			default: {
				const _exhaustive: never = part;
				break;
			}
		}
	}
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
		...Object.keys(organizationLevelsOf(doc)),
		...Object.keys(locationPropertiesOf(doc)),
		...Object.keys(personasOf(doc)),
		...Object.keys(automationsOf(doc)),
	];
	for (const carrier of carriers) {
		contexts.set(carrier, carrierContext(doc, carrier));
	}
	for (const carrier of Object.keys(doc.fields)) {
		registerFieldDeclarations(index, doc, carrier);
	}
	for (const carrier of Object.keys(doc.forms)) {
		registerFormDeclarations(index, doc, carrier);
	}
	for (const carrier of carriers) {
		extractCarrierEdges(index, doc, carrier, contexts.get(carrier) ?? {});
	}
	return index;
}

function nestedSetBucketIsOwn(bucket: SetBucket): boolean {
	if (!isOwnRecord(bucket)) return false;
	return Object.values(bucket).every((members) => isOwnRecord(members));
}

function referenceIndexRootsAreOwn(index: ReferenceIndex): boolean {
	return (
		isOwnRecord(index.in) &&
		isOwnRecord(index.out) &&
		isOwnRecord(index.decl) &&
		isOwnRecord(index.ctx)
	);
}

/**
 * A reference index can survive HMR or be supplied by a test fixture even
 * though it is never persisted. Reject an old ordinary-object shape at the
 * accessor boundary so incremental writes never consult inherited carriers.
 */
function referenceIndexIsOwn(index: ReferenceIndex): boolean {
	if (
		!referenceIndexRootsAreOwn(index) ||
		!nestedSetBucketIsOwn(index.decl) ||
		!nestedSetBucketIsOwn(index.ctx)
	) {
		return false;
	}
	for (const byCarrier of Object.values(index.in)) {
		if (!isOwnRecord(byCarrier)) return false;
		for (const slots of Object.values(byCarrier)) {
			if (!isOwnRecord(slots)) return false;
		}
	}
	for (const entry of Object.values(index.out)) {
		if (!isOwnRecord(entry.edges)) return false;
		for (const slots of Object.values(entry.edges)) {
			if (!isOwnRecord(slots)) return false;
		}
	}
	return true;
}

/** Seed `doc.refIndex` when absent (every apply entry point and
 *  hydration site calls this); returns the live index. */
export function ensureReferenceIndex(doc: BlueprintDoc): ReferenceIndex {
	if (doc.refIndex === undefined || !referenceIndexIsOwn(doc.refIndex)) {
		doc.refIndex = buildReferenceIndex(doc);
	}
	return doc.refIndex;
}

/**
 * The index for a doc a caller cannot (or must not) mutate. Falls back
 * to a fresh build when the slot is absent — same answers, one-off
 * O(doc) cost — so reference queries stay total over docs that never
 * passed a hydration site (read-only widenings, test fixtures).
 */
function getReferenceIndex(doc: BlueprintDoc): ReferenceIndex {
	// Queries enumerate nested buckets through Object.keys/entries and perform
	// own reads at their roots, so the five root prototypes are the constant-time
	// safety gate. `ensureReferenceIndex` performs the recursive validation once
	// before any incremental mutation is allowed.
	return doc.refIndex !== undefined && referenceIndexRootsAreOwn(doc.refIndex)
		? doc.refIndex
		: buildReferenceIndex(doc);
}

// ── Queries ─────────────────────────────────────────────────────────

/** Carrier uuids holding ≥1 edge to `targetKey` ("who references X?"). */
export function referencingCarrierUuids(
	doc: BlueprintDoc,
	targetKey: string,
): string[] {
	return Object.keys(
		ownRecordValue(getReferenceIndex(doc).in, targetKey) ?? {},
	);
}

/**
 * The slot-level flavor of `referencingCarrierUuids`: carrier uuid →
 * the registry slot ids its edges to `targetKey` live on. For
 * consumers that dispatch on WHERE a reference sits, not just who
 * holds it — the unwritten-property derivation
 * (`unwrittenProperties.ts`) reads a property's read edges through
 * this to phrase each one by its slot.
 */
export function referencingSlotsOf(
	doc: BlueprintDoc,
	targetKey: string,
): ReadonlyMap<string, readonly string[]> {
	const byCarrier = ownRecordValue(getReferenceIndex(doc).in, targetKey) ?? {};
	const result = new Map<string, readonly string[]>();
	for (const [carrier, slots] of Object.entries(byCarrier)) {
		result.set(carrier, Object.keys(slots));
	}
	return result;
}

/** Every custom worker-information UUID referenced by any indexed AST slot. */
export function referencedUserPropertyUuids(doc: BlueprintDoc): string[] {
	return Object.keys(getReferenceIndex(doc).in)
		.filter((key) => key.startsWith(USER_PROPERTY_TARGET_PREFIX))
		.map((key) => key.slice(USER_PROPERTY_TARGET_PREFIX.length));
}

/** Carrier uuids declaring the `(caseType, property)` pair — fields and
 *  forms with operation writers. Consumers that need field peers must narrow
 *  through `doc.fields`; existence checks intentionally count both kinds. */
export function declarersOf(
	doc: BlueprintDoc,
	caseType: string,
	property: string,
): string[] {
	return Object.keys(
		ownRecordValue(
			getReferenceIndex(doc).decl,
			casePropertyDeclKey(caseType, property),
		) ?? {},
	);
}

// ── Per-mutation maintenance ────────────────────────────────────────

/**
 * The carriers a mutation can change, captured BEFORE the reducer runs —
 * removed subtrees and re-keyed-edge carriers are only knowable from pre-state.
 *
 * Every carrier is nameable here because every mutation names its own targets:
 * a duplicate arrives as ordinary `addField`s carrying the clone uuids, so
 * there is nothing left that the reducer discovers on the way past.
 */
export interface ReferenceIndexMaintenance {
	carriers: Set<string>;
}

const NO_MAINTENANCE: ReferenceIndexMaintenance = { carriers: new Set() };

export function planReferenceIndexMaintenance(
	doc: BlueprintDoc,
	mut: Mutation,
): ReferenceIndexMaintenance {
	const index = doc.refIndex;
	if (!index) return NO_MAINTENANCE;
	const carriers = new Set<string>();
	const addFieldSubtree = (uuid: Uuid): void => {
		carriers.add(uuid);
		for (const descendant of walkFormFieldUuids(doc, uuid)) {
			carriers.add(descendant);
		}
	};
	switch (mut.kind) {
		// App-level slots are never indexed (the case-type catalog is
		// root-level data the planner reads directly), so the granular catalog
		// kinds are no-ops here.
		case "setAppName":
		case "setConnectType":
		case "setAppLogo":
		case "relabelSourceLanguage":
		case "addLanguage":
		case "removeLanguage":
		case "setDefaultLanguage":
		case "setTranslation":
		case "reviewTranslation":
		case "declareCaseType":
		case "retireCaseType":
		case "addCaseProperty":
		case "setCaseProperty":
		case "removeCaseProperty":
			break;
		case "setCaseTypeMeta":
			// Parent/host automation edges resolve through the source case type's
			// current ancestry metadata. Re-extract only automations authored on
			// that source so incremental maintenance stays identical to a rebuild.
			for (const automation of Object.values(automationsOf(doc))) {
				if (automation.caseType === mut.caseType) carriers.add(automation.uuid);
			}
			break;
		case "addAutomation":
			carriers.add(mut.automation.uuid);
			break;
		case "updateAutomation":
		case "removeAutomation":
		case "moveAutomation":
		case "setAutomationSchedule":
		case "updateAutomationSchedule":
			carriers.add(mut.uuid);
			break;
		case "editAutomationItem":
			carriers.add(mut.automationUuid);
			break;
		case "renameCaseProperties":
			for (const uuid of Object.keys(doc.modules)) carriers.add(uuid);
			for (const uuid of Object.keys(doc.forms)) carriers.add(uuid);
			for (const uuid of Object.keys(doc.fields)) carriers.add(uuid);
			for (const uuid of Object.keys(automationsOf(doc))) carriers.add(uuid);
			break;
		case "addModule":
			carriers.add(mut.module.uuid);
			break;
		case "removeModule":
			carriers.add(mut.uuid);
			for (const formUuid of ownRecordValue(doc.formOrder, mut.uuid) ?? []) {
				carriers.add(formUuid);
				for (const fieldUuid of walkFormFieldUuids(doc, formUuid)) {
					carriers.add(fieldUuid);
				}
			}
			break;
		case "moveModule":
			// Reparenting changes the module_parent entity edge.
			carriers.add(mut.uuid);
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
			// module's forms and module-owned contextual property slots.
			if ("caseType" in mut.patch) {
				const previous = ownRecordValue(doc.modules, mut.uuid)?.caseType;
				if (mut.patch.caseType !== previous) {
					for (const carrier of Object.keys(
						ownRecordValue(index.ctx, mut.uuid) ?? {},
					)) {
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
				for (const carrier of Object.keys(
					ownRecordValue(index.ctx, oldModule) ?? {},
				)) {
					if (subtree.has(carrier)) carriers.add(carrier);
				}
				// The reducer rewrites every inbound form target's moduleUuid
				// to the new module, so each source form's `form_link_target`
				// edges re-extract.
				for (const [sourceUuid, source] of Object.entries(doc.forms)) {
					if (
						source.formLinks?.some(
							(link) =>
								link.target.type === "form" &&
								link.target.formUuid === mut.uuid,
						)
					) {
						carriers.add(sourceUuid);
					}
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
		// After-submit links are form-owned; the form carrier re-extracts
		// its link condition / target / datum edges.
		case "addFormLink":
		case "updateFormLink":
		case "removeFormLink":
		case "moveFormLink":
			carriers.add(mut.formUuid);
			break;
		case "addField":
			carriers.add(mut.field.uuid);
			break;
		case "removeField":
			addFieldSubtree(mut.uuid);
			break;
		case "moveField":
			// Parent/path changes re-project UUID references at read time. The
			// carrier is cheap to re-extract and its id/caseWrite stay unchanged.
			carriers.add(mut.uuid);
			break;
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
			break;
		}
		// User properties and user types register NO edges. The
		// index carries only structure a query consumes, and the two questions
		// these collections raise — which value bags name a property, which
		// personas name a user type — are answered by scanning collections
		// bounded at tens of entries, not the whole doc. A bucket maintained on
		// every mutation to save that scan would be pure cost.
		case "addUserProperty":
		case "updateUserProperty":
		case "removeUserProperty":
		case "addUserType":
		case "updateUserType":
		case "removeUserType":
			break;
		case "addPersona":
			carriers.add(mut.persona.uuid);
			break;
		case "updatePersona":
		case "removePersona":
		case "updateOrganizationLevel":
		case "removeOrganizationLevel":
		case "updateLocationProperty":
		case "removeLocationProperty":
			carriers.add(mut.uuid);
			break;
		case "addOrganizationLevel":
			carriers.add(mut.level.uuid);
			break;
		case "addLocationProperty":
			carriers.add(mut.property.uuid);
			break;
		default: {
			const _exhaustive: never = mut;
			break;
		}
	}
	return { carriers };
}

/** The parent (form or container) whose order lists `uuid`. */
function _findParentOf(doc: BlueprintDoc, uuid: Uuid): string | undefined {
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
	if (carriers.size === 0) return;
	const contexts = new Map<string, CarrierContext>();
	for (const carrier of carriers) {
		contexts.set(carrier, carrierContext(doc, carrier));
	}
	for (const carrier of carriers) unindexCarrier(index, carrier);
	for (const carrier of carriers) {
		registerFieldDeclarations(index, doc, carrier);
		registerFormDeclarations(index, doc, carrier);
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
			"referenceIndex: the incrementally maintained index diverged from a from-scratch rebuild, a maintenance bug. Reference lookups (rename cascades, retirement checks, peer scans) may be stale until the next full load. Compare the two structures to find the missing/extra edges.",
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
