/**
 * Property-centric kind conversion — the plan every conversion surface
 * consults for a case-bound field.
 *
 * A case property has ONE type, derived from its writers (declared
 * `data_type` winning when present), and the commit gate holds that
 * line: `FIELD_KIND_WRITERS_DISAGREE` rejects two typed writers of
 * different kinds, `FIELD_KIND_PROPERTY_TYPE_MISMATCH` rejects a typed
 * writer that contradicts a declared type. So a kind conversion that
 * changes the property's data type can never land one field at a time —
 * the first converted writer disagrees with its unconverted peers, and
 * a declared type can't be corrected by any field edit. The subject of
 * such a conversion is the PROPERTY, and the plan makes that literal:
 *
 *   - The cascade escorts EVERY data-type flip through the gate: every
 *     peer writer whose kind derives the same data type converts in
 *     the same gated batch, and a stale declared `data_type` is
 *     re-declared to the target type via `setCaseProperty` (the
 *     catalog entry describes the property; when the property's
 *     writers change type, the description follows), carrying a
 *     converted select's options onto the declaration as
 *     `{value, label}` pairs. Stored rows are the case store's
 *     business — `applySchemaChange` reshapes string↔array flips
 *     totally and casts every other transition per row, parking what
 *     cannot carry — so no flip is gated on row data here.
 *   - A same-type peer whose kind CANNOT convert to the target (a
 *     barcode or secret writer on a text property being made a select)
 *     BLOCKS the plan with the peer named — the batch would otherwise
 *     bounce off the gate with a disagreement message that misreads a
 *     healthy property as broken. The expressible fix is to convert
 *     that peer to text first, then convert the property.
 *   - A case-operation writer also blocks a data-type flip. Its value is an
 *     authored expression, not a field kind the cascade can mechanically
 *     convert; the author must revise/remove the operation explicitly.
 *   - A flip whose per-row cast can fail (`castCanFail` — time↔date,
 *     time→datetime, anything→int, …) additionally carries a
 *     `dataLossRisk` verdict on the plan. The plan itself never
 *     blocks on it: the CONSUMERS render consent (the builder's
 *     impact dialog, the SA's needs-confirmation result) before
 *     dispatching, and the committed mutations carry no consent —
 *     replay and undo re-run the same migration unconditionally.
 *   - A conversion to `hidden` converts ONLY the addressed field: a
 *     Hidden Value's type comes from its value, not its kind
 *     (`caseDataTypeForFieldKind` returns undefined), so no peer has a
 *     kind to follow. When it was the property's LAST kind-typed writer
 *     on an undeclared entry, the plan PINS the entry's `data_type` to
 *     the source kind's type: the converted Hidden Value has no value
 *     yet and holds no type opinion, so without the pin a later value
 *     (a `today()` calculation, say) could retype the property under
 *     rows whose values are the old type.
 *
 * Same-batch cascade, computed at the batch-building layer, never a
 * reducer side effect — the `caseTypeRetirement` pattern, and for the
 * same reasons: historical replay reduces old batches to the same docs,
 * and concurrent edits to other entities merge instead of clobbering.
 * Consumed by the SA/MCP `editField` tool and the builder's
 * convert-type gesture (`useBlueprintMutations.convertField`), so the
 * editors cannot drift on what a conversion means.
 */

import { produce } from "immer";
import {
	asUuid,
	type CaseProperty,
	type CasePropertyDataType,
	caseDataTypeForFieldKind,
	castCanFail,
	convertNeedsOptionSeed,
	entityTargetKey,
	type Field,
	type FieldKind,
	FORM_REFERENCE_SLOTS,
	fieldCaseWrite,
	fieldReferenceSlotsFor,
	getConvertibleTypes,
	MODULE_REFERENCE_SLOTS,
	rewriteSlotValues,
	type SelectOptionsSource,
} from "@/lib/domain";
import { mapExpressionAst } from "@/lib/domain/expression/mapAst";
import { isExpression } from "@/lib/domain/expression/types";
import { caseOperationChangesForUpdate } from "./caseOperationMutations";
import { diffModuleConfigMutations } from "./diffDocsToMutations";
import { applyMutations } from "./mutations";
import { declarersOf, referencingCarrierUuids } from "./referenceIndex";
import type { BlueprintDoc, Mutation, Uuid } from "./types";

