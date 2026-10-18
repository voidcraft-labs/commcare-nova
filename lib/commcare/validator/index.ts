/** Typed form-expression validation. Stored expressions go directly through
 * the shared checker; source parsing belongs to the authoring boundary. */
import {
	type BlueprintDoc,
	type ConnectExpressionSlotId,
	expressionSlotValues,
	type FieldFormLogicSlotId,
	type FieldProseSlotId,
	type FormLinkExpressionSlotId,
	fieldRegistry,
	type ProseTemplate,
	proseSurfaceReads,
	type Uuid,
} from "@/lib/domain";
import {
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import {
	datumRefKey,
	type ProseSlotRef,
	type Term,
} from "@/lib/domain/expression/types";
import { buildFieldTree } from "@/lib/preview/engine/fieldTree";
import { type CycleReport, TriggerDag } from "@/lib/preview/engine/triggerDag";
import { proseTemplateSurvivesTiptapRoundTrip } from "@/lib/tiptap/proseTemplateCodec";
import {
	type FormLogicFinding,
	formLogicFinding,
	formLogicFindings,
} from "./formLogicFindings";
import { semanticCheckErrors } from "./lookupTypeContext";
export type XPathSurface = FieldFormLogicSlotId;
export type ConnectXPathSlot = ConnectExpressionSlotId;
export type FormLinkXPathSlot = FormLinkExpressionSlotId;
export type ProseSurface = FieldProseSlotId;
export interface ValidationScope {
	readonly moduleUuids?: ReadonlySet<Uuid>;
	readonly formUuids?: ReadonlySet<Uuid>;
}

/** Whether a scope (or no scope) admits the module's module-level rules. */
export function scopeHasModule(
	scope: ValidationScope | undefined,
	moduleUuid: Uuid,
): boolean {
	return scope === undefined || (scope.moduleUuids?.has(moduleUuid) ?? false);
}

/**
 * Whether a scope (or no scope) admits a form's form-level work. Module and
 * form footprints are independent, so a present scope admits only explicitly
 * named forms.
 */
export function scopeHasForm(
	scope: ValidationScope | undefined,
	_moduleUuid: Uuid,
	formUuid: Uuid,
): boolean {
	return scope === undefined || (scope.formUuids?.has(formUuid) ?? false);
}

interface DeepLocation {
	moduleUuid: Uuid;
	moduleName: string;
	formUuid: Uuid;
	formName: string;
}

/**
 * A single deep-validation finding, fully typed. Three shapes:
 *   - `field-xpath` — an XPath error on a specific field surface; carries the
 *     field's uuid + id, the `surface`, and the underlying typed `FormLogicFinding`.
 *   - `connect-xpath` — an XPath error in a Connect-block slot.
 *   - `cycle` — a dependency cycle among authored field expressions in one
 *     form, including defaults, lookup-choice filters, and the relevance
 *     cascade from a group or repeat to its descendants (`cascade` names
 *     that edge when the loop closes through it).
 * The runner switches on `kind` and projects each into a `ValidationError`.
 */
export type DeepValidationError =
	| (DeepLocation & {
			kind: "field-xpath";
			fieldUuid: Uuid;
			fieldId: string;
			surface: XPathSurface;
			error: FormLogicFinding;
	  })
	| (DeepLocation & {
			kind: "field-prose";
			fieldUuid: Uuid;
			fieldId: string;
			surface: ProseSurface;
			error: FormLogicFinding;
	  })
	| (DeepLocation & {
			kind: "connect-xpath";
			slot: ConnectXPathSlot;
			error: FormLogicFinding;
	  })
	| (DeepLocation & {
			kind: "form-link-xpath";
			slot: FormLinkXPathSlot;
			indices: readonly number[];
			/** The link the slot belongs to; absent only when the index is stale. */
			linkUuid?: Uuid;
			error: FormLogicFinding;
	  })
	| (DeepLocation & {
			kind: "cycle";
			cycle: readonly string[];
			cascade?: CycleReport["cascade"];
			countFeedback?: string;
	  });

export function validateBlueprintDeep(
	doc: BlueprintDoc,
	scope?: ValidationScope,
	lookupTables: LookupTypeIndex = new Map(),
): DeepValidationError[] {
	const errors: DeepValidationError[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			if (!scopeHasForm(scope, moduleUuid, formUuid)) continue;
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			const loc: DeepLocation = {
				moduleUuid,
				moduleName: mod.name,
				formUuid,
				formName: form.name,
			};
			const tree = buildFieldTree(formUuid, doc.fields, doc.fieldOrder);
			const structure = slotContext(
				doc,
				{ entity: "form", uuid: formUuid, slot: "form_display_condition" },
				lookupTables,
			)?.form;
			for (const fieldUuid of structure?.fields.keys() ?? []) {
				const field = doc.fields[fieldUuid];
				if (field === undefined) continue;
				for (const { ref, expression } of expressionSlotValues(doc, {
					entity: "field",
					uuid: fieldUuid,
				})) {
					if (ref.entity !== "field" || ref.slot === "lookup_options_source")
						continue;
					const ctx = slotContext(doc, ref, lookupTables);
					const findings =
						ctx === undefined
							? [
									{
										code: "TYPE_ERROR" as const,
										message: "This expression has no valid owning slot.",
									},
								]
							: formLogicFindings(expression, ctx);
					for (const error of findings)
						errors.push({
							...loc,
							kind: "field-xpath",
							fieldUuid,
							fieldId: field.id,
							surface: ref.slot,
							error,
						});
				}
				for (const { slot, template, indices } of proseSurfaceReads(
					field,
					doc,
				)) {
					const option =
						slot === "option_label" &&
						"optionsSource" in field &&
						field.optionsSource.kind === "inline"
							? field.optionsSource.options[indices[0]]
							: undefined;
					let ref: ProseSlotRef;
					if (slot === "option_label") {
						if (option === undefined)
							throw new Error(
								"The prose registry returned a missing option member.",
							);
						ref = {
							entity: "field",
							uuid: fieldUuid,
							slot,
							member: { optionUuid: option.uuid },
						};
					} else ref = { entity: "field", uuid: fieldUuid, slot };
					const ctx = slotContext(doc, ref, lookupTables);
					const push = (error: FormLogicFinding) =>
						errors.push({
							...loc,
							kind: "field-prose",
							fieldUuid,
							fieldId: field.id,
							surface: slot,
							error,
						});
					if (!proseTemplateSurvivesTiptapRoundTrip(template)) {
						push({
							code: "PROSE_EDITOR_ROUND_TRIP_LOSS",
							message:
								"This text changes when Nova's reference editor reads and writes it.",
						});
						continue;
					}
					if (ctx === undefined) {
						push({
							code: "INVALID_REF",
							message: "This text has no valid owning slot.",
						});
						continue;
					}
					for (const part of template.parts) {
						const term = proseTerm(part);
						if (term === undefined) continue;
						if (
							term.kind === "field" &&
							doc.fields[term.uuid] !== undefined &&
							fieldRegistry[doc.fields[term.uuid].kind].isStructural
						) {
							push({
								code: "INVALID_REF",
								message:
									"Text can read an answer, but cannot display a whole group or repeat.",
							});
							continue;
						}
						for (const error of semanticCheckErrors(
							checkExpression({ kind: "term", term }, ctx),
						))
							push(formLogicFinding(error, ctx, { kind: "term", term }));
					}
				}
			}
			for (const { ref, expression } of expressionSlotValues(doc, {
				entity: "form",
				uuid: formUuid,
			})) {
				if (ref.entity !== "form") continue;
				if (
					ref.slot !== "assessment_user_score" &&
					ref.slot !== "deliver_entity_id" &&
					ref.slot !== "deliver_entity_name" &&
					ref.slot !== "form_link_condition" &&
					ref.slot !== "form_link_datum_xpath"
				)
					continue;
				const ctx = slotContext(doc, ref, lookupTables);
				const findings =
					ctx === undefined
						? [
								{
									code: "TYPE_ERROR" as const,
									message: "This expression has no valid owning slot.",
								},
							]
						: formLogicFindings(expression, ctx);
				for (const error of findings) {
					if (
						ref.slot === "form_link_condition" ||
						ref.slot === "form_link_datum_xpath"
					) {
						const linkIndex =
							form.formLinks?.findIndex(
								(link) => link.uuid === ref.member.linkUuid,
							) ?? -1;
						const datumIndex =
							ref.slot === "form_link_datum_xpath"
								? (form.formLinks?.[linkIndex]?.datums?.findIndex(
										(datum) =>
											datumRefKey(datum.name) === datumRefKey(ref.member.datum),
									) ?? -1)
								: undefined;
						errors.push({
							...loc,
							kind: "form-link-xpath",
							slot: ref.slot,
							indices:
								datumIndex === undefined
									? [linkIndex]
									: [linkIndex, datumIndex],
							linkUuid: ref.member.linkUuid,
							error,
						});
					} else
						errors.push({
							...loc,
							kind: "connect-xpath",
							slot: ref.slot,
							error,
						});
				}
			}
			for (const {
				path,
				cascade,
				countFeedback,
			} of new TriggerDag().reportCycles(tree, doc, formUuid))
				errors.push({
					...loc,
					kind: "cycle",
					cycle: path,
					...(cascade === undefined ? {} : { cascade }),
					...(countFeedback === undefined ? {} : { countFeedback }),
				});
		}
	}
	return errors;
}
function proseTerm(part: ProseTemplate["parts"][number]): Term | undefined {
	switch (part.kind) {
		case "text":
			return undefined;
		case "field-ref":
			return { kind: "field", uuid: part.uuid };
		case "case-ref":
			return {
				kind: "form-case",
				caseType: part.caseType,
				property: part.property,
			};
		case "user-property-ref":
			return {
				kind: "session-user-property",
				userPropertyUuid: part.userPropertyUuid,
			};
		case "user-ref":
			return { kind: "session-user", field: part.property };
	}
}
