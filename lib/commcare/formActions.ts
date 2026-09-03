/**
 * HQ `FormActions` + `case_references_data.load` assembly.
 *
 * These are the two pieces of CommCare wire output that translate the
 * derived case config (primary open/update/close/preload + child cases)
 * into the exact shapes the HQ import JSON expects. Every `question_path`
 * value is a `/data/...` path resolved through the doc's field tree so
 * nested groups / repeats produce the correct dotted address.
 *
 * `buildCaseReferencesLoad` is the complement: it scans every field's
 * XPath expressions for case-bound hashtag refs and maps the field's full
 * `/data/...` path to the list of references used at that path — translated
 * into the `#case/`-generation vocabulary HQ's case-metadata layer parses
 * (`hqLoadReference`), which feeds HQ's app summary / case property usage.
 */

import type {
	FormActions,
	OpenSubCaseAction,
	UpdateCaseAction,
} from "@/lib/commcare";
import {
	alwaysCondition,
	emptyFormActions,
	extractHashtags,
	hqLoadReference,
	ifCondition,
	neverCondition,
} from "@/lib/commcare";
import { caseTypeDepthMap } from "@/lib/commcare/hashtags/formContext";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseSelectionCardinality,
	caseSelectionCardinality,
	deriveCaseWriteInventory,
	type Field,
	isCaptureField,
	type Uuid,
} from "@/lib/domain";
import { assertAndProjectCaseWriteInventory } from "./caseWriteAdmission";
import {
	effectiveAssessmentUserScore,
	effectiveDeliverEntities,
} from "./connectDefaults";
import type { ResolvedConnectConfig } from "./connectSlugs";
import type { DerivedCasePropertyBinding } from "./deriveCaseConfig";
import { deriveCaseConfig } from "./deriveCaseConfig";
import { readFieldString } from "./fieldProps";
import {
	type AttachmentUrlTarget,
	captureUrlNodePath,
} from "./xform/captureUrlNode";
import { descendFormPathIntoField, FormPath } from "./xform/formPath";

/** Find one stable field identity inside a specific form tree. */
function findFieldPath(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	fieldUuid: Uuid,
	prefix: FormPath = FormPath.root(),
): FormPath | undefined {
	for (const childUuid of doc.fieldOrder[parentUuid] ?? []) {
		const field = doc.fields[childUuid];
		if (!field) continue;
		const path = prefix.child(field.id);
		if (childUuid === fieldUuid) return path;
		if (doc.fieldOrder[childUuid] !== undefined) {
			const nested = findFieldPath(
				doc,
				childUuid,
				fieldUuid,
				descendFormPathIntoField(field, path),
			);
			if (nested !== undefined) return nested;
		}
	}
	return undefined;
}

/** Resolve one stable field identity inside a specific form, or fail closed. */
function requireFieldPath(
	doc: BlueprintDoc,
	formUuid: Uuid,
	fieldUuid: Uuid,
): FormPath {
	const path = findFieldPath(doc, formUuid, fieldUuid);
	if (path !== undefined) return path;
	throw new Error(
		`Field '${fieldUuid}' is not reachable from form '${formUuid}'.`,
	);
}

/**
 * The node one ordinary case update reads, or `null` when this binding has no
 * honest wire spelling against the current target.
 *
 * An ordinary field's answer IS the case value, so the question path is the
 * field's own node. A capture's is not: the answer is a file name, and the
 * property carries an address built from it, which lives on the sibling node
 * `captureUrlNodePath` names. Routing the update at the capture node instead
 * would make HQ emit an `<attachment>` block rather than an `<update>` child.
 *
 * With no deployment target there is no origin and no project space to build
 * an address from, so a URL-mode write is dropped rather than emitted against
 * a guess. Attachment mode deliberately names the upload question because the
 * submitted file, rather than an address, is the case value.
 */
function caseUpdateQuestionPath(
	binding: DerivedCasePropertyBinding,
	field: Field,
	attachmentTarget: AttachmentUrlTarget | null,
): string | null {
	if (!isCaptureField(field)) return binding.path.toXPath();
	if (field.caseWrite?.mode === "attachment") {
		return binding.path.toXPath();
	}
	if (attachmentTarget === null) return null;
	return captureUrlNodePath(binding.path).toXPath();
}

function requireBindingField(
	doc: BlueprintDoc,
	binding: DerivedCasePropertyBinding,
): Field {
	const field = doc.fields[binding.fieldUuid];
	if (field === undefined) {
		throw new Error(
			`Case binding targets missing field '${binding.fieldUuid}'.`,
		);
	}
	return field;
}

