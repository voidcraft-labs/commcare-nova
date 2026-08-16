import type { Draft } from "immer";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	type Automation,
	type AutomationContent,
	type AutomationMessageTemplate,
	type BlueprintDoc,
	blueprintDocSchema,
	CASE_SCALAR_PROPERTY_NAMES,
	casePropertyOptionTranslationUnitId,
	collectTranslationUnits,
	mapCasePropertiesInProse,
	mapCasePropertiesInXPath,
	materializableCaseTypes,
} from "@/lib/domain";
import {
	rewriteFieldReferenceSlots,
	rewriteFormReferenceSlots,
	rewriteModuleCaseRefs,
} from "./mutations/referenceRewrites";
import type { Mutation } from "./types";

const COMPARISON_SENTINEL = "\0case-property\0";

export type CasePropertyRenamePlanIssueReason =
	| "self-rename"
	| "duplicate-source"
	| "duplicate-destination"
	| "standard-scalar-property"
	| "source-missing"
	| "occupied-destination";

export interface CasePropertyRenamePlanIssue {
	readonly mutationIndex: 0;
	readonly renameIndex: number;
	readonly caseType: string;
	readonly from: string;
	readonly to: string;
	readonly reason: CasePropertyRenamePlanIssueReason;
}

export class CasePropertyRenamePlanError extends Error {
	constructor(readonly issue: CasePropertyRenamePlanIssue) {
		super(
			`The case-property rename does not define one lossless partial bijection (${issue.reason}).`,
		);
		this.name = "CasePropertyRenamePlanError";
	}
}

export interface CasePropertyRenamePlanEntry {
	readonly caseType: string;
	readonly from: string;
	readonly to: string;
}

export interface CasePropertyRenamePlan {
	readonly entries: readonly CasePropertyRenamePlanEntry[];
}

export type RenameCasePropertiesMutation = Extract<
	Mutation,
	{ kind: "renameCaseProperties" }
>;

function pairKey(caseType: string, property: string): string {
	return `${caseType}\0${property}`;
}

function issue(
	entry: CasePropertyRenamePlanEntry,
	renameIndex: number,
	reason: CasePropertyRenamePlanIssueReason,
): { readonly ok: false; readonly issue: CasePropertyRenamePlanIssue } {
	return {
		ok: false,
		issue: {
			mutationIndex: 0,
			renameIndex,
			caseType: entry.caseType,
			from: entry.from,
			to: entry.to,
			reason,
		},
	};
}

/**
 * Validate the explicit app-wide rename against the batch-start Blueprint.
 *
 * The command is batch-exclusive at wire admission. This planner proves the
 * remaining document-local facts: the relation is a lossless partial
 * bijection over materializable JSON properties, and an occupied destination
 * moves away in the same relation. Authoritative row and parked-value
 * vacancy is re-proved inside the persistence transaction.
 */
export function planCasePropertyRenames(
	doc: BlueprintDoc,
	mutation: RenameCasePropertiesMutation,
):
	| { readonly ok: true; readonly plan: CasePropertyRenamePlan }
	| { readonly ok: false; readonly issue: CasePropertyRenamePlanIssue } {
	const sources = new Map<string, number>();
	const destinations = new Map<string, number>();
	for (const [renameIndex, entry] of mutation.renames.entries()) {
		if (entry.from === entry.to)
			return issue(entry, renameIndex, "self-rename");
		if (
			CASE_SCALAR_PROPERTY_NAMES.has(entry.from) ||
			CASE_SCALAR_PROPERTY_NAMES.has(entry.to)
		) {
			return issue(entry, renameIndex, "standard-scalar-property");
		}
		const sourceKey = pairKey(entry.caseType, entry.from);
		if (sources.has(sourceKey)) {
			return issue(entry, renameIndex, "duplicate-source");
		}
		sources.set(sourceKey, renameIndex);
		const destinationKey = pairKey(entry.caseType, entry.to);
		if (destinations.has(destinationKey)) {
			return issue(entry, renameIndex, "duplicate-destination");
		}
		destinations.set(destinationKey, renameIndex);
	}

	const existingProperties = new Set<string>();
	for (const caseType of materializableCaseTypes(doc)) {
		for (const property of caseType.properties) {
			existingProperties.add(pairKey(caseType.name, property.name));
		}
	}
	for (const [renameIndex, entry] of mutation.renames.entries()) {
		const sourceKey = pairKey(entry.caseType, entry.from);
		if (!existingProperties.has(sourceKey)) {
			return issue(entry, renameIndex, "source-missing");
		}
		const destinationKey = pairKey(entry.caseType, entry.to);
		if (
			existingProperties.has(destinationKey) &&
			!sources.has(destinationKey)
		) {
			return issue(entry, renameIndex, "occupied-destination");
		}
	}

	return {
		ok: true,
		plan: {
			entries: mutation.renames
				.map(({ caseType, from, to }) => ({ caseType, from, to }))
				.toSorted(
					(a, b) =>
						a.caseType.localeCompare(b.caseType) ||
						a.from.localeCompare(b.from) ||
						a.to.localeCompare(b.to),
				),
		},
	};
}

