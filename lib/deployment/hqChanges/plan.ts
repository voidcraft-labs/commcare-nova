/**
 * The plan of what a change made in CommCare HQ does to an app Nova holds.
 *
 * The change is the difference of two readings of two of CommCare HQ's own
 * answers, `B` (the baseline's source) and `T` (the app now), through one
 * reader and one identity map: ordinary mutations keyed by Nova's UUIDs. It
 * is narrowed to what CommCare HQ's app can say, applied to the app as it
 * stands where Nova holds nothing unpublished and to the published document
 * otherwise, checked to fit, and replayed as the batch a commit takes. A
 * failure of one of this plan's own checks is named by a content-free
 * signature that begins with the check
 * (`lib/deployment/reading/signature.ts::differenceSignature`).
 *
 * Pure: it reads its arguments, logs nothing and asks nothing of a store.
 * It runs a step at a time (`planHqChangesSteps`), each diff, preparation
 * and canonical form its own step, so a caller on a request lets the event
 * loop turn between them.
 */

import { Immer } from "immer";
import { expandDocSteps } from "@/lib/commcare/expander";
import {
	effectiveWordingValue,
	wordingSourceUnit,
} from "@/lib/commcare/generatedSearchWording";
import { identityLookupWireNaming } from "@/lib/commcare/lookup/naming";
import type { ReadDraft, ReadOutcome } from "@/lib/commcare/reader";
import {
	CANONICALIZATIONS,
	type Canonicalization,
	canonDocumentSteps,
	type WithheldRewrite,
} from "@/lib/commcare/reader/canon";
import { unprintedSearchWording } from "@/lib/commcare/reader/search/guardSplit";
import { rethrowWorkStop } from "@/lib/commcare/workMeter";
import {
	preparedCandidateHasAdmissionIssue,
	prepareMutationCandidateSteps,
} from "@/lib/doc/commitVerdicts";
import { deepEqual } from "@/lib/doc/deepEqual";
import {
	diffDocsToMutationsSteps,
	HQ_READING_DELTA,
} from "@/lib/doc/diffDocsToMutations";
import {
	type DocumentChanges,
	documentChanges,
} from "@/lib/doc/documentChanges";
import {
	type DocumentDifference,
	documentDifferences,
} from "@/lib/doc/documentDifferences";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import type { DeclarationChoice } from "@/lib/doc/platformDeclaration";
import { staleSourceTranslation } from "@/lib/doc/sourceLanguage";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseProperty,
	PersistableDoc,
	Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { entryPointByUuid } from "@/lib/domain/entryPoints";
import { CONNECT_ROLES } from "@/lib/domain/fields/connectActivity";
import { resolvedLanguageDisplayLabel } from "@/lib/domain/languageRegistry/names";
import {
	effectiveAppLocalization,
	languageEntries,
	languageTag,
	parseLanguageTag,
	translationSourceFingerprintsEqual,
} from "@/lib/domain/localization";
import {
	NO_ENTRIES,
	ownRecordValue,
	recordFromEntries,
} from "@/lib/domain/records";
import {
	hasGeneratedWording,
	snapshotTranslationUnits,
	storedTranslationValue,
	translationIsOutOfDate,
} from "@/lib/domain/translationUnits";
import { log } from "@/lib/logger";
import type { FirstPublishChangeId } from "@/lib/publish/firstPublishChangeIds";
import type {
	CasePropertyRename,
	HqChangeHeld,
} from "@/lib/publish/hqChangesKinds";
import type { Finding } from "@/lib/publish/hqFindings";
import { assertNever } from "@/lib/utils/assertNever";
import type { AdoptedMediaFile } from "../adoption";
import type {
	AcceptanceCheck,
	AcceptedDeclaration,
	acceptReading,
} from "../reading/acceptance";
import {
	firstPublishChangesFor,
	firstPublishFactsOf,
	firstPublishListToStore,
	publishChangeSubjects,
} from "../reading/firstPublishChanges";
import { placeSteps } from "../reading/firstPublishPlaces";
import {
	KEYS_WITH_NO_EXTERNAL_KEY,
	readBackDifferences,
} from "../reading/readBack";
import { differenceSignature, documentPathKinds } from "../reading/signature";
import type { HqChangeReadings } from "./readings";
import type { ReferenceDocument } from "./reference";

/** This plan's own checks. */
export const HQ_CHANGE_PLAN_CHECKS = [
	"apply",
	"commutes",
	"replay",
	"respell",
] as const;
export type HqChangePlanCheck = (typeof HQ_CHANGE_PLAN_CHECKS)[number];
/** Which check failed: one of this plan's, or one of acceptance's (`ACCEPTANCE_CHECKS`). */
export type HqChangeCheck = AcceptanceCheck | HqChangePlanCheck;

export type HqChangePlan =
	/** The readings are one document. */
	| {
			readonly kind: "nothing";
			readonly publishChanges: readonly FirstPublishChangeId[];
			readonly changedPublishSubjects?: readonly FirstPublishChangeId[];
			readonly changedPublishForms?: readonly string[];
	  }
	| {
			readonly kind: "changes";
			/** Which document the changes are applied to. */
			readonly appliedTo: "head" | "published";
			/** That document with CommCare HQ's changes applied: the document the app takes. */
			readonly target: BlueprintDoc;
			/** `diffDocsToMutations(D_now, target, HQ_READING_DELTA)`. Empty: the app already holds them. */
			readonly batch: readonly Mutation[];
			/** What bringing the changes in changes in the app. */
			readonly hqChanges: DocumentChanges;
			/** What the take removes of the changes made in Nova since the reference. */
			readonly novaChanges: DocumentChanges;
			/** The menus and forms that took the reader's spelling before the changes. */
			readonly respelled: readonly Uuid[];
			/** Case properties the app's effective catalog holds now and the target's does not, on a
			 *  case type the target keeps. */
			readonly removedCaseProperties: readonly {
				readonly caseType: string;
				readonly name: string;
			}[];
			/** Case types the app holds now and the target does not. */
			readonly removedCaseTypes: readonly string[];
			/** Case property renames made in Nova since the reference. Not empty: no batch. */
			readonly renamedInNova: readonly CasePropertyRename[];
			readonly publishChanges: readonly FirstPublishChangeId[];
			readonly changedPublishSubjects?: readonly FirstPublishChangeId[];
			readonly changedPublishForms?: readonly string[];
	  }
	/** CommCare HQ's app now holds something Nova cannot hold. */
	| { readonly kind: "account"; readonly findings: readonly Finding[] }
	/** A change Nova names and cannot take as a change. */
	| {
			readonly kind: "held";
			readonly reason: HqChangeHeld;
			readonly translation?: import("@/lib/publish/hqChangesKinds").HqSourceTranslationRecovery;
	  }
	/** A defect of Nova's: the change did not fit, and nothing is taken. */
	| {
			readonly kind: "differs";
			readonly check: HqChangeCheck;
			readonly signature: string;
	  };

const NO_REFERENCE = (kind: string) =>
	`Nova was asked to plan CommCare HQ's changes with no reference document. \`loadReferenceDocument\` answers \`${kind}\` when it cannot build one, and the caller answers \`unavailable\` for it instead of planning.`;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const UNFROZEN = new Immer({ autoFreeze: false });