/** Domain `case_name` projects one-way to HQ FormActions' private `name`. */
function projectPrimaryUpdateMap(
	doc: BlueprintDoc,
	bindings: readonly DerivedCasePropertyBinding[] | undefined,
	attachmentTarget: AttachmentUrlTarget | null,
): UpdateCaseAction["update"] {
	const updateMap: UpdateCaseAction["update"] = {};
	if (!bindings) return updateMap;
	for (const binding of bindings) {
		const field = requireBindingField(doc, binding);
		const questionPath = caseUpdateQuestionPath(
			binding,
			field,
			attachmentTarget,
		);
		if (questionPath === null) continue;
		const property =
			binding.property === "case_name" ? "name" : binding.property;
		updateMap[property] = {
			question_path: questionPath,
			update_mode: "always",
		};
	}
	return updateMap;
}

/**
 * Project the ordinary primary-case writers independently from HQ's action
 * bag. A several-case form cannot expose one scalar `update_case` action, but
 * its XForm still lowers these same identity-backed writers through the
 * selected-case iteration.
 */
export function buildPrimaryCaseUpdateMap(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleCaseType: string | undefined,
	attachmentTarget: AttachmentUrlTarget | null = null,
): UpdateCaseAction["update"] {
	const form = doc.forms[formUuid];
	if (
		form === undefined ||
		!CASE_LOADING_FORM_TYPES.has(form.type) ||
		!moduleCaseType
	) {
		return {};
	}
	const inventory = deriveCaseWriteInventory(
		doc,
		formUuid,
		{ caseType: moduleCaseType },
		form.type,
	);
	const projectedInventory = assertAndProjectCaseWriteInventory(inventory);
	const { caseProperties } = deriveCaseConfig(doc, projectedInventory);
	return projectPrimaryUpdateMap(doc, caseProperties, attachmentTarget);
}

/**
 * Build HQ's `FormActions` object for `formUuid`.
 *
 * Maps the derived case config (`case_properties`, `case_preload`,
 * `close_condition`, `child_cases`) to HQ's `open_case` / `update_case` /
 * `case_preload` / `close_case` / `subcases` action shapes. The shared
 * admission assertion rejects reserved destinations and media writers before
 * projection; this layer never filters or chooses among them. Every field path
 * is resolved through the form's group/repeat hierarchy so the emitted
 * `question_path` matches the XForm's nested instance nodes.
 */