/** A peer writer field the plan converts alongside the addressed one. */
export interface KindConversionPeer {
	readonly uuid: Uuid;
	readonly id: string;
}

export interface KindConversionPlan {
	readonly ok: true;
	/** The whole conversion as one batch: the addressed field's convert,
	 *  every carried peer's convert, then the declaration update when one
	 *  is needed. */
	readonly mutations: Mutation[];
	/** Peer writers converted alongside the addressed field (excludes
	 *  it) — consumers name these in their success message. */
	readonly peers: readonly KindConversionPeer[];
	/** The data type the plan declared (or pinned) on the property's
	 *  catalog entry, when it did — the target type on a data-type
	 *  flip, the SOURCE type on a hidden pin. Consumers word their
	 *  message from this, never from `toKind`. */
	readonly redeclaredTo?: CasePropertyDataType;
	/** Present when the flip's per-row cast can fail (`castCanFail`):
	 *  a stored value the cast cannot carry parks and HOLDS its case
	 *  out of the app until review. Consumers gate consent on it —
	 *  count the actual impact and ask before dispatching — while the
	 *  plan's mutations stay consent-free (replay purity). */
	readonly dataLossRisk?: {
		readonly caseType: string;
		readonly property: string;
		readonly fromType: CasePropertyDataType;
		readonly toType: CasePropertyDataType;
	};
}

/** A writer the field-only cascade cannot carry to the target: either a
 * same-type field whose kind cannot convert, or a case-operation expression
 * that must be revised explicitly. */
export interface KindConversionBlocked {
	readonly ok: false;
	readonly blocker:
		| {
				readonly carrier: "field";
				readonly uuid: Uuid;
				readonly id: string;
				readonly kind: FieldKind;
		  }
		| {
				readonly carrier: "case-operation";
				readonly uuid: Uuid;
				readonly id: string;
		  };
}

export type KindConversionPlanResult =
	| KindConversionPlan
	| KindConversionBlocked;

/**
 * Build the conversion batch for `field` → `toKind`.
 *
 * `field` is the shape the CALL leaves in place for planning purposes — a
 * caller whose same call retargets or clears `caseWrite` must pass the field
 * with that override applied, or the plan cascades a binding the field is
 * about to leave.
 *
 * `optionsSource` supplies the complete source for a converted field whose
 * source kind has none (`convertNeedsOptionSeed`). The authoring boundary has
 * already established every nested identity.
 */