/** `doc` with a declaration choice's mutations applied by the reducers, as a birth applies them. */
function under(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	if (mutations.length === 0) return doc;
	return UNFROZEN.produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

/** A failure of one of the plan's own checks, as the content-free segments of its signature. */
interface Failure {
	readonly check: HqChangePlanCheck;
	readonly segments: readonly string[];
}

/** `doc` with `mutations` applied as a commit prepares them, or why they do not apply, a part
 *  of the preparation at a time. */
function* applied(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
	check: HqChangePlanCheck,
): Steps<{ readonly doc: BlueprintDoc } | { readonly failure: Failure }> {
	try {
		const admitted = admitMutationBatch(mutations);
		yield;
		const prepared = yield* prepareMutationCandidateSteps(doc, admitted);
		if (!preparedCandidateHasAdmissionIssue(prepared))
			return { doc: prepared.nextDoc };
		const issue =
			prepared.identityAdmissionIssue !== undefined
				? "identity"
				: prepared.sequenceAdmissionIssue !== undefined
					? "sequence"
					: prepared.targetAdmissionIssue === true
						? "target"
						: "rename";
		// The kind of the first mutation whose target is missing, a closed vocabulary.
		const at =
			issue === "target"
				? mutations.findIndex((_, index) =>
						mutationTargetsInvalid(doc, mutations.slice(0, index + 1)),
					)
				: -1;
		return {
			failure: {
				check,
				segments: [
					"admission",
					issue,
					...(at >= 0 ? [(mutations[at] as Mutation).kind] : []),
				],
			},
		};
	} catch {
		return {
			failure: { check, segments: ["threw", "prepareMutationCandidate"] },
		};
	}
}

/**
 * `canonK(doc)`: the document as a reading of its export gives it, less
 * every kind no reading holds and less where the app runs, which is what a
 * read back compares. It stops between the canonical form's rows.
 */
function* canonK(
	doc: BlueprintDoc,
	givesWay: ReadonlySet<string> = NO_PROPERTY,
	withheld?: (rewrite: WithheldRewrite) => void,
): Steps<BlueprintDoc> {
	const canon = toPersistableDoc(
		yield* canonDocumentSteps(
			withSlugsBound(doc, givesWay),
			withheld,
			doc.localization?.sourceLanguage,
		),
	) as Record<string, unknown>;
	for (const key of KEYS_WITH_NO_EXTERNAL_KEY) delete canon[key];
	const settings = canon.appSettings as PersistableDoc["appSettings"];
	if (settings.runsOnlyOn !== undefined) {
		const { runsOnlyOn: _declared, ...rest } = settings;
		canon.appSettings = rest;
	}
	return hydratePersistedBlueprint(canon as PersistableDoc);
}

const NO_PROPERTY: ReadonlySet<string> = new Set();

/**
 * The worker and location properties that give way where `ref` holds one slug twice: a property
 * renamed in Nova since the publish, or dropped there, keeps the published slug in `ref`, and a
 * property made since then can hold that slug in the head too. The slug binds to the one the
 * published document held, which is the one CommCare HQ's app means by it, so the property whose
 * slug in `now` is still that slug gives way.
 */
function propertiesGivingWay(
	ref: BlueprintDoc,
	now: BlueprintDoc,
): ReadonlySet<string> {
	const out = new Set<string>();
	const collect = (
		before: Readonly<Record<string, { readonly slug: string }>> | undefined,
		after: Readonly<Record<string, { readonly slug: string }>> | undefined,
	) => {
		const bySlug = new Map<string, string[]>();
		for (const [uuid, property] of Object.entries(before ?? {}))
			bySlug.set(property.slug, [...(bySlug.get(property.slug) ?? []), uuid]);
		for (const [slug, holders] of bySlug) {
			if (holders.length < 2) continue;
			const newer = holders.filter(
				(uuid) => ownRecordValue(after, uuid)?.slug === slug,
			);
			if (newer.length < holders.length)
				for (const uuid of newer) out.add(uuid);
		}
	};
	collect(ref.userProperties, now.userProperties);
	collect(ref.locationProperties, now.locationProperties);
	return out;
}

/**
 * `doc` with each property of `givesWay` that shares its slug with another property of `doc`
 * under a slug no property holds, so a reading's identity map binds the slug to the other one. A
 * reading reads a property only by what its logic reads, and nothing of what CommCare HQ's app
 * reads means the property that gives way, so the slug it is given never reaches a comparison
 * unless the document's own logic reads it, and then both documents compared spell it alike.
 */
function withSlugsBound(
	doc: BlueprintDoc,
	givesWay: ReadonlySet<string>,
): BlueprintDoc {
	if (givesWay.size === 0) return doc;
	const respelled = <P extends { readonly slug: string }>(
		record: Readonly<Record<string, P>> | undefined,
	): Record<string, P> | null => {
		if (record === undefined) return null;
		const held = new Set(Object.values(record).map((one) => one.slug));
		let next: Record<string, P> | null = null;
		for (const [uuid, property] of Object.entries(record)) {
			if (!givesWay.has(uuid)) continue;
			const shared = Object.entries(record).some(
				([other, one]) => other !== uuid && one.slug === property.slug,
			);
			if (!shared) continue;
			let n = 1;
			while (held.has(`${property.slug}_${n}`)) n++;
			const slug = `${property.slug}_${n}`;
			held.add(slug);
			next = recordFromEntries([
				...Object.entries(next ?? record),
				[uuid, { ...property, slug }],
			]);
		}
		return next;
	};
	const next = toPersistableDoc(doc);
	const users = respelled(next.userProperties);
	const places = respelled(next.locationProperties);
	if (users === null && places === null) return doc;
	return hydratePersistedBlueprint({
		...next,
		...(users !== null && {
			userProperties: users as PersistableDoc["userProperties"],
		}),
		...(places !== null && {
			locationProperties: places as PersistableDoc["locationProperties"],
		}),
	});
}

/** The first differing path of two documents, as signature segments; null where none. */
function firstDifference(
	expected: BlueprintDoc,
	actual: BlueprintDoc,
): readonly string[] | null {
	const [first] = documentDifferences(expected, actual);
	return first === undefined ? null : documentPathKinds(first.path);
}

function differs(failure: Failure): Extract<HqChangePlan, { kind: "differs" }> {
	return {
		kind: "differs",
		check: failure.check,
		signature: differenceSignature(failure.check, failure.segments),
	};
}

// ---------------------------------------------------------------------------
// Step 7: the three narrowing rules
// ---------------------------------------------------------------------------

function catalogProperty(
	doc: BlueprintDoc,
	caseType: string,
	name: string,
): CaseProperty | undefined {
	return doc.caseTypes
		?.find((type) => type.name === caseType)
		?.properties.find((property) => property.name === name);
}

/**
 * `H` narrowed to what CommCare HQ's app can say, over `D`, the document
 * the changes are applied to:
 *
 * - no worker or location property is removed or relabelled, and an add of
 *   one `D` holds is left out: a reading holds a property per slug the app
 *   reads, labelled with its slug, and no definition;
 * - a translation whose text the two readings agree on and whose source
 *   moved keeps `D`'s entry, with `T`'s fingerprint and marked for review;
 * - no declared case property leaves the catalog, a property a reading
 *   starts naming that `D` already declares keeps its declaration, and each
 *   property both readings hold with keys that differ takes `D`'s
 *   declaration with only those keys replaced. A reading's catalog is what
 *   the reader derives, so a type `D` uses without declaring it is declared
 *   before a property is written to it, and retiring one is nothing to do.
 *   A property added after one `D` does not declare (a property only a
 *   question's save gave) is placed after the nearest property before it in
 *   `T`'s catalog that `D` holds, and first where there is none.
 */
function narrowed(
	H: readonly Mutation[],
	B: BlueprintDoc,
	T: BlueprintDoc,
	D: BlueprintDoc,
): Mutation[] {
	const out: Mutation[] = [];
	const declared = new Set((D.caseTypes ?? []).map((type) => type.name));
	// The properties each type's catalog holds as `out` builds it, by type.
	const catalogs = new Map<string, Set<string>>();
	const catalogOf = (caseType: string): Set<string> => {
		let names = catalogs.get(caseType);
		if (names === undefined) {
			names = new Set(
				(D.caseTypes ?? [])
					.find((type) => type.name === caseType)
					?.properties.map((property) => property.name) ?? [],
			);
			catalogs.set(caseType, names);
		}
		return names;
	};
	const declare = (caseType: string) => {
		if (declared.has(caseType)) return;
		declared.add(caseType);
		out.push({ kind: "declareCaseType", caseType });
	};
	for (const mutation of H) {
		switch (mutation.kind) {
			case "setConnectRoles": {
				// HQ shows roles through submitted activities. Removing the last
				// activity says nothing about the roles the Nova author selected.
				const roles = CONNECT_ROLES.filter(
					(role) =>
						D.connectRoles.includes(role) || mutation.roles.includes(role),
				);
				if (roles.length !== D.connectRoles.length)
					out.push({ kind: "setConnectRoles", roles });
				break;
			}
			case "removeUserProperty":
			case "updateUserProperty":
			case "removeLocationProperty":
			case "updateLocationProperty":
			case "removeCaseProperty":
			case "setCaseProperty":
				break;
			case "addUserProperty":
				if (
					ownRecordValue(D.userProperties, mutation.property.uuid) === undefined
				)
					out.push(mutation);
				break;
			case "addLocationProperty":
				if (
					ownRecordValue(D.locationProperties, mutation.property.uuid) ===
					undefined
				)
					out.push(mutation);
				break;
			case "setTranslation": {
				const before = ownRecordValue(
					languageEntries(B.localization, mutation.language),
					mutation.unitId,
				);
				const after = mutation.entry;
				const held = ownRecordValue(
					languageEntries(D.localization, mutation.language),
					mutation.unitId,
				);
				if (
					effectiveAppLocalization(B.localization).sourceLanguage !==
						effectiveAppLocalization(T.localization).sourceLanguage &&
					held
				) {
					const rawOriginal = snapshotTranslationUnits(D).get(mutation.unitId);
					const rawIncoming = snapshotTranslationUnits(T).get(mutation.unitId);
					const original = rawOriginal && wordingSourceUnit(D, rawOriginal);
					const incoming = rawIncoming && wordingSourceUnit(T, rawIncoming);
					if (
						original &&
						incoming &&
						translationIsOutOfDate(
							held,
							original,
							mutation.language,
							mutation.language ===
								effectiveAppLocalization(D.localization).sourceLanguage,
						)
					) {
						const fallback = effectiveWordingValue(
							T,
							mutation.language,
							incoming,
						);
						const { workerFallback: _prior, ...saved } = held;
						out.push({
							...mutation,
							entry:
								deepEqual(fallback, incoming.source) &&
								!translationSourceFingerprintsEqual(
									saved.sourceFingerprint,
									incoming.sourceFingerprint,
								)
									? saved
									: {
											...saved,
											workerFallback: {
												value: fallback,
												sourceFingerprint: incoming.sourceFingerprint,
											},
										},
						});
						break;
					}
				}
				// Native strings carry no authorship. When the two readings
				// agree on a generated output, keep its actual language entry.
				// The source rebase already moved it to its new storage location.
				if (before && after && held && deepEqual(before.value, after.value)) {
					const original = snapshotTranslationUnits(D).get(mutation.unitId);
					if (original && hasGeneratedWording(original)) break;
				}
				if (
					before !== undefined &&
					after !== null &&
					held !== undefined &&
					deepEqual(before.value, after.value)
				)
					out.push({
						...mutation,
						entry: {
							...held,
							sourceFingerprint: after.sourceFingerprint,
							review: "needs-review",
						},
					});
				else out.push(mutation);
				break;
			}
			case "declareCaseType":
				if (!declared.has(mutation.caseType)) {
					declared.add(mutation.caseType);
					out.push(mutation);
				}
				break;
			case "retireCaseType":
				if (declared.has(mutation.caseType)) {
					declared.delete(mutation.caseType);
					out.push(mutation);
				}
				break;
			case "addCaseProperty": {
				if (
					catalogProperty(D, mutation.caseType, mutation.property.name) !==
					undefined
				)
					break;
				declare(mutation.caseType);
				const names = catalogOf(mutation.caseType);
				out.push(anchoredIn(mutation, names, T));
				names.add(mutation.property.name);
				break;
			}
			case "setCaseTypeMeta":
				declare(mutation.caseType);
				out.push(mutation);
				break;
			default:
				out.push(mutation);
		}
	}
	// The keys a declaration takes from the change: those the two readings' effective catalogs
	// give the property apart, which is where a writer CommCare HQ changed moves its type.
	const before = effectiveCaseTypes(B);
	for (const type of effectiveCaseTypes(T)) {
		for (const property of type.properties) {
			const read = before
				.find((one) => one.name === type.name)
				?.properties.find((one) => one.name === property.name);
			if (read === undefined || deepEqual(read, property)) continue;
			const held = catalogProperty(D, type.name, property.name);
			if (held === undefined) {
				// No declaration of Nova's: the reading's own, where its catalog changed it.
				const own = catalogProperty(T, type.name, property.name);
				const was = catalogProperty(B, type.name, property.name);
				if (own === undefined || was === undefined || deepEqual(own, was))
					continue;
				declare(type.name);
				out.push({
					kind: "setCaseProperty",
					caseType: type.name,
					property: own,
				});
				continue;
			}
			const merged: Record<string, unknown> = recordFromEntries(
				Object.entries(held),
			);
			const was = read as Record<string, unknown>;
			const next = property as Record<string, unknown>;
			for (const key of new Set([...Object.keys(was), ...Object.keys(next)])) {
				if (key === "name" || deepEqual(was[key], next[key])) continue;
				if (next[key] === undefined) delete merged[key];
				else merged[key] = next[key];
			}
			if (deepEqual(merged, held)) continue;
			out.push({
				kind: "setCaseProperty",
				caseType: type.name,
				property: merged as CaseProperty,
			});
		}
	}
	return out;
}

/**
 * `add` placed after a property `held` names: its own anchor where `held`
 * names it, else the nearest property before it in `T`'s catalog of its type
 * that `held` names, else first.
 */
function anchoredIn(
	add: Extract<Mutation, { kind: "addCaseProperty" }>,
	held: ReadonlySet<string>,
	T: BlueprintDoc,
): Extract<Mutation, { kind: "addCaseProperty" }> {
	if (typeof add.after !== "string" || held.has(add.after)) return add;
	const order = (
		T.caseTypes?.find((type) => type.name === add.caseType)?.properties ?? []
	).map((property) => property.name);
	for (let at = order.indexOf(add.property.name) - 1; at >= 0; at--) {
		const name = order[at] as string;
		if (held.has(name)) return { ...add, after: name };
	}
	return { ...add, after: null };
}

// ---------------------------------------------------------------------------
// Step 9: what a change set touches, and the reader's spelling of it
// ---------------------------------------------------------------------------

/**
 * The menus and forms a change set names: every menu a mutation names or
 * orders a form of, every form a mutation names or holds a named question
 * of, and every form whose place in its menu a mutation moves. Nothing at
 * the app's level is touched: translations, the case catalog and the worker
 * setup have their own rules.
 */
export function touchedBy(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): readonly Uuid[] {
	const touched = new Set<Uuid>();
	const forms = new Set<string>(Object.keys(doc.forms));
	const parents = new Map<string, string>(Object.entries(doc.fieldParent));
	const menuOfForm = new Map<string, Uuid>();
	for (const [menu, order] of Object.entries(doc.formOrder))
		for (const form of order) menuOfForm.set(form, menu as Uuid);
	for (const mutation of mutations) {
		if (mutation.kind === "addForm") {
			forms.add(mutation.form.uuid);
			menuOfForm.set(mutation.form.uuid, mutation.moduleUuid);
		} else if (mutation.kind === "addField")
			parents.set(mutation.field.uuid, mutation.parentUuid);
	}
	const formOfField = (uuid: string): Uuid | undefined => {
		let at: string | undefined = uuid;
		for (let step = 0; at !== undefined && step <= parents.size; step++) {
			if (forms.has(at)) return at as Uuid;
			at = parents.get(at);
		}
		return undefined;
	};
	const menu = (uuid: Uuid) => touched.add(uuid);
	const form = (uuid: Uuid) => touched.add(uuid);
	const field = (uuid: Uuid) => {
		const owner = formOfField(uuid);
		if (owner !== undefined) touched.add(owner);
	};
	const menuOf = (formUuid: Uuid) => {
		const owner = menuOfForm.get(formUuid);
		if (owner !== undefined) touched.add(owner);
	};

	for (const mutation of mutations) {
		switch (mutation.kind) {
			case "addModule":
				menu(mutation.module.uuid);
				break;
			case "removeModule":
			case "moveModule":
			case "renameModule":
			case "updateModule":
			case "setCaseListMeta":
			case "setCaseListMenuItem":
			case "setModuleMedia":
				menu(mutation.uuid);
				break;
			case "addColumn":
			case "updateColumn":
			case "removeColumn":
			case "moveColumn":
			case "addSearchInput":
			case "updateSearchInput":
			case "removeSearchInput":
			case "moveSearchInput":
				menu(mutation.moduleUuid);
				break;
			case "addForm":
				form(mutation.form.uuid);
				menu(mutation.moduleUuid);
				break;
			case "removeForm":
				form(mutation.uuid);
				menuOf(mutation.uuid);
				break;
			case "moveForm":
				form(mutation.uuid);
				menuOf(mutation.uuid);
				menu(mutation.toModuleUuid);
				break;
			case "renameForm":
			case "updateForm":
			case "setFormMedia":
				form(mutation.uuid);
				break;
			case "addFormLink":
			case "updateFormLink":
			case "removeFormLink":
			case "moveFormLink":
			case "setFormOtherwise":
				form(mutation.formUuid);
				break;
			case "addField":
				field(mutation.field.uuid);
				break;
			case "removeField":
			case "updateField":
			case "convertField":
				field(mutation.uuid);
				break;
			case "moveField":
				field(mutation.uuid);
				field(mutation.toParentUuid);
				break;
			case "addOption":
			case "updateOption":
			case "removeOption":
			case "moveOption":
			case "setFieldMedia":
				field(mutation.fieldUuid);
				break;
			case "addEntryPoint":
				if (mutation.target.kind === "form") form(mutation.target.formUuid);
				else menu(mutation.target.moduleUuid);
				break;
			case "updateEntryPoint":
			case "removeEntryPoint": {
				const owner = entryPointByUuid(doc, mutation.entryPointUuid)?.target;
				if (owner?.kind === "form") form(owner.formUuid);
				else if (owner !== undefined) menu(owner.moduleUuid);
				break;
			}
			case "holdPlacements":
				for (const hold of mutation.holds) {
					if (hold.target === "module-kind") menu(hold.moduleUuid);
					else if (hold.target === "query-repeat") field(hold.fieldUuid);
					else form(hold.formUuid);
				}
				break;
			case "setAppName":
			case "setConnectRoles":
			case "setAppLogo":
			case "setAppSettings":
			case "relabelSourceLanguage":
			case "addLanguage":
			case "removeLanguage":
			case "rebindLanguageCodes":
			case "rebaseSourceLanguage":
			case "setProjectLanguageDirection":
			case "moveLanguage":
			case "setDefaultLanguage":
			case "setTranslation":
			case "reviewTranslation":
			case "renameCaseProperties":
			case "declareCaseType":
			case "retireCaseType":
			case "addCaseProperty":
			case "setCaseProperty":
			case "removeCaseProperty":
			case "setCaseTypeMeta":
			case "addUserProperty":
			case "updateUserProperty":
			case "removeUserProperty":
			case "addUserType":
			case "updateUserType":
			case "removeUserType":
			case "addPersona":
			case "updatePersona":
			case "removePersona":
			case "addOrganizationLevel":
			case "updateOrganizationLevel":
			case "removeOrganizationLevel":
			case "addLocationProperty":
			case "updateLocationProperty":
			case "removeLocationProperty":
			case "addAutomation":
			case "updateAutomation":
			case "removeAutomation":
			case "moveAutomation":
			case "editAutomationItem":
			case "setAutomationSchedule":
			case "updateAutomationSchedule":
				break;
			default:
				assertNever(mutation);
		}
	}
	return [...touched];
}

const ONE_WIRE: readonly Canonicalization[] = CANONICALIZATIONS.filter(
	(row) => row.kind === "one-wire",
);

/** `doc` under every `one-wire` row of the canonical list, applied until none changes it. */
function oneWireSpelling(
	doc: BlueprintDoc,
	withheld?: (rewrite: WithheldRewrite) => void,
): BlueprintDoc {
	let current = doc;
	for (let pass = 0; pass <= ONE_WIRE.length; pass++) {
		const next = ONE_WIRE.reduce(
			(one, row) => row.apply(one, withheld),
			current,
		);
		if (deepEqual(toPersistableDoc(next), toPersistableDoc(current)))
			return current;
		current = next;
	}
	throw new Error(
		"Nova's one-wire canonical rows did not settle over a document. Each returns the member of its pair a reading returns, so applying one twice changes nothing; look at the row whose result another row undoes.",
	);
}

/** Every container and question under `parent` in `doc`, parents first. */
function questionsUnder(doc: BlueprintDoc, parent: string): string[] {
	const out: string[] = [];
	for (const uuid of ownRecordValue(doc.fieldOrder, parent) ?? []) {
		out.push(uuid);
		out.push(...questionsUnder(doc, uuid));
	}
	return out;
}

/**
 * `doc` with each touched menu, form and question, and each array that
 * orders a touched menu's forms or a touched form's questions, replaced by
 * the same of `doc` under every `one-wire` row. Each such pair prints the
 * same bytes, so the app Nova publishes is the same app. A question keeps
 * its own kind where the spelling would give it another: the two print one
 * export, so the batch writes no change of kind CommCare HQ's change did not
 * ask for.
 */
function inReaderSpelling(
	doc: BlueprintDoc,
	touched: readonly Uuid[],
	givesWay: ReadonlySet<string>,
	withheld?: (rewrite: WithheldRewrite) => void,
): BlueprintDoc {
	const spelled = oneWireSpelling(withSlugsBound(doc, givesWay), withheld);
	const next = toPersistableDoc(doc);
	const modules = { ...next.modules };
	const forms = { ...next.forms };
	const fields = { ...next.fields };
	const formOrder = { ...next.formOrder };
	const fieldOrder = { ...next.fieldOrder };
	for (const uuid of touched) {
		const module = ownRecordValue(spelled.modules, uuid);
		if (
			module !== undefined &&
			ownRecordValue(doc.modules, uuid) !== undefined
		) {
			modules[uuid] = module;
			const order = ownRecordValue(spelled.formOrder, uuid);
			if (order !== undefined) formOrder[uuid] = order;
		}
		const form = ownRecordValue(spelled.forms, uuid);
		if (form !== undefined && ownRecordValue(doc.forms, uuid) !== undefined) {
			forms[uuid] = form;
			for (const question of questionsUnder(doc, uuid)) {
				delete fields[question as Uuid];
				delete fieldOrder[question as Uuid];
			}
			delete fieldOrder[uuid];
			const order = ownRecordValue(spelled.fieldOrder, uuid);
			if (order !== undefined) fieldOrder[uuid] = order;
			for (const question of questionsUnder(spelled, uuid)) {
				const value = ownRecordValue(spelled.fields, question);
				// A question the spelling gives another kind keeps its own: a section and a
				// one-screen group at a form's root print the same bytes, so keeping Nova's kind
				// changes no export and writes no change of kind CommCare HQ did not ask for.
				const own = ownRecordValue(doc.fields, question);
				if (value !== undefined)
					fields[question as Uuid] =
						own !== undefined && own.kind !== value.kind ? own : value;
				const children = ownRecordValue(spelled.fieldOrder, question);
				if (children !== undefined) fieldOrder[question as Uuid] = children;
			}
		}
	}
	return hydratePersistedBlueprint({
		...next,
		modules,
		forms,
		fields,
		formOrder,
		fieldOrder,
	});
}

// ---------------------------------------------------------------------------
// Steps 8 and 9: the target and the take check
// ---------------------------------------------------------------------------

/** A target, and `D` with only CommCare HQ's changes applied, which its list is taken over. */
interface Target {
	readonly doc: BlueprintDoc;
	readonly hqOnly: BlueprintDoc;
}

/** A take over the published reference can replace unpublished worker text.
 * HQ cannot replace the saved wording of a dormant control or check.
 * On a change of source, keep the original provenance and review of any
 * generated worker text that the take already retains. */
function retainedGeneratedEdits(
	head: BlueprintDoc,
	target: BlueprintDoc,
	sourceChanged: boolean,
): Mutation[] {
	const from = effectiveAppLocalization(head.localization),
		to = effectiveAppLocalization(target.localization);
	const current = snapshotTranslationUnits(head),
		next = snapshotTranslationUnits(target);
	let hidden: ReadonlySet<string> | undefined;
	const edits: Mutation[] = [];
	for (const language of to.languageOrder) {
		if (!from.languageOrder.includes(language)) continue;
		const before = languageEntries(head.localization, language) ?? NO_ENTRIES;
		const after = languageEntries(target.localization, language) ?? NO_ENTRIES;
		for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
			const prior = ownRecordValue(before, id),
				planned = ownRecordValue(after, id);
			const original = current.get(id),
				unit = next.get(id);
			if (
				!unit ||
				!original ||
				!hasGeneratedWording(unit) ||
				deepEqual(prior, planned)
			)
				continue;
			hidden ??= unprintedSearchWording(target);
			if (
				!hidden.has(unit.id) &&
				(!sourceChanged ||
					!prior ||
					!deepEqual(
						effectiveWordingValue(head, language, original),
						effectiveWordingValue(target, language, unit),
					))
			)
				continue;
			edits.push({
				kind: "setTranslation",
				language,
				unitId: unit.id,
				entry: prior ?? null,
			});
		}
	}
	return edits;
}
/**
 * The target over `D`: `H'` applied, and where the changes are applied to
 * the published document, each case property the head declares and the
 * target does not, on a case type the target holds, after the nearest
 * property before it in the head's order that the target holds.
 */