export function buildFormActions(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleCaseType: string | undefined,
	attachmentTarget: AttachmentUrlTarget | null = null,
	caseSelection?: CaseSelectionCardinality,
): FormActions {
	const base = emptyFormActions();
	const form = doc.forms[formUuid];
	const effectiveCaseSelection =
		caseSelection ?? caseSelectionForForm(doc, formUuid);
	const inventory = deriveCaseWriteInventory(
		doc,
		formUuid,
		{ caseType: moduleCaseType },
		form.type,
	);
	const projectedInventory = assertAndProjectCaseWriteInventory(inventory);

	// The worker's own record is filled in BEFORE the case-type early return,
	// because it does not depend on one. `usercase_update` is a form action on
	// any module form in HQ, and a survey form is a module form with no case
	// type of its own — often the only place a worker-record write makes sense.
	//
	// `usercase_preload` stays at `neverCondition()`, and that is a decision
	// rather than an omission: Nova already reads worker data through the
	// `#user/` hashtag, which compiles to the very same `casedb` join
	// (`lib/commcare/hashtags.ts`). A preload action would be a second
	// representation of one read, and the two could disagree.
	const usercaseBucket = projectedInventory.buckets.find(
		(projected) => projected.bucket.kind === "usercase",
	);
	if (usercaseBucket !== undefined) {
		for (const { writer, path } of usercaseBucket.writers) {
			base.usercase_update.update[writer.property] = {
				question_path: path.toXPath(),
				update_mode: "always",
			};
		}
		base.usercase_update.condition = alwaysCondition();
	}

	if (form.type === "survey" || !moduleCaseType) {
		return base;
	}

	const { caseNames, caseProperties, casePreload, childCases } =
		deriveCaseConfig(doc, projectedInventory);

	if (form.type === "registration") {
		// Open case + name update. The admission assertion above proves exactly
		// one name writer; this second boundary assertion refuses to synthesize
		// or choose a writer if derivation ever drifts from that inventory.
		base.open_case.condition = alwaysCondition();
		if (caseNames?.length !== 1) {
			throw new Error(
				`Registration form '${form.id}' reached the expander with ${caseNames?.length ?? 0} case-name writers; exactly one is required.`,
			);
		}
		base.open_case.name_update.question_path = caseNames[0].path.toXPath();

		const externalIds =
			caseProperties?.filter((binding) => binding.property === "external_id") ??
			[];
		if (externalIds.length > 1) {
			throw new Error(
				`Registration form '${form.id}' reached the expander with ${externalIds.length} external-id writers; at most one is allowed.`,
			);
		}
		base.open_case.external_id = externalIds[0]?.path.toXPath() ?? null;

		const updateMap = projectPrimaryUpdateMap(
			doc,
			caseProperties?.filter((binding) => binding.property !== "external_id"),
			attachmentTarget,
		);
		if (Object.keys(updateMap).length > 0) {
			base.update_case.condition = alwaysCondition();
			base.update_case.update = updateMap;
		}
	}

	if (CASE_LOADING_FORM_TYPES.has(form.type)) {
		const updateMap = projectPrimaryUpdateMap(
			doc,
			caseProperties,
			attachmentTarget,
		);
		if (
			effectiveCaseSelection === "single" &&
			Object.keys(updateMap).length > 0
		) {
			base.update_case.condition = alwaysCondition();
			base.update_case.update = updateMap;
		}

		// Preload case data from the exact admitted primary-update writers.
		if (
			effectiveCaseSelection === "single" &&
			casePreload &&
			casePreload.length > 0
		) {
			const preloadMap: Record<string, string> = {};
			for (const binding of casePreload) {
				preloadMap[binding.path.toXPath()] =
					binding.property === "case_name" ? "name" : binding.property;
			}
			if (Object.keys(preloadMap).length > 0) {
				base.case_preload.condition = alwaysCondition();
				base.case_preload.preload = preloadMap;
			}
		}
	}

	// Close-case action (close forms only — form.type IS the signal).
	if (form.type === "close") {
		if (form.closeCondition?.field && form.closeCondition?.answer) {
			base.close_case = {
				doc_type: "FormAction",
				condition: ifCondition(
					requireFieldPath(doc, formUuid, form.closeCondition.field).toXPath(),
					form.closeCondition.answer,
					form.closeCondition.operator ?? "=",
				),
			};
		} else {
			// Unconditional close (default for close forms).
			base.close_case = {
				doc_type: "FormAction",
				condition: alwaysCondition(),
			};
		}
	}

	// Child / sub-cases (auto-derived from `caseWrite.caseType` pointing at a
	// different case type).
	if (childCases && childCases.length > 0) {
		base.subcases = childCases.map((child): OpenSubCaseAction => {
			// The child-case bucket must carry a field bound to `case_name`.
			// The validator rejects a bucket without one, so reaching the
			// emitter without it means an upstream invariant broke.
			if (child.caseNames.length !== 1) {
				throw new Error(
					`Form '${form.id}' derives a child case of type '${child.caseType}' with ${child.caseNames.length} case-name writers; exactly one is required.`,
				);
			}
			const [childCaseName] = child.caseNames;

			// Each binding already carries the stable source identity and the
			// resolved path captured in its own bucket, so cousin fields with
			// equal friendly ids cannot redirect this update.
			const childProps: Record<
				string,
				{ question_path: string; update_mode: string }
			> = {};
			for (const binding of child.caseProperties) {
				const field = requireBindingField(doc, binding);
				const questionPath = caseUpdateQuestionPath(
					binding,
					field,
					attachmentTarget,
				);
				if (questionPath === null) continue;
				childProps[binding.property] = {
					question_path: questionPath,
					update_mode: "always",
				};
			}

			// Subcase wrapper splice target. `child.repeatContext` is the
			// resolved XPath string already (deriveCaseConfig records the
			// repeat's path during its walk, including the `/item` step for
			// `query_bound`). Pass through verbatim — no second resolution,
			// no cousin-id ambiguity.
			const repeatContextStr = child.repeatContext ?? "";

			return {
				doc_type: "OpenSubCaseAction",
				case_type: child.caseType,
				name_update: {
					question_path: childCaseName.path.toXPath(),
					update_mode: "always",
				},
				reference_id: "",
				case_properties: childProps,
				repeat_context: repeatContextStr,
				relationship: child.relationship,
				close_condition: neverCondition(),
				condition: alwaysCondition(),
			};
		});
	}

	return base;
}

function caseSelectionForForm(
	doc: BlueprintDoc,
	formUuid: Uuid,
): CaseSelectionCardinality {
	for (const moduleUuid of doc.moduleOrder) {
		if (!(doc.formOrder[moduleUuid] ?? []).includes(formUuid)) continue;
		const module = doc.modules[moduleUuid];
		return module === undefined ? "single" : caseSelectionCardinality(module);
	}
	return "single";
}