export function planKindConversion(args: {
	doc: BlueprintDoc;
	field: Field;
	toKind: FieldKind;
	optionsSource?: SelectOptionsSource;
}): KindConversionPlanResult {
	const { doc, field, toKind, optionsSource } = args;

	const sourceFor = (target: Field): SelectOptionsSource | undefined => {
		if (optionsSource === undefined) return undefined;
		if (target.uuid === field.uuid || optionsSource.kind !== "inline") {
			return structuredClone(optionsSource);
		}
		// A property-wide cascade may convert several peer fields. Inline
		// options are authored sub-entities, so each owning field gets distinct
		// final identities while retaining the authored values and labels.
		return {
			kind: "inline",
			options: optionsSource.options.map((option) => ({
				...structuredClone(option),
				uuid: asUuid(crypto.randomUUID()),
			})),
		};
	};

	const convertMutation = (target: Field): Mutation => {
		const source = convertNeedsOptionSeed(target, toKind)
			? sourceFor(target)
			: undefined;
		return {
			kind: "convertField",
			uuid: target.uuid,
			toKind,
			...(source !== undefined && { optionsSource: source }),
		};
	};

	const addressedConvert = convertMutation(field);

	const write = fieldCaseWrite(field);
	if (write === undefined) {
		// Not case-bound — a plain single-field conversion.
		return { ok: true, mutations: [addressedConvert], peers: [] };
	}
	const { caseType, property } = write;

	const fromType = caseDataTypeForFieldKind(field.kind);
	const toType = caseDataTypeForFieldKind(toKind);
	const record = doc.caseTypes?.find((ct) => ct.name === caseType);
	const entry = record?.properties.find((p) => p.name === property);

	// Peer writers of the same (caseType, property) — via the reference
	// index, never a doc walk. The addressed field itself is excluded.
	const declarerUuids = declarersOf(doc, caseType, property).filter(
		(uuid) => uuid !== field.uuid,
	);
	const declarers = declarerUuids
		.map((uuid) => doc.fields[asUuid(uuid)])
		.filter((f): f is Field => f !== undefined);
	const operationBlocker = declarerUuids
		.map((uuid) => doc.forms[asUuid(uuid)])
		.filter((form) => form !== undefined)
		.flatMap((form) => form.caseOperations ?? [])
		.find(
			(operation) =>
				(operation.retype ?? operation.caseType) === caseType &&
				(operation.writes ?? []).some(
					(operationWrite) => operationWrite.property === property,
				),
		);

	const mutations: Mutation[] = [addressedConvert];
	const peers: KindConversionPeer[] = [];
	let redeclaredTo: CasePropertyDataType | undefined;

	const isTypeFlip =
		fromType !== undefined && toType !== undefined && toType !== fromType;

	if (isTypeFlip) {
		// Operation expressions are first-class writers, but unlike fields they
		// have no mechanical "convert kind" mutation. A valid doc's operation
		// writer agrees with the source type today, so the field flip must stop
		// and ask the author to revise/remove that expression explicitly.
		if (operationBlocker !== undefined) {
			return {
				ok: false,
				blocker: {
					carrier: "case-operation",
					uuid: operationBlocker.uuid,
					id: operationBlocker.id,
				},
			};
		}
		// Carry every peer writer of the property's CURRENT type across —
		// selection is by derived data type, not kind identity, so a
		// barcode/secret writer on a text property counts (it agrees
		// today and would disagree after). A peer already deriving the
		// TARGET type needs nothing.
		for (const peer of declarers) {
			if (caseDataTypeForFieldKind(peer.kind) !== fromType) continue;
			if (!getConvertibleTypes(peer.kind).includes(toKind)) {
				return {
					ok: false,
					blocker: {
						carrier: "field",
						uuid: peer.uuid,
						id: peer.id,
						kind: peer.kind,
					},
				};
			}
			mutations.push(convertMutation(peer));
			peers.push({ uuid: peer.uuid, id: peer.id });
		}
		// A stale declared type is re-declared to match the new writers.
		if (entry?.data_type !== undefined && entry.data_type !== toType) {
			mutations.push(
				redeclareMutation(
					caseType,
					entry,
					toType,
					declarationOptions(field, toKind, addressedConvert),
				),
			);
			redeclaredTo = toType;
		}
	} else if (toKind === "hidden" && entry !== undefined) {
		// A Hidden Value has no kind type, so no peer converts. When the
		// addressed field is the property's LAST kind-typed writer and the
		// entry is undeclared, pin the entry to the source kind's type: the
		// new Hidden Value holds no opinion yet, so later inference could
		// otherwise retype the property under its existing rows. Only
		// kind-typed declarers count here on purpose. A Hidden Value or
		// case operation with its own opinion either agrees with the pin
		// or is refused by the commit gate's writer agreement.
		const anotherTypedWriterRemains = declarers.some(
			(f) => caseDataTypeForFieldKind(f.kind) !== undefined,
		);
		if (
			entry.data_type === undefined &&
			fromType !== undefined &&
			!anotherTypedWriterRemains
		) {
			mutations.push(redeclareMutation(caseType, entry, fromType, undefined));
			redeclaredTo = fromType;
		}
	}

	// The consent verdict — pure, from the cast matrix. `castCanFail`
	// answers false for a same-type conversion (text → barcode) and a
	// hidden target never derives a type, so only genuine data-type
	// flips can carry risk.
	const dataLossRisk =
		fromType !== undefined &&
		toType !== undefined &&
		castCanFail(fromType, toType)
			? { caseType, property, fromType, toType }
			: undefined;

	return {
		ok: true,
		mutations,
		peers,
		...(redeclaredTo !== undefined && { redeclaredTo }),
		...(dataLossRisk !== undefined && { dataLossRisk }),
	};
}

/** The `setCaseProperty` replace carrying the entry forward with its new
 *  `data_type` (and, for select targets, the option pairs). */