function* targetOver(
	D: BlueprintDoc,
	Hn: readonly Mutation[],
	head: BlueprintDoc | null,
): Steps<Target | { readonly failure: Failure }> {
	const taken = yield* applied(D, Hn, "apply");
	if (!("doc" in taken)) return taken;
	const hqOnly = taken.doc;
	if (head === null) return { doc: hqOnly, hqOnly };
	const additions = retainedGeneratedEdits(
		head,
		hqOnly,
		Hn.some((mutation) => mutation.kind === "rebaseSourceLanguage"),
	);
	for (const type of taken.doc.caseTypes ?? []) {
		const declared = head.caseTypes?.find((one) => one.name === type.name);
		if (declared === undefined) continue;
		const holds = new Set(type.properties.map((property) => property.name));
		let after: string | null = null;
		for (const property of declared.properties) {
			if (!holds.has(property.name)) {
				additions.push({
					kind: "addCaseProperty",
					caseType: type.name,
					property,
					after,
				});
				holds.add(property.name);
			}
			after = property.name;
		}
	}
	if (additions.length === 0) return { doc: hqOnly, hqOnly };
	const added = yield* applied(hqOnly, additions, "apply");
	return "doc" in added ? { doc: added.doc, hqOnly } : added;
}

/**
 * Steps 8 and 9 once: the target, or the check that found it does not fit.
 * Each side takes `H` narrowed over the document it is applied to, since
 * the rules read what that document holds (a property Nova's document holds
 * and its reading's image may not).
 */