/** Build the exact inverse command for undo history. */
export function invertCasePropertyRenameMutation(
	mutation: RenameCasePropertiesMutation,
): RenameCasePropertiesMutation {
	return {
		kind: "renameCaseProperties",
		renames: mutation.renames.map(({ caseType, from, to }) => ({
			caseType,
			from: to,
			to: from,
		})),
	};
}

/**
 * Apply a planned relation exactly once to every batch-start typed carrier.
 *
 * Every walker reads each leaf once, so chains, swaps, and cycles expose no
 * intermediate spelling. Field ids are form-node names and are never changed;
 * only the independent `caseWrite.property` binding follows the global rename.
 */
export function applyCasePropertyRenamePlan(
	draft: Draft<BlueprintDoc>,
	plan: CasePropertyRenamePlan,
): void {
	const destinationBySource = new Map(
		plan.entries.map((entry) => [
			pairKey(entry.caseType, entry.from),
			entry.to,
		]),
	);
	const resolve = (caseType: string, property: string): string | undefined =>
		destinationBySource.get(pairKey(caseType, property));
	rewriteCasePropertyCarriers(draft as unknown as BlueprintDoc, resolve);
}

export function rewriteCasePropertyCarriers(
	doc: BlueprintDoc,
	resolve: (caseType: string, property: string) => string | undefined,
): void {
	const translationUnitsBefore = new Map(
		collectTranslationUnits(doc).map((unit) => [unit.id, unit]),
	);
	for (const field of Object.values(doc.fields)) {
		rewriteFieldReferenceSlots(field, { resolveCaseProperty: resolve });
	}
	for (const form of Object.values(doc.forms)) {
		rewriteFormReferenceSlots(form, { resolveCaseProperty: resolve });
	}
	for (const module of Object.values(doc.modules)) {
		rewriteModuleCaseRefs(module, resolve);
	}
	for (const automation of Object.values(doc.automations ?? {})) {
		rewriteAutomationCaseProperties(doc, automation, resolve);
	}
	for (const caseType of doc.caseTypes ?? []) {
		for (const property of caseType.properties) {
			mapCasePropertiesInProse(property.label, resolve);
			if (property.hint !== undefined) {
				mapCasePropertiesInProse(property.hint, resolve);
			}
			if (property.required !== undefined) {
				mapCasePropertiesInXPath(property.required, resolve);
			}
			if (property.validation !== undefined) {
				mapCasePropertiesInXPath(property.validation, resolve);
			}
			if (property.validation_msg !== undefined) {
				mapCasePropertiesInProse(property.validation_msg, resolve);
			}
			for (const option of property.options ?? []) {
				mapCasePropertiesInProse(option.label, resolve);
			}
			const destination = resolve(caseType.name, property.name);
			if (destination !== undefined) property.name = destination;
		}
	}
	if (doc.localization !== undefined) {
		const translationUnitsAfter = new Map(
			collectTranslationUnits(doc).map((unit) => [unit.id, unit]),
		);
		for (const translations of Object.values(doc.localization.translations)) {
			/* Build the complete post-rename map away from the live record. In a
			 * simultaneous swap or cycle, one unit's destination is another unit's
			 * source key; deleting and assigning in place would overwrite an entry
			 * before that entry itself had been remapped. */
			const remapped: typeof translations = {};
			for (const [oldUnitId, entry] of Object.entries(translations)) {
				const oldUnit = translationUnitsBefore.get(oldUnitId);
				if (oldUnit === undefined) {
					remapped[oldUnitId] = entry;
					continue;
				}
				let newUnitId = oldUnit.id;
				if (oldUnit.owner.kind === "case-property-option") {
					const destination = resolve(
						oldUnit.owner.caseType,
						oldUnit.owner.property,
					);
					if (destination !== undefined) {
						newUnitId = casePropertyOptionTranslationUnitId(
							oldUnit.owner.caseType,
							destination,
							oldUnit.owner.value,
							oldUnit.owner.occurrence,
						);
					}
				}
				if (typeof entry.value === "object" && entry.value !== null) {
					mapCasePropertiesInProse(entry.value, resolve);
				}
				const newUnit = translationUnitsAfter.get(newUnitId);
				if (
					newUnit !== undefined &&
					entry.sourceFingerprint === oldUnit.sourceFingerprint
				) {
					entry.sourceFingerprint = newUnit.sourceFingerprint;
				}
				remapped[newUnitId] = entry;
			}
			for (const oldUnitId of Object.keys(translations)) {
				delete translations[oldUnitId];
			}
			Object.assign(translations, remapped);
		}
	}
}