/**
 * Build `case_references_data.load` for `formUuid`.
 *
 * Walks every field under the form, extracts typed case / `#user/`
 * references from its XPath-valued properties (`relevant`,
 * `validate`, `calculate`, `default_value`, `required`), and emits a
 * map from the field's full `/data/...` path to the list of hashtags
 * it references. Also scans the Connect assessment / deliver-unit
 * XPath fields and emits their own entries keyed by the Connect
 * wrapper paths.
 *
 * `connect` is the resolved config from `buildConnectSlugMap` (a typed
 * pass-through; ids are valid by construction at the source). The XForm
 * builder emits its binds against those same ids, so the load-map keys here
 * line up with the bind nodesets.
 *
 * Every extracted ref is translated through `hqLoadReference` into the
 * `#case/`-generation vocabulary HQ's metadata layer parses — `moduleCaseType`
 * feeds the same `caseTypeDepthMap` the XForm builder resolves per-type
 * namespaces with, so the load map and the binds name the same case.
 */
export function buildCaseReferencesLoad(
	doc: BlueprintDoc,
	formUuid: Uuid,
	connect?: ResolvedConnectConfig,
	moduleCaseType?: string,
): Record<string, string[]> {
	const load: Record<string, string[]> = {};
	const caseTypeDepths = caseTypeDepthMap(moduleCaseType, doc.caseTypes ?? []);
	// The one legal authored case ref on a registration form is
	// `#<own_type>/case_id`. Its private HQ metadata projection is
	// `#case/case_id`, while the XForm side expands it to the form-local
	// `/data/case/@case_id` (the registration narrowing in
	// `hashtags/formContext.ts`). Recording that private projection here would
	// tell HQ's App Summary the form reads `case_id` from a case database it
	// never touches.
	// Vanilla parity: HQ's editor can't author case refs on a non-case-loading
	// form at all, so its load map for a registration form is empty.
	const isRegistration = doc.forms[formUuid].type === "registration";
	// Translate friendly explicit case-type namespaces to HQ's private load
	// vocabulary and dedupe references that resolve to the same case depth.
	const toLoadRefs = (exprs: string[]): string[] => [
		...new Set(
			extractHashtags(exprs)
				.map((ref) => hqLoadReference(ref, caseTypeDepths))
				.filter((ref) => !(isRegistration && ref === "#case/case_id")),
		),
	];

	const walk = (parentUuid: Uuid, parentPath: FormPath): void => {
		for (const fieldUuid of orderedFieldUuids(doc, parentUuid)) {
			const field = doc.fields[fieldUuid];
			if (!field) continue;
			const nodePath = parentPath.child(field.id);

			const xpathExprs = [
				readFieldString(field, "relevant", doc),
				readFieldString(field, "validate", doc),
				readFieldString(field, "calculate", doc),
				readFieldString(field, "default_value", doc),
				readFieldString(field, "required", doc),
			].filter((s): s is string => typeof s === "string");
			const hashtags = toLoadRefs(xpathExprs);
			if (hashtags.length > 0) {
				load[nodePath.toXPath()] = hashtags;
			}

			// Containers: recurse into their children. `doc.fieldOrder`
			// having an entry for this uuid is the container marker.
			// `descendFormPathIntoField` adds the model-iteration `<item>` step for
			// `query_bound` so descendant paths match the XForm emitter +
			// identity-backed case binding path derivation.
			if (doc.fieldOrder[fieldUuid] !== undefined) {
				walk(fieldUuid, descendFormPathIntoField(field, nodePath));
			}
		}
	};

	walk(formUuid, FormPath.root());

	// Connect assessment + deliver unit carry their own XPath fields
	// keyed by the Connect wrapper ids.
	if (connect?.assessment) {
		const assessId = connect.assessment.id;
		// `effectiveAssessmentUserScore` is the single source of truth for
		// the wire-fallback policy — the bind emitter calls the same helper,
		// so the load map's hashtag set always matches what the runtime will
		// evaluate from that bind. (The default is a hashtag-free literal,
		// so an unset user_score contributes no load entry.)
		const h = toLoadRefs([
			effectiveAssessmentUserScore(connect.assessment, doc),
		]);
		if (h.length > 0) {
			load[
				FormPath.root()
					.child(assessId)
					.child("assessment")
					.child("user_score")
					.toXPath()
			] = h;
		}
	}
	if (connect?.deliver_unit) {
		const duId = connect.deliver_unit.id;
		// `effectiveDeliverEntities` is the single source of truth for
		// the wire-fallback policy. The bind emitter calls the same
		// helper, so the load map's hashtag set always matches what the
		// runtime will evaluate from those binds.
		const { entityId, entityName } = effectiveDeliverEntities(
			connect.deliver_unit,
			doc,
		);
		const deliverPath = FormPath.root().child(duId).child("deliver");
		const idH = toLoadRefs([entityId]);
		if (idH.length > 0) {
			load[deliverPath.child("entity_id").toXPath()] = idH;
		}
		const nameH = toLoadRefs([entityName]);
		if (nameH.length > 0) {
			load[deliverPath.child("entity_name").toXPath()] = nameH;
		}
	}

	return load;
}