function* takeOver(
	D: BlueprintDoc,
	H: readonly Mutation[],
	B: BlueprintDoc,
	T: BlueprintDoc,
	head: BlueprintDoc | null,
	/** `canonK(D)`, where the caller holds it. */
	image: BlueprintDoc | null,
	/** The properties that give way where a document holds one slug twice. */
	givesWay: ReadonlySet<string>,
	withheld?: (rewrite: WithheldRewrite) => void,
): Steps<Target | { readonly failure: Failure }> {
	const target = yield* targetOver(D, narrowed(H, B, T, D), head);
	if (!("doc" in target)) return target;
	yield;
	const canon = image ?? (yield* canonK(D, givesWay, withheld));
	yield;
	const read = yield* applied(canon, narrowed(H, B, T, canon), "commutes");
	if (!("doc" in read)) return read;
	yield;
	const targetK = yield* canonK(target.doc, givesWay, withheld);
	yield;
	const readK = yield* canonK(read.doc, givesWay, withheld);
	yield;
	const difference = firstDifference(targetK, readK);
	return difference === null
		? target
		: { failure: { check: "commutes", segments: difference } };
}

// ---------------------------------------------------------------------------
// Steps 4 to 12
// ---------------------------------------------------------------------------

/**
 * `theirs` with each menu and form `base` also holds under its id in
 * `base`. No export carries a menu's or a form's own id: a reading mints
 * the slug of its name (the canonical row `menu-and-form-ids-as-read`), so
 * a name changed in CommCare HQ moves the id a reading gives and nothing
 * else, and no mutation writes an id after an entity is made.
 */