function automationScopeCaseType(
	doc: BlueprintDoc,
	automation: Automation,
	scope: "case" | "parent" | "host",
): string | undefined {
	if (scope === "case") return automation.caseType;
	const source = doc.caseTypes?.find(
		(caseType) => caseType.name === automation.caseType,
	);
	if (source?.parent_type === undefined) return undefined;
	if (scope === "host" && source.relationship !== "extension") {
		return undefined;
	}
	return source.parent_type;
}

function rewriteAutomationTemplate(
	template: AutomationMessageTemplate,
	resolve: (caseType: string, property: string) => string | undefined,
): void {
	for (const part of template.parts) {
		if (part.kind !== "case-property") continue;
		const destination = resolve(part.caseType, part.property);
		if (destination !== undefined) part.property = destination;
	}
}

function rewriteAutomationContent(
	content: AutomationContent,
	resolve: (caseType: string, property: string) => string | undefined,
): void {
	const rewrite = (value: AutomationMessageTemplate): void =>
		rewriteAutomationTemplate(value, resolve);
	switch (content.kind) {
		case "sms":
		case "connect-message":
		case "sms-callback":
			rewrite(content.message);
			break;
		case "email":
			rewrite(content.subject);
			if (content.body.kind === "plain-text") {
				rewrite(content.body.message);
			} else {
				rewrite(content.body.html);
			}
			break;
		case "sms-survey":
		case "ivr":
		case "connect-survey":
		case "custom":
			break;
	}
}

function rewriteAutomationCaseProperties(
	doc: BlueprintDoc,
	automation: Automation,
	resolve: (caseType: string, property: string) => string | undefined,
): void {
	const rewriteScoped = (target: {
		scope: "case" | "parent" | "host";
		property: string;
	}): void => {
		const caseType = automationScopeCaseType(doc, automation, target.scope);
		if (caseType === undefined) return;
		const destination = resolve(caseType, target.property);
		if (destination !== undefined) target.property = destination;
	};
	for (const criterion of automation.criteria) {
		if (criterion.kind !== "match-property") continue;
		rewriteScoped(criterion);
	}
	if (automation.kind === "case-update") {
		for (const update of automation.updates) {
			rewriteScoped(update.target);
			if (update.value.kind === "case-property") {
				rewriteScoped(update.value.source);
			}
		}
		return;
	}
	for (const recipient of automation.recipients) {
		if (
			recipient.kind === "case-property-username" ||
			recipient.kind === "case-property-user-id" ||
			recipient.kind === "case-property-email"
		) {
			const destination = resolve(automation.caseType, recipient.property);
			if (destination !== undefined) recipient.property = destination;
		}
	}
	for (const filter of automation.userDataFilters) {
		for (const value of filter.values) {
			if (value.kind !== "case-property") continue;
			const destination = resolve(value.caseType, value.property);
			if (destination !== undefined) value.property = destination;
		}
	}
	for (const key of ["resetCaseProperty", "stopDateCaseProperty"] as const) {
		const property = automation[key];
		if (property === undefined) continue;
		const destination = resolve(automation.caseType, property);
		if (destination !== undefined) automation[key] = destination;
	}
	if (
		automation.schedule.kind === "timed" &&
		automation.schedule.start.kind === "case-property"
	) {
		const destination = resolve(
			automation.caseType,
			automation.schedule.start.property,
		);
		if (destination !== undefined) {
			automation.schedule.start.property = destination;
		}
	}
	if (automation.schedule.kind === "timed") {
		for (const event of automation.schedule.events) {
			if (event.timing.kind !== "case-property-time") continue;
			const destination = resolve(automation.caseType, event.timing.property);
			if (destination !== undefined) event.timing.property = destination;
		}
	}
	for (const event of automation.schedule.events) {
		rewriteAutomationContent(event.content, resolve);
	}
}

export interface CasePropertyCarrierName {
	readonly path: string;
	readonly value: string;
}