function redeclareMutation(
	caseType: string,
	entry: CaseProperty,
	dataType: NonNullable<CaseProperty["data_type"]>,
	options: CaseProperty["options"],
): Mutation {
	const { options: _prior, data_type: _staleType, ...kept } = entry;
	return {
		kind: "setCaseProperty",
		caseType,
		property: {
			...kept,
			data_type: dataType,
			...(options !== undefined && { options }),
		},
	};
}

/** The declaration's option pairs for a select target — the addressed
 *  field's converted options (the seed already minted onto its
 *  `convertField` mutation, or the existing list where the source
 *  carries one), stripped to the catalog's `{value, label}` shape. A
 *  non-select target declares none. */
function declarationOptions(
	field: Field,
	toKind: FieldKind,
	addressedConvert: Mutation,
): CaseProperty["options"] {
	if (toKind !== "single_select" && toKind !== "multi_select") {
		return undefined;
	}
	const source =
		addressedConvert.kind === "convertField" &&
		addressedConvert.optionsSource?.kind === "inline"
			? addressedConvert.optionsSource.options
			: (field.kind === "single_select" || field.kind === "multi_select") &&
					field.optionsSource.kind === "inline"
				? field.optionsSource.options
				: undefined;
	return source?.map(({ value, label }) => ({ value, label }));
}

/** Literalize surviving choice reads when this edit removes their inline source. */
export interface ChoicePreservationPlan {
	readonly mutations: Mutation[];
	readonly preservedChoiceCount: number;
}

function inlineChoices(field: Field | undefined) {
	return field !== undefined &&
		(field.kind === "single_select" || field.kind === "multi_select") &&
		field.optionsSource.kind === "inline"
		? field.optionsSource.options
		: undefined;
}

/**
 * Run after the complete authored candidate is built. The candidate's index
 * finds surviving and newly authored readers; only the old document supplies
 * the disappearing option values. Same-call formula replacements therefore win.
 */