function withIdsOf(base: BlueprintDoc, theirs: BlueprintDoc): BlueprintDoc {
	const next = toPersistableDoc(theirs);
	let changed = false;
	const modules = { ...next.modules };
	for (const [uuid, module] of Object.entries(next.modules)) {
		const id = ownRecordValue(base.modules, uuid)?.id;
		if (id === undefined || id === module.id) continue;
		modules[uuid as Uuid] = { ...module, id };
		changed = true;
	}
	const forms = { ...next.forms };
	for (const [uuid, form] of Object.entries(next.forms)) {
		const id = ownRecordValue(base.forms, uuid)?.id;
		if (id === undefined || id === form.id) continue;
		forms[uuid as Uuid] = { ...form, id };
		changed = true;
	}
	return changed
		? hydratePersistedBlueprint({ ...next, modules, forms })
		: theirs;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
	let node = root;
	for (const key of path) {
		if (node === null || typeof node !== "object") return undefined;
		node = Object.hasOwn(node, key)
			? (node as Record<string, unknown>)[key]
			: undefined;
	}
	return node;
}

/** Whether `path` names an ordering array: the value of a key that ends in `Order`
 *  (`moduleOrder`, `listColumnOrder`), or one array of a record of them (`fieldOrder`). */
function namesOrdering(path: readonly string[]): boolean {
	return [path.at(-1), path.at(-2)].some(
		(key) => key?.endsWith("Order") === true,
	);
}