/**
 * Exact name-bearing projection used by endpoint-only diff admission.
 *
 * The registry-driven entity walkers plus the explicit root-catalog walker
 * normalize every property-name carrier to an impossible sentinel. Comparing
 * the original and normalized trees then records only those string leaves,
 * keyed by structural JSON path. Generic endpoint diff may compare these
 * projections, but it may never infer semantic rename intent from them.
 */
export function casePropertyCarrierNames(
	doc: BlueprintDoc,
): readonly CasePropertyCarrierName[] {
	// Callers may pass the Zustand store object, whose data slots form a
	// BlueprintDoc but which also carries action functions and bookkeeping.
	// Select the canonical persistence keys from the schema before cloning.
	// We deliberately do not parse here: carrier inventory is also used by
	// commit diagnostics while a candidate is being evaluated, and diagnostics
	// must inventory that exact candidate rather than reject or normalize it.
	const persistable = toPersistableDoc(doc) as Record<string, unknown>;
	const original = structuredClone(
		Object.fromEntries(
			Object.keys(blueprintDocSchema.shape).flatMap((key) =>
				Object.hasOwn(persistable, key)
					? [[key, persistable[key]] as const]
					: [],
			),
		),
	) as BlueprintDoc;
	const normalized = structuredClone(original);
	rewriteCasePropertyCarriers(normalized, () => COMPARISON_SENTINEL);
	const names: CasePropertyCarrierName[] = [];
	const walk = (before: unknown, after: unknown, path: string): void => {
		if (before === after) return;
		if (
			typeof before !== "object" ||
			before === null ||
			typeof after !== "object" ||
			after === null
		) {
			if (typeof before !== "string" || after !== COMPARISON_SENTINEL) {
				throw new Error(
					`casePropertyCarrierNames normalized an unexpected value at ${path || "/"}.`,
				);
			}
			names.push({ path, value: before });
			return;
		}
		if (Array.isArray(before) || Array.isArray(after)) {
			if (!Array.isArray(before) || !Array.isArray(after)) {
				throw new Error(
					`casePropertyCarrierNames changed container shape at ${path || "/"}.`,
				);
			}
			for (let index = 0; index < before.length; index += 1) {
				walk(before[index], after[index], `${path}/${index}`);
			}
			return;
		}
		for (const key of Object.keys(before).toSorted((a, b) =>
			a.localeCompare(b),
		)) {
			walk(
				(before as Record<string, unknown>)[key],
				(after as Record<string, unknown>)[key],
				`${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
			);
		}
	};
	walk(original, normalized, "");
	return names;
}

/**
 * Whether two endpoint catalogs contain a valid app-wide case-property
 * rename-shaped subdelta.
 *
 * This is a refusal detector, never a command synthesizer. Property
 * declarations have no UUID of their own, so a same-length catalog whose
 * names changed in place is the endpoint evidence from which a rename-shaped
 * relation can be proposed. We run that relation through the real planner but
 * never return it as a command.
 *
 * Granular edits stay granular: adding/removing a writer or catalog property,
 * locally retargeting `field.caseWrite`, or changing a case-operation write
 * does not change an existing declaration name in place. Conversely, once a
 * valid declaration relation is present, unrelated endpoint changes do not
 * make its saved-row effects inferable. Generic diff must still refuse it:
 * masking the app name or an unrelated label cannot turn semantic provenance
 * into snapshot evidence.
 */
export function isCasePropertyRenameShapedEndpointDelta(
	prev: BlueprintDoc,
	next: BlueprintDoc,
): boolean {
	const nextTypesByName = new Map(
		(next.caseTypes ?? []).map((caseType) => [caseType.name, caseType]),
	);
	const renames: RenameCasePropertiesMutation["renames"][number][] = [];
	for (const previousType of prev.caseTypes ?? []) {
		const nextType = nextTypesByName.get(previousType.name);
		if (nextType === undefined) continue;
		const sharedLength = Math.min(
			previousType.properties.length,
			nextType.properties.length,
		);
		for (let index = 0; index < sharedLength; index += 1) {
			const from = previousType.properties[index]?.name;
			const to = nextType.properties[index]?.name;
			if (from === undefined || to === undefined) return false;
			if (from !== to) {
				renames.push({ caseType: previousType.name, from, to });
			}
		}
	}
	if (renames.length === 0) return false;

	const mutation: RenameCasePropertiesMutation = {
		kind: "renameCaseProperties",
		renames,
	};
	const planned = planCasePropertyRenames(prev, mutation);
	return planned.ok;
}