export function planChoicePreservation(
	before: BlueprintDoc,
	candidate: BlueprintDoc,
	changedFieldUuids: readonly Uuid[],
): ChoicePreservationPlan {
	const lostSources = new Map<Uuid, ReadonlyMap<Uuid, string>>();
	for (const uuid of changedFieldUuids) {
		const prior = inlineChoices(before.fields[uuid]);
		if (
			prior === undefined ||
			candidate.fields[uuid] === undefined ||
			inlineChoices(candidate.fields[uuid]) !== undefined
		)
			continue;
		lostSources.set(
			uuid,
			new Map(prior.map((option) => [option.uuid, option.value])),
		);
	}
	if (lostSources.size === 0) return { mutations: [], preservedChoiceCount: 0 };
	const carriers = new Set<string>();
	for (const uuid of lostSources.keys()) {
		for (const carrier of referencingCarrierUuids(
			candidate,
			entityTargetKey(uuid),
		))
			carriers.add(carrier);
	}
	let preservedChoiceCount = 0;
	const rewrite = (value: unknown): unknown => {
		if (!isExpression(value)) return value;
		return mapExpressionAst(value, {
			mapTerm(term) {
				if (term.kind !== "choice") return undefined;
				const options = lostSources.get(term.field);
				if (options === undefined) return undefined;
				const values = term.options.map((uuid) => options.get(uuid));
				// A missing identity is an admission error, never a guessed literal.
				if (values.some((value) => value === undefined)) return undefined;
				preservedChoiceCount++;
				return { kind: "literal", value: values.join(" ") };
			},
		});
	};
	const mutations: Mutation[] = [];
	for (const carrier of carriers) {
		const field = candidate.fields[carrier];
		if (field !== undefined) {
			const mapped = structuredClone(field);
			const patch: Record<string, unknown> = {};
			for (const slot of fieldReferenceSlotsFor(
				field.kind,
				field.kind === "repeat" ? field.repeat_mode : undefined,
			)) {
				if (slot.kind !== "expression" && slot.kind !== "options-source")
					continue;
				const path =
					slot.kind === "options-source" ? `${slot.path}.filter` : slot.path;
				if (rewriteSlotValues(mapped, path, rewrite) === 0) continue;
				const top = slot.path.split(".")[0]?.replace(/\[\]$/u, "");
				if (top !== undefined)
					patch[top] = (mapped as unknown as Record<string, unknown>)[top];
			}
			if (Object.keys(patch).length > 0)
				mutations.push({
					kind: "updateField",
					uuid: field.uuid,
					targetKind: field.kind,
					patch,
				} as Mutation);
			continue;
		}
		const form = candidate.forms[carrier];
		if (form !== undefined) {
			const mapped = structuredClone(form);
			const changedKeys = new Set<string>();
			for (const slot of FORM_REFERENCE_SLOTS) {
				if (
					slot.kind !== "expression" ||
					rewriteSlotValues(mapped, slot.path, rewrite) === 0
				)
					continue;
				const top = slot.path.split(".")[0]?.replace(/\[\]$/u, "");
				if (top !== undefined) changedKeys.add(top);
			}
			const patch: Extract<Mutation, { kind: "updateForm" }>["patch"] = {};
			if (changedKeys.has("displayCondition"))
				patch.displayCondition = mapped.displayCondition;
			if (changedKeys.has("connect")) patch.connect = mapped.connect;
			if (Object.keys(patch).length > 0)
				mutations.push({ kind: "updateForm", uuid: form.uuid, patch });
			if (changedKeys.has("formLinks")) {
				for (const link of mapped.formLinks ?? []) {
					const previous = form.formLinks?.find(
						(value) => value.uuid === link.uuid,
					);
					if (previous === undefined) continue;
					const linkPatch: Extract<
						Mutation,
						{ kind: "updateFormLink" }
					>["patch"] = {};
					if (
						JSON.stringify(previous.condition) !==
						JSON.stringify(link.condition)
					)
						linkPatch.condition = link.condition;
					if (JSON.stringify(previous.datums) !== JSON.stringify(link.datums))
						linkPatch.datums = link.datums;
					if (Object.keys(linkPatch).length > 0)
						mutations.push({
							kind: "updateFormLink",
							formUuid: form.uuid,
							uuid: link.uuid,
							patch: linkPatch,
						});
				}
			}
			if (changedKeys.has("caseOperations")) {
				for (const operation of mapped.caseOperations ?? []) {
					const previous = form.caseOperations?.find(
						(value) => value.uuid === operation.uuid,
					);
					if (previous !== undefined)
						mutations.push(
							...caseOperationChangesForUpdate(form.uuid, previous, operation),
						);
				}
			}
			continue;
		}
		const module = candidate.modules[carrier];
		if (module === undefined) continue;
		const mapped = structuredClone(module);
		let changed = false;
		for (const slot of MODULE_REFERENCE_SLOTS) {
			if (slot.kind !== "expression" && slot.kind !== "options-source")
				continue;
			const path =
				slot.kind === "options-source" ? `${slot.path}.filter` : slot.path;
			if (rewriteSlotValues(mapped, path, rewrite) > 0) changed = true;
		}
		if (!changed) continue;
		if (
			JSON.stringify(module.displayCondition) !==
			JSON.stringify(mapped.displayCondition)
		)
			mutations.push({
				kind: "updateModule",
				uuid: module.uuid,
				patch: { displayCondition: mapped.displayCondition },
			});
		mutations.push(...diffModuleConfigMutations(module, mapped));
	}
	return { mutations, preservedChoiceCount };
}

/** Complete field-edit convenience for single-batch surfaces. */
export function withChoicePreservation(
	before: BlueprintDoc,
	mutations: Mutation[],
): ChoicePreservationPlan {
	const changedFieldUuids = mutations.flatMap((mutation) =>
		mutation.kind === "convertField" || mutation.kind === "updateField"
			? [mutation.uuid]
			: [],
	);
	if (
		!changedFieldUuids.some(
			(uuid) => inlineChoices(before.fields[uuid]) !== undefined,
		)
	)
		return { mutations, preservedChoiceCount: 0 };
	const candidate = produce(before, (draft) => {
		applyMutations(draft, mutations);
	});
	const preservation = planChoicePreservation(
		before,
		candidate,
		changedFieldUuids,
	);
	return {
		...preservation,
		mutations: [...mutations, ...preservation.mutations],
	};
}