/** The ordering array `path` is or lies directly in; null where it is none. */
function orderingArrayOf(path: readonly string[]): readonly string[] | null {
	if (namesOrdering(path)) return path;
	const parent = path.slice(0, -1);
	return path.length > 0 && namesOrdering(parent) ? parent : null;
}

/**
 * Whether a change made in Nova at `path` is one the take removes: the
 * target holds another value there than the head does. An ordering array
 * is compared by the order it gives the members both hold, since a member
 * one side lacks is a change of that member's own, and a shift of every
 * position after it moves nothing.
 */
function removedBy(
	head: PersistableDoc,
	target: PersistableDoc,
	path: readonly string[],
): boolean {
	const ordering = orderingArrayOf(path);
	if (ordering !== null) {
		const now = valueAt(head, ordering);
		const then = valueAt(target, ordering);
		if (
			Array.isArray(now) &&
			Array.isArray(then) &&
			now.every((one) => typeof one === "string") &&
			then.every((one) => typeof one === "string")
		) {
			const kept = new Set(then);
			const shared = new Set(now.filter((one) => kept.has(one)));
			return !deepEqual(
				now.filter((one) => shared.has(one)),
				then.filter((one) => shared.has(one)),
			);
		}
	}
	return !deepEqual(valueAt(head, path), valueAt(target, path));
}

/** Whether a worker or location property both documents hold has another slug in `now`. */
function slugRenamed(ref: BlueprintDoc, now: BlueprintDoc): boolean {
	const renamed = (
		before: Readonly<Record<string, { readonly slug: string }>> | undefined,
		after: Readonly<Record<string, { readonly slug: string }>> | undefined,
	) =>
		Object.entries(before ?? {}).some(([uuid, property]) => {
			const held = ownRecordValue(after, uuid);
			return held !== undefined && held.slug !== property.slug;
		});
	return (
		renamed(ref.userProperties, now.userProperties) ||
		renamed(ref.locationProperties, now.locationProperties)
	);
}

/** Every case type a document holds: declared in its catalog, of a menu, or of its effective
 *  catalog. */
function caseTypesHeld(doc: BlueprintDoc): ReadonlySet<string> {
	const held = new Set<string>();
	for (const type of doc.caseTypes ?? []) held.add(type.name);
	for (const module of Object.values(doc.modules))
		if (module.caseType !== undefined && module.caseType !== "")
			held.add(module.caseType);
	for (const type of effectiveCaseTypes(doc)) held.add(type.name);
	return held;
}

interface DocumentsInput {
	readonly ref: BlueprintDoc;
	readonly now: BlueprintDoc;
	readonly base: BlueprintDoc;
	readonly theirs: BlueprintDoc;
	readonly renamesSince: readonly CasePropertyRename[];
}

/** The pieces of a plan: each `yield` is a place it may stop. */
type Steps<T> = Generator<void, T, void>;

function drained<T>(steps: Steps<T>): T {
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

/** An older reading kept the calculation and omitted an unobserved starting
 * answer. Compare the same field identities across the paired HQ sources,
 * the document that reading stored and the document the take will publish.
 * A new reading, an unrelated author edit or a completed publish cannot
 * create the historical notice: the transaction must already hold it. */
export function stillOmitsHiddenStartingAnswer(
	base: BlueprintDoc,
	reference: BlueprintDoc,
	now: BlueprintDoc,
	candidate: BlueprintDoc,
): boolean {
	return Object.values(base.fields).some((field) => {
		if (field.kind !== "hidden" || !field.default_value || !field.calculate)
			return false;
		const previous = ownRecordValue(reference.fields, field.uuid);
		const inHq = ownRecordValue(now.fields, field.uuid);
		const taken = ownRecordValue(candidate.fields, field.uuid);
		return (
			previous?.kind === "hidden" &&
			!previous.default_value &&
			inHq?.kind === "hidden" &&
			!!inHq.default_value &&
			!!inHq.calculate &&
			taken?.kind === "hidden" &&
			!taken.default_value &&
			!!taken.calculate
		);
	});
}

/** Steps 4 to 12, over four documents. What the fuzz test drives. */
export function planFromDocuments(
	input: DocumentsInput,
): Exclude<HqChangePlan, { readonly kind: "account" }> {
	return drained(planFromDocumentsSteps(input));
}

/** `planFromDocuments` one step at a time. A canonical rewrite a slot's print refused while it
 *  planned (`canon.ts::WithheldRewrite`) is Nova's own defect, logged once when it ends by row and
 *  slot kind, never by what the slot holds. */
function* planFromDocumentsSteps(
	input: DocumentsInput,
): Steps<Exclude<HqChangePlan, { readonly kind: "account" }>> {
	const withheld = new Set<string>();
	try {
		return yield* plannedFromDocuments(input, (rewrite) =>
			withheld.add(`${rewrite.rowId} in ${rewrite.slot}`),
		);
	} finally {
		if (withheld.size > 0)
			log.error(
				`[hq-changes] canonical rewrites withheld: ${withheld.size}`,
				undefined,
				{ rewrites: [...withheld].slice(0, 5).join(", ") },
			);
	}
}

/**
 * Whether `respelled`, `doc` with the reader's `one-wire` spelling written into what a change
 * touches, is the app `doc` is: CommCare HQ's import file of each, expanded alike, is the same
 * bytes. A spelling that prints otherwise would change the app with no change CommCare HQ made.
 */
function* sameExport(
	doc: BlueprintDoc,
	respelled: BlueprintDoc,
): Steps<boolean> {
	const options = { lookupNaming: identityLookupWireNaming() };
	try {
		const before = JSON.stringify(yield* expandDocSteps(doc, options));
		const after = JSON.stringify(yield* expandDocSteps(respelled, options));
		return before === after;
	} catch (error) {
		rethrowWorkStop(error);
		return false;
	}
}

function* plannedFromDocuments(
	input: DocumentsInput,
	withheld: (rewrite: WithheldRewrite) => void,
): Steps<Exclude<HqChangePlan, { readonly kind: "account" }>> {
	const { ref, now, base: B, theirs: T } = input;

	/* 4. One document. */
	if (readBackDifferences(B, { doc: T, choices: null }).length === 0)
		return { kind: "nothing", publishChanges: [] };
	yield;

	/* 5. The change, between readings that agree on every menu's and form's own id. */
	const theirs = withIdsOf(B, T);
	const newSource = effectiveAppLocalization(
		theirs.localization,
	).sourceLanguage;
	const sourceChanged =
		effectiveAppLocalization(B.localization).sourceLanguage !== newSource;
	if (sourceChanged) {
		const stale = staleSourceTranslation(now, newSource);
		if (stale) {
			const language = parseLanguageTag(newSource);
			return {
				kind: "held",
				reason: "stale-source-translation",
				translation: {
					language,
					languageName:
						resolvedLanguageDisplayLabel(language) ?? languageTag(language),
					unitId: stale.id,
					breadcrumb: stale.breadcrumb,
				},
			};
		}
	}
	let H: Mutation[];
	try {
		H = yield* diffDocsToMutationsSteps(B, theirs, HQ_READING_DELTA);
	} catch {
		return differs({
			check: "apply",
			segments: ["threw", "diffDocsToMutations"],
		});
	}
	yield;

	/* 6. The document the changes are applied to. A worker or location property's slug renamed
	 * since the publish is a change Nova holds unpublished though nothing reads it now: a read
	 * CommCare HQ's change adds of the published slug means that property. */
	const givesWay = propertiesGivingWay(ref, now);
	const refK = yield* canonK(ref, givesWay, withheld);
	yield;
	/* The reference is the head itself where nothing was committed since the publish. */
	const nowK = now === ref ? refK : yield* canonK(now, givesWay, withheld);
	yield;
	const unpublished =
		(nowK !== refK && documentDifferences(refK, nowK).length > 0) ||
		slugRenamed(ref, now);
	const appliedTo = unpublished ? "published" : "head";
	let D = unpublished ? ref : now;
	// Recovery is performed on the current draft. The older published
	// reference may still contain its stale copy. Only its wire reading,
	// already checked above, can become the new canonical source.
	if (unpublished && sourceChanged && staleSourceTranslation(ref, newSource)) {
		D = UNFROZEN.produce(ref, (draft) => {
			for (const [id, entry] of Object.entries(
				ref.localization?.translations[newSource] ?? {},
			)) {
				const unit = snapshotTranslationUnits(ref).get(id);
				const into = draft.localization?.translations[newSource];
				if (
					!unit ||
					hasGeneratedWording(unit) ||
					!into ||
					!translationIsOutOfDate(entry, unit)
				)
					continue;
				const text = storedTranslationValue(ref, newSource, unit);
				if (deepEqual(text, unit.source)) delete into[id];
				else
					into[id] = {
						value: structuredClone(text),
						origin: "copied",
						review: "needs-review",
						sourceFingerprint: unit.sourceFingerprint,
						translatedFrom: ref.localization?.sourceLanguage ?? "eng",
					};
			}
		});
	}
	const head = unpublished ? now : null;
	yield;

	/* 7. Narrowed. */
	const Hn = narrowed(H, B, theirs, D);
	yield;

	/* 8 and 9. The target and the take check, then the reader's spelling of what CommCare HQ
	 * changed and once more. */
	let respelled: readonly Uuid[] = [];
	let taken = yield* takeOver(
		D,
		H,
		B,
		theirs,
		head,
		unpublished ? refK : nowK,
		givesWay,
		withheld,
	);
	yield;
	if (!("doc" in taken)) {
		respelled = touchedBy(D, Hn);
		yield;
		const spelled = inReaderSpelling(D, respelled, givesWay, withheld);
		yield;
		/* The spelling is written into the app only where it is the same app. */
		if (!(yield* sameExport(D, spelled)))
			return differs({ check: "respell", segments: ["export-differs"] });
		taken = yield* takeOver(
			spelled,
			H,
			B,
			theirs,
			head,
			null,
			givesWay,
			withheld,
		);
		yield;
		if (!("doc" in taken)) return differs(taken.failure);
	}
	const target = taken.doc;

	/* 10. A rename made in Nova since the reference holds the take back. */
	const renamedInNova = appliedTo === "published" ? input.renamesSince : [];

	/* 11. The batch, replayed over the app as it stands. */
	let batch: readonly Mutation[] = [];
	if (renamedInNova.length === 0) {
		try {
			batch = yield* diffDocsToMutationsSteps(now, target, HQ_READING_DELTA);
		} catch {
			return differs({
				check: "replay",
				segments: ["threw", "diffDocsToMutations"],
			});
		}
		yield;
		const replayed = yield* applied(now, batch, "replay");
		if (!("doc" in replayed)) return differs(replayed.failure);
		yield;
		if (!deepEqual(toPersistableDoc(replayed.doc), toPersistableDoc(target)))
			return differs({
				check: "replay",
				segments: firstDifference(target, replayed.doc) ?? [],
			});
		yield;
	}

	/* 12. The lists and what the take removes of the case data's definitions. CommCare HQ's
	 * list is taken before step 8's additions, which keep declarations made in Nova. */
	const hqChanges = documentChanges(D, taken.hqOnly);
	yield;
	let lost: readonly DocumentDifference[] = [];
	if (appliedTo === "published") {
		const head = toPersistableDoc(now);
		const taken = toPersistableDoc(target);
		lost = documentDifferences(ref, now).filter((change) =>
			removedBy(head, taken, change.path),
		);
	}
	yield;
	const novaChanges = documentChanges(ref, now, lost);
	yield;
	const targetTypes = new Map(
		effectiveCaseTypes(target).map((type) => [type.name, type]),
	);
	const targetHolds = caseTypesHeld(target);
	const removedCaseProperties: { caseType: string; name: string }[] = [];
	const removedCaseTypes = [...caseTypesHeld(now)].filter(
		(name) => !targetHolds.has(name),
	);
	for (const type of effectiveCaseTypes(now)) {
		const kept = targetTypes.get(type.name);
		if (kept === undefined) continue;
		const holds = new Set(kept.properties.map((property) => property.name));
		for (const property of type.properties)
			if (!holds.has(property.name))
				removedCaseProperties.push({
					caseType: type.name,
					name: property.name,
				});
	}

	return {
		kind: "changes",
		appliedTo,
		target,
		batch,
		hqChanges,
		novaChanges,
		respelled,
		removedCaseProperties,
		removedCaseTypes,
		renamedInNova,
		publishChanges: [],
	};
}

// ---------------------------------------------------------------------------
// Steps 1 to 3 and 13
// ---------------------------------------------------------------------------

type Declared = Pick<DeclarationChoice, "split" | "mutations"> & {
	readonly runsOnlyOn: DeclarationChoice["runsOnlyOn"] | null;
};

/**
 * The choice that is the app's own declaration: the one that runs where the
 * reference runs and, where the reference holds the questions a date and
 * time split made, splits; the other split where only it is offered.
 */
function declarationOf<T extends Declared>(
	choices: readonly T[],
	ref: BlueprintDoc,
	refSplit: boolean,
): T | undefined {
	const runs = ref.appSettings.runsOnlyOn ?? null;
	const where = choices.filter(
		(choice) => (choice.runsOnlyOn ?? null) === runs,
	);
	return (
		where.find((choice) => choice.split === refSplit) ??
		where.find((choice) => choice.split !== refSplit)
	);
}

/** Whether the reference holds the questions a split of the reading's date-and-time questions
 *  made: the split's first minted UUID is in the document. */
function holdsSplit(ref: BlueprintDoc, draft: ReadDraft): boolean {
	if (draft.declaration.kind !== "choices") return false;
	return draft.declaration.choices.some(
		(choice) =>
			choice.split &&
			choice.splits.some(
				(split) => ownRecordValue(ref.fields, split.dateUuid) !== undefined,
			),
	);
}

/** The forms of a draft's facts, as the first-publish register takes them. */
function formsOf(draft: ReadDraft): readonly { readonly uuid: Uuid }[] {
	return draft.facts.forms.flatMap((form) => {
		const found = draft.identities.forms.find(
			(one) => one.xmlns === form.xmlns,
		);
		return found === undefined ? [] : [{ uuid: found.uuid }];
	});
}

interface PlanInput {
	readonly baseMediaFiles: readonly AdoptedMediaFile[];
	readonly reference: Extract<ReferenceDocument, { readonly kind: "ok" }>;
	/** The app at the head. */
	readonly now: BlueprintDoc;
	readonly readings: HqChangeReadings;
	/** What `acceptReading` answered for `readings.now`; null where the reading now is an
	 *  account, which acceptance is never asked about. */
	readonly accepted: ReturnType<typeof acceptReading> | null;
}

export function planHqChanges(input: PlanInput): HqChangePlan {
	return drained(planHqChangesSteps(input));
}

/** `planHqChanges` one step at a time, so a caller can let the event loop turn between them. */
export function* planHqChangesSteps(input: PlanInput): Steps<HqChangePlan> {
	const { reference, readings } = input;
	if ((reference as { kind: string }).kind !== "ok")
		throw new Error(NO_REFERENCE((reference as { kind: string }).kind));
	const ref = reference.doc;

	/* 1. Something Nova cannot hold. */
	const nowReading: ReadOutcome = readings.now;
	if (nowReading.kind === "account")
		return { kind: "account", findings: nowReading.findings };

	/* 2. Acceptance of the reading now. */
	if (input.accepted === null)
		throw new Error(
			"Nova was asked to plan a clean reading of CommCare HQ's app that acceptance never judged. `acceptReading` runs on every clean reading now before its plan.",
		);
	if (!input.accepted.ok)
		return {
			kind: "differs",
			check: input.accepted.check,
			signature: input.accepted.signature,
		};

	/* 3. Both readings under the app's declaration. */
	const baseDraft = readings.base.draft;
	const refSplit =
		holdsSplit(ref, baseDraft) || holdsSplit(ref, nowReading.draft);
	const baseChoice = declarationOf(
		baseDraft.declaration.kind === "choices"
			? baseDraft.declaration.choices
			: [],
		ref,
		refSplit,
	);
	const nowChoice = declarationOf<AcceptedDeclaration & Declared>(
		input.accepted.declarations.map((one) => ({
			...one,
			split: one.splitDatetime,
		})),
		ref,
		refSplit,
	);
	if (baseChoice === undefined || nowChoice === undefined)
		return { kind: "held", reason: "runs-elsewhere" };
	const B = under(baseDraft.doc, baseChoice.mutations);
	const T = under(nowReading.draft.doc, nowChoice.mutations);
	yield;

	/* 13. What the next publish changes that it would not have changed before,
	 * each list as a baseline stores it: an id a worker meets on Android alone
	 * by its reading, whatever the declaration, and no Web Apps line. */
	const currentIds = firstPublishListToStore(
		nowChoice.firstPublish,
		nowReading.draft.facts,
	).ids;
	let publishChanges: readonly FirstPublishChangeId[];
	const changedPublishSubjects: FirstPublishChangeId[] = [];
	const changedPublishForms = new Set<string>();
	try {
		const baseFacts = firstPublishFactsOf({
			source: readings.inputs.base.source,
			doc: B,
			facts: baseDraft.facts,
			forms: formsOf(baseDraft),
			attachmentTarget: readings.inputs.base.target,
			mediaFiles: input.baseMediaFiles,
			mediaClaims: readings.baseMediaClaims,
			choice: {
				runsOnlyOn: baseChoice.runsOnlyOn ?? null,
				split: baseChoice.split,
			},
		});
		const baseIds = firstPublishListToStore(
			firstPublishChangesFor(baseFacts),
			baseDraft.facts,
		).ids;
		// The app-wide spelling is unconditional. A physical file has its own
		// prospective import comparison, using target paths and upload receipts.
		const compared = currentIds.filter(
			(id) =>
				id !== "forms-and-settings-rewritten" &&
				id !== "unused-media-entries-removed",
		);
		const prior = publishChangeSubjects(
			baseFacts,
			compared.filter((id) => baseIds.includes(id)),
		);
		const next = publishChangeSubjects(nowChoice.firstPublishFacts, compared);
		const forms = new Map<string, string | undefined>(
			[...nowChoice.firstPublishFacts.formPositions].map(([uuid, position]) => [
				position,
				T.forms[uuid]?.name,
			]),
		);
		for (const id of compared) {
			for (const [subject, place] of next.get(id) ?? []) {
				if (prior.get(id)?.has(subject)) continue;
				if (!changedPublishSubjects.includes(id))
					changedPublishSubjects.push(id);
				const [root, position] = placeSteps(place);
				const name = root === "form" ? forms.get(position) : null;
				if (name) changedPublishForms.add(name);
			}
		}
		publishChanges = currentIds.filter(
			(id) =>
				id !== "forms-and-settings-rewritten" &&
				(!baseIds.includes(id) || changedPublishSubjects.includes(id)),
		);
	} catch {
		return differs({
			check: "apply",
			segments: ["threw", "firstPublishChangesFor"],
		});
	}

	yield;

	/* 4 to 12. */
	const plan = yield* planFromDocumentsSteps({
		ref,
		now: input.now,
		base: B,
		theirs: T,
		renamesSince: reference.renamesSince,
	});
	return plan.kind === "nothing" || plan.kind === "changes"
		? {
				...plan,
				publishChanges,
				...(changedPublishSubjects.length
					? {
							changedPublishSubjects,
							changedPublishForms: [...changedPublishForms].sort(),
						}
					: {}),
			}
		: plan;
}
