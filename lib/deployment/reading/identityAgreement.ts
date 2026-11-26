/**
 * Identity agreement: publishing a reading's document back changes no
 * identity a runtime, CommCare HQ's servers or the data a project holds read
 * by. Both sides are extracted the same way, from an application's JSON and
 * its forms' XML (`lib/commcare/hq/sourceIdentity.ts`, the extended
 * `publishedCaseBlocks`, `hqEntryFacts`), with no build and no reader module,
 * and compared.
 *
 * Three things are taken on the reader's word, each bounded here: which
 * leaves are generated nodes (each side is cut by its own list, a cut path
 * that is no leaf of its side is a difference, and a cut leaf of CommCare HQ's
 * side that holds a body control must be one the emission writes, for the
 * same owner, with that control), which appearances it accounted
 * as inert (cut from CommCare HQ's side only, and never one of the four
 * appearances Nova writes), and where the case region stands (each scope's
 * `nova_operations` group, its other containers and every Save to Case block,
 * which is compared as the case blocks it holds, never leaf by leaf). A leaf
 * or a container the reader's region alone cuts from CommCare HQ's side must
 * be case scaffolding the emission writes too: a leaf with no control that the
 * emission cuts as its own region's or a generated node, a container of the
 * same kind with no appearance that the emission's region cuts. Anything else
 * is a difference, so a question taken for scaffolding or for a generated
 * node is never dropped unseen.
 *
 * Pure.
 */

import type { HqApplication } from "@/lib/commcare";
import { emissionPlan } from "@/lib/commcare/emissionPlan";
import {
	holdsQuestionAppearance,
	sameQuestionAppearance,
} from "@/lib/commcare/hq/appearanceIdentity";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import {
	entryFactsDifference,
	hqEntryFacts,
	menuFactsDifference,
} from "@/lib/commcare/hq/entryFacts";
import {
	type PublishedCaseBlock,
	type PublishedForm,
	publishedCaseBlocks,
} from "@/lib/commcare/hq/publishedCaseBlocks";
import {
	type AnswerLeaf,
	type ContainerIdentity,
	type FormIdentity,
	type SourceIdentity,
	sourceIdentity,
} from "@/lib/commcare/hq/sourceIdentity";
import { languagesPlace } from "@/lib/commcare/reader/place";
import type { ReadDraft, ReadGeneratedNode } from "@/lib/commcare/reader/types";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import { collectFieldLocations } from "@/lib/commcare/xform/caseOps";
import {
	descendFormPathIntoField,
	FormPath,
} from "@/lib/commcare/xform/formPath";
import { planGeneratedNodes } from "@/lib/commcare/xform/generatedNodes";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { recordFromEntries } from "@/lib/domain/records";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import type { AcceptanceDifference } from "./acceptance";
import { servedEmission } from "./emission";
import { emittedGeneratedNodes } from "./firstPublishChanges";
import { differenceSignature } from "./signature";
import { type SourcePlaces, sourcePlaces } from "./sourcePlaces";

export interface IdentityAgreementInput {
	readonly source: HqAppSource;
	/** `readingEmission` over `draft.doc`. */
	readonly emission: HqApplication;
	/** The reading's draft: its document, its facts and its identities. */
	readonly draft: ReadDraft;
	/** The project space the emission is written for (`ReaderInput.target`): a link's node is
	 *  written only where a target is known, so the emission's generated nodes follow it. */
	readonly attachmentTarget: AttachmentUrlTarget;
	/** Whether the source project space applies "save only if changed"
	 *  (`ReaderInput.saveOnlyEditedApplied`). Where it does not, HQ's build writes a write stored
	 *  `edit` as one saved every time (`xform.py::XForm.save_only_if_edited`), so neither side's
	 *  `editOnly` is compared; absent where the source holds no `edit`. */
	readonly saveOnlyEditedApplied?: boolean;
}

export interface IdentityAgreement {
	readonly differences: readonly AcceptanceDifference[];
	/** `sourceIdentity` of the source, which the summary check reads `written` from. */
	readonly sourceIdentity: SourceIdentity;
}

/** The purposes whose node a case change names in place of its owner question. */
const SIBLING_PURPOSES: ReadonlySet<string> = new Set([
	"trimmed",
	"datetime",
	"url",
]);

const LEAF_KEYS = [
	"repeats",
	"control",
	"typeClass",
	"mediatype",
	"appearance",
	"choices",
	"itemset",
] as const satisfies readonly (keyof AnswerLeaf)[];

const CONTAINER_KEYS = [
	"kind",
	"appearance",
	"counted",
] as const satisfies readonly (keyof ContainerIdentity)[];

/** Each source's application JSON, made once: acceptance asks for it in more than one check,
 *  and nothing writes to a source or to the JSON made of it. */
const sourceApplications = new WeakMap<HqAppSource, Record<string, unknown>>();

/** The application JSON a source read gives, with each form's XML under `<readUniqueId>.xml`.
 *  One object per source, which no caller writes to. */
export function sourceApplication(
	source: HqAppSource,
): Record<string, unknown> {
	const known = sourceApplications.get(source);
	if (known !== undefined) return known;
	const made = madeSourceApplication(source);
	sourceApplications.set(source, made);
	return made;
}

function madeSourceApplication(source: HqAppSource): Record<string, unknown> {
	const held = source.raw._attachments;
	const attachments = recordFromEntries(
		typeof held === "object" && held !== null && !Array.isArray(held)
			? Object.entries(held as Record<string, unknown>)
			: [],
	);
	for (const menu of source.modules)
		for (const form of menu.forms)
			if (form.attachment !== null)
				attachments[`${form.readUniqueId}.xml`] = form.attachment;
	return { ...source.raw, _attachments: attachments };
}

/** Each `xmlns`'s first entry of `entries`. */
function firstByXmlns<T extends { readonly xmlns: string }>(
	entries: readonly T[],
): ReadonlyMap<string, T> {
	const first = new Map<string, T>();
	for (const entry of entries)
		if (!first.has(entry.xmlns)) first.set(entry.xmlns, entry);
	return first;
}

/** Two JSON values as one: key order never matters. */
function same(a: unknown, b: unknown): boolean {
	return canonicalJsonText(a ?? null) === canonicalJsonText(b ?? null);
}

/** Whether `path` stands at or under one of `roots`. */
function inRegion(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** A worker or editor reads this appearance. A reader cannot waive it as inert. */
export const holdsNovaAppearance = holdsQuestionAppearance;

/** The case region of a form Nova writes: each authored scope's three containers. */
function emittedCaseRegion(doc: BlueprintDoc, formUuid: Uuid): string[] {
	const wireDoc = emissionPlan(doc).doc;
	const plan = planGeneratedNodes(wireDoc, formUuid);
	const scopes = [FormPath.root()];
	for (const [uuid, location] of collectFieldLocations(wireDoc, formUuid)) {
		const field = wireDoc.fields[uuid];
		if (field?.kind === "repeat")
			scopes.push(descendFormPathIntoField(field, location.path));
	}
	return scopes.flatMap((scope) => [
		scope.child(plan.operations(scope)).toXPath(),
		scope.child(plan.subcases(scope)).toXPath(),
		scope.child(plan.selectedCases(scope)).toXPath(),
	]);
}

/** One side of a form as the comparison takes it. */
interface FormSide {
	readonly identity: FormIdentity;
	/** Generated leaves, by path. */
	readonly generated: ReadonlyMap<string, ReadGeneratedNode>;
	readonly region: readonly string[];
}

/** A side's answer leaves: every leaf but its generated ones and its case region's. */
function answerLeaves(side: FormSide): Map<string, AnswerLeaf> {
	const kept = new Map<string, AnswerLeaf>();
	for (const [path, leaf] of side.identity.leaves)
		if (!side.generated.has(path) && !inRegion(path, side.region))
			kept.set(path, leaf);
	return kept;
}

/**
 * A side's authored containers: outside its case region, and holding an
 * appearance, or a repeat, or holding an answer leaf of its own.
 */
function authoredContainers(
	side: FormSide,
	containers: ReadonlyMap<string, ContainerIdentity>,
	leaves: ReadonlyMap<string, AnswerLeaf>,
): Map<string, ContainerIdentity> {
	const kept = new Map<string, ContainerIdentity>();
	for (const [path, container] of containers) {
		if (inRegion(path, side.region)) continue;
		const holdsLeaf = [...leaves.keys()].some((leaf) =>
			leaf.startsWith(`${path}/`),
		);
		if (
			container.appearance !== null ||
			container.kind === "repeat" ||
			holdsLeaf
		)
			kept.set(path, container);
	}
	return kept;
}

/** A case block's key within its form: what two sides' blocks are matched on. */
function blockKey(block: PublishedCaseBlock): string {
	switch (block.kind) {
		case "basic-own":
			return "own";
		case "basic-usercase":
			return "usercase";
		case "basic-subcase":
			return `subcase ${block.index}`;
		case "advanced":
			return `advanced ${block.tag}`;
		case "save-to-case":
			return `save-to-case ${block.path}`;
	}
}

/**
 * A block's members as the comparison reads them: a question path a case
 * change names through a generated sibling is its owner question's, and the
 * own block of a form that does not open its case states its condition as
 * `always`, since Case Management reads `never` and `if` there as the same
 * state on every shape the reader holds. Its writes saved only if changed are none where
 * `editApplied` is false: the project space builds every write as saved every time.
 */
function comparableBlock(
	block: PublishedCaseBlock,
	ownerOf: (path: string) => string,
	editApplied: boolean,
): Readonly<Record<string, unknown>> {
	const properties = (map: ReadonlyMap<string, string>) =>
		[...map]
			.map(([key, path]) => [key, ownerOf(path)])
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const sorted = (set: ReadonlySet<string>) =>
		editApplied ? [...set].sort() : [];
	switch (block.kind) {
		case "basic-own":
			return {
				caseType: block.caseType,
				opens: block.opens,
				closes: block.closes,
				condition: block.opens ? block.condition : { type: "always" },
				closeCondition: block.closeCondition,
				sessionDatum: block.sessionDatum,
				ownerWritten: block.ownerWritten,
				properties: properties(block.properties),
				editOnly: sorted(block.editOnly),
			};
		case "basic-usercase":
			return {
				properties: properties(block.properties),
				editOnly: sorted(block.editOnly),
			};
		case "basic-subcase":
			return {
				repeatContext: block.repeatContext,
				caseType: block.caseType,
				condition: block.condition,
				closeCondition: block.closeCondition,
				indices: block.indices,
				ownerWritten: block.ownerWritten,
				properties: properties(block.properties),
				editOnly: sorted(block.editOnly),
			};
		case "advanced":
			// The repeat an open action's block stands in, and whether it nests
			// under its own element there, is said by its path alone.
			return {
				action: block.action,
				path: block.path,
				caseType: block.caseType,
				condition: block.condition,
				closeCondition: block.closeCondition,
				indices: block.indices,
				ownerWritten: block.ownerWritten,
				properties: properties(block.properties),
				editOnly: sorted(block.editOnly),
			};
		case "save-to-case":
			return {
				caseType: block.caseType,
				actions: block.actions,
				indices: block.indices,
				properties: block.properties,
			};
	}
}

/** `path` read as its owner question where `generated` names it a case change's sibling. */
function siblingOwners(
	generated: ReadonlyMap<string, ReadGeneratedNode>,
): (path: string) => string {
	return (path) => {
		const node = generated.get(path);
		return node !== undefined && SIBLING_PURPOSES.has(node.purpose)
			? node.owner
			: path;
	};
}

/**
 * Where publishing a reading's document back would change an identity of
 * CommCare HQ's source, in order: forms either side leaves out, the
 * languages, the menus, each form's ids, answer leaves, containers, control
 * order and case blocks, and the facts CommCare HQ's entry builder reads.
 */
export function identityDifferences(
	input: IdentityAgreementInput,
): IdentityAgreement {
	const steps = identityDifferencesSteps(input);
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

/**
 * `identityDifferences` a part at a time: it stops after the emission is
 * served and after each of the four reads of the two applications' forms,
 * until it is resumed, so a caller on a request can let the event loop turn
 * while an app at the bring-in byte cap is compared. The agreement is
 * `identityDifferences`', which drives this.
 */
export function* identityDifferencesSteps(
	input: IdentityAgreementInput,
): Generator<void, IdentityAgreement, void> {
	const places = sourcePlaces(input.source);
	const sourceApp = sourceApplication(input.source);
	const emitted = servedEmission(input.emission);
	yield;
	const A = sourceIdentity(sourceApp);
	yield;
	const E = sourceIdentity(emitted);
	yield;
	const blocksA = publishedCaseBlocks(sourceApp);
	yield;
	const blocksE = publishedCaseBlocks(emitted);
	yield;
	const differences: AcceptanceDifference[] = [];
	const differ = (
		segments: readonly string[],
		place: HqPlace,
		detail: string,
	): void => {
		differences.push({
			check: "identity",
			signature: differenceSignature("identity", segments),
			place,
			detail,
		});
	};

	// 1. Forms either side leaves out, one difference per form and reason.
	const unread = (
		lists: readonly (readonly {
			readonly menu: number;
			readonly form: number;
			readonly reason: string;
		}[])[],
		word: string,
	) => {
		const seen = new Set<string>();
		for (const list of lists)
			for (const one of list) {
				const key = `${one.menu} ${one.form} ${one.reason}`;
				if (seen.has(key)) continue;
				seen.add(key);
				differ(
					[word, one.reason],
					places.formAt(one.menu, one.form),
					`form ${one.form} of menu ${one.menu} is left out: ${one.reason}`,
				);
			}
	};
	unread([A.unread, blocksA.unread], "unread");
	unread([E.unread, blocksE.unread], "emission-unread");

	// 2. The languages.
	if (!same(A.languages, E.languages))
		differ(
			["languages"],
			languagesPlace(),
			`languages ${A.languages.join(",")} became ${E.languages.join(",")}`,
		);

	// 3. The menus, position by position.
	for (
		let index = 0;
		index < Math.max(A.menus.length, E.menus.length);
		index++
	) {
		const a = A.menus[index];
		const e = E.menus[index];
		if (a === undefined || e === undefined) {
			differ(
				["menu", a === undefined ? "added" : "missing"],
				places.menu(index),
				`menu ${index} is on one side alone`,
			);
			continue;
		}
		for (const key of ["uniqueId", "docType", "caseType", "forms"] as const)
			if (!same(a[key], e[key]))
				differ(
					["menu", key],
					places.menu(index),
					`menu ${index} ${key}: ${JSON.stringify(a[key])} became ${JSON.stringify(e[key])}`,
				);
	}

	// 4 to 8. Each form.
	const doc = input.draft.doc;
	/* The first of each `xmlns` in the draft's lists, as a search of each finds it. */
	const factsOf = firstByXmlns(input.draft.facts.forms);
	const identityOf = firstByXmlns(
		input.draft.identities.forms.filter(
			(form) => !doc.forms[form.uuid]?.shadowOf,
		),
	);
	for (const [xmlns, a] of A.forms) {
		const formPlace = places.formOf(xmlns);
		const e = E.forms.get(xmlns);
		if (e === undefined) {
			differ(["form", "missing"], formPlace, `form ${xmlns} is not written`);
			continue;
		}
		for (const key of ["dataNamespace", "docType", "uniqueId"] as const)
			if (a[key] !== e[key])
				differ(
					["form", key],
					formPlace,
					`form ${xmlns} ${key}: ${a[key]} became ${e[key]}`,
				);
		for (const side of [a, e])
			if (side.dataNamespace !== side.xmlns)
				differ(
					["form", "dataNamespace"],
					formPlace,
					`form ${xmlns} holds its data under ${side.dataNamespace}`,
				);

		const facts = factsOf.get(xmlns);
		const formUuid = identityOf.get(xmlns)?.uuid;
		const sideA: FormSide = {
			identity: a,
			generated: new Map(
				(facts?.generated ?? []).map((node) => [node.path, node]),
			),
			region: facts?.caseRegionPaths ?? [],
		};
		const sideE: FormSide = {
			identity: e,
			generated: new Map(
				formUuid === undefined
					? []
					: (
							emittedGeneratedNodes(
								doc,
								[{ uuid: formUuid }],
								input.attachmentTarget,
							)[0] ?? []
						).map((node) => [node.path, node]),
			),
			region: formUuid === undefined ? [] : emittedCaseRegion(doc, formUuid),
		};
		formDifferences({
			xmlns,
			places,
			sideA,
			sideE,
			inert: (facts?.inertAppearances ?? []).map((path) =>
				path.startsWith("/") ? path : `/data/${path}`,
			),
			differ,
		});
		const publishedA = blocksA.forms.get(xmlns);
		const publishedE = blocksE.forms.get(xmlns);
		if (publishedA !== undefined && publishedE !== undefined)
			caseBlockDifferences(
				publishedA,
				publishedE,
				siblingOwners(sideA.generated),
				siblingOwners(sideE.generated),
				input.saveOnlyEditedApplied !== false,
				(segments, detail) => differ(segments, formPlace, detail),
			);
	}
	for (const xmlns of E.forms.keys())
		if (!A.forms.has(xmlns))
			differ(["form", "added"], places.app, `form ${xmlns} is written`);

	// 9. What CommCare HQ's entry builder is handed.
	const factsA = hqEntryFacts(sourceApp);
	const factsE = hqEntryFacts(emitted);
	for (const [id, a] of factsA.menus) {
		const e = factsE.menus.get(id);
		const key = e === undefined ? "missing" : menuFactsDifference(a, e);
		if (key !== undefined)
			differ(
				["entry-menu", key],
				places.menuOfId(id),
				`menu ${id} entry fact ${key}`,
			);
	}
	for (const id of factsE.menus.keys())
		if (!factsA.menus.has(id))
			differ(["entry-menu", "added"], places.app, `menu ${id} is written`);
	const entries = new Map(
		input.source.modules.flatMap((menu, menuIndex) =>
			menu.forms.map(
				(form, formIndex) =>
					[
						form.readUniqueId,
						{ form, place: places.formAt(menuIndex, formIndex) },
					] as const,
			),
		),
	);
	for (const [entryId, stored] of factsA.forms) {
		const e = factsE.forms.get(entryId);
		const entry = entries.get(entryId);
		const xmlns = entry?.form.xmlns;
		// Child cases the reading dropped as no change of a case (`ReadFacts.childCasesUnread`).
		const a =
			e !== undefined &&
			typeof xmlns === "string" &&
			input.draft.facts.childCasesUnread.includes(xmlns)
				? { ...stored, newChildCases: e.newChildCases }
				: stored;
		const key = e === undefined ? "missing" : entryFactsDifference(a, e);
		if (key !== undefined)
			differ(
				["entry", key],
				entry?.place ?? places.app,
				`form ${entryId} entry fact ${key}`,
			);
	}
	for (const id of factsE.forms.keys())
		if (!factsA.forms.has(id))
			differ(["entry", "added"], places.app, `form ${id} is written`);

	return { differences, sourceIdentity: A };
}

/** Rows 5 to 7 over one form: answer leaves, authored containers, control order. */
function formDifferences(input: {
	readonly xmlns: string;
	readonly places: SourcePlaces;
	readonly sideA: FormSide;
	readonly sideE: FormSide;
	readonly inert: readonly string[];
	readonly differ: (
		segments: readonly string[],
		place: HqPlace,
		detail: string,
	) => void;
}): void {
	const { xmlns, places, sideA, sideE, differ } = input;
	const at = (path: string) => places.questionOf(xmlns, path);

	// Nothing but a generated node is cut: each cut path is a leaf of its side.
	for (const side of [sideA, sideE])
		for (const path of side.generated.keys())
			if (!side.identity.leaves.has(path))
				differ(
					["generated", "phantom"],
					at(path),
					`${path} is cut as a generated node and is no answer leaf`,
				);

	generatedControlDifferences(sideA, sideE, at, differ);
	regionDifferences(sideA, sideE, at, differ);

	const leavesA = answerLeaves(sideA);
	const leavesE = answerLeaves(sideE);
	const containersA = new Map(sideA.identity.containers);

	// An appearance the reader accounted as inert is cut from CommCare HQ's
	// side, unless it is one Nova writes.
	for (const path of input.inert) {
		const leaf = leavesA.get(path);
		const container = containersA.get(path);
		for (const record of [leaf, container]) {
			if (record === undefined || record.appearance === null) continue;
			if (holdsNovaAppearance(record)) {
				differ(
					["appearance", "inert-held"],
					at(path),
					`${path}'s appearance ${record.appearance} is one Nova writes`,
				);
				continue;
			}
			if (record === leaf) leavesA.set(path, { ...leaf, appearance: null });
			else
				containersA.set(path, {
					...(record as ContainerIdentity),
					appearance: null,
				});
		}
	}

	for (const [path, a] of leavesA) {
		const e = leavesE.get(path);
		if (e === undefined) {
			differ(["leaf", "missing"], at(path), `${path} is not written`);
			continue;
		}
		const key = LEAF_KEYS.find((one) =>
			one === "appearance"
				? !sameQuestionAppearance(a, e)
				: !same(a[one], e[one]),
		);
		if (key !== undefined)
			differ(
				["leaf", key],
				at(path),
				`${path} ${key}: ${JSON.stringify(a[key])} became ${JSON.stringify(e[key])}`,
			);
	}
	for (const path of leavesE.keys())
		if (!leavesA.has(path))
			differ(["leaf", "added"], at(path), `${path} is written`);

	const authoredA = authoredContainers(sideA, containersA, leavesA);
	const authoredE = authoredContainers(
		sideE,
		sideE.identity.containers,
		leavesE,
	);
	for (const [path, a] of authoredA) {
		const e = authoredE.get(path);
		if (e === undefined) {
			differ(["container", "missing"], at(path), `${path} is not written`);
			continue;
		}
		const key = CONTAINER_KEYS.find((one) =>
			one === "appearance"
				? !sameQuestionAppearance(a, e)
				: !same(a[one], e[one]),
		);
		if (key !== undefined)
			differ(
				["container", key],
				at(path),
				`${path} ${key}: ${JSON.stringify(a[key])} became ${JSON.stringify(e[key])}`,
			);
	}
	for (const path of authoredE.keys())
		if (!authoredA.has(path))
			differ(["container", "added"], at(path), `${path} is written`);

	const orderA = sideA.identity.order.filter((path) => leavesA.has(path));
	const orderE = sideE.identity.order.filter((path) => leavesE.has(path));
	if (!same(orderA, orderE))
		differ(
			["order"],
			places.formOf(xmlns),
			`controls ${orderA.join(" ")} became ${orderE.join(" ")}`,
		);
}

/**
 * The bound on a generated node the reader names for CommCare HQ's side that
 * a worker meets. Nova writes most generated nodes with no control, and the
 * one it gives a control (a protected validation message's carrier, an
 * `input`) it writes again for the same question. So a leaf of CommCare HQ's
 * side that its generated list cuts and that holds a body control must be
 * matched on the emission's side by a generated node of the same purpose and
 * owner whose leaf holds the same control, wherever its name now stands.
 */
function generatedControlDifferences(
	sideA: FormSide,
	sideE: FormSide,
	at: (path: string) => HqPlace,
	differ: (segments: readonly string[], place: HqPlace, detail: string) => void,
): void {
	for (const [path, node] of sideA.generated) {
		const leaf = sideA.identity.leaves.get(path);
		if (leaf === undefined || leaf.control === "none") continue;
		const written = [...sideE.generated].some(
			([emitted, one]) =>
				one.purpose === node.purpose &&
				one.owner === node.owner &&
				sideE.identity.leaves.get(emitted)?.control === leaf.control,
		);
		if (!written)
			differ(
				["generated", "control"],
				at(path),
				`${path} is cut as a generated node and holds a ${leaf.control} control the emission writes for no ${node.purpose} node of ${node.owner}`,
			);
	}
}

/**
 * The bound on the case region the reader names for CommCare HQ's side. The
 * reader takes a node for case scaffolding only where it holds no answer: its
 * leaves have no control, and its containers are bare groups and their
 * repeats. Nova's emission of the same operations writes that scaffolding at
 * the same paths, its placements held. So a leaf the reader's region alone
 * cuts must have no control and be cut on the emission's side too, by its
 * region or as a generated node; and a container it alone cuts must hold no
 * appearance and stand in the emission's region with the same kind.
 */
function regionDifferences(
	sideA: FormSide,
	sideE: FormSide,
	at: (path: string) => HqPlace,
	differ: (segments: readonly string[], place: HqPlace, detail: string) => void,
): void {
	const cutOnE = (path: string) =>
		sideE.generated.has(path) || inRegion(path, sideE.region);
	for (const [path, leaf] of sideA.identity.leaves) {
		if (sideA.generated.has(path) || !inRegion(path, sideA.region)) continue;
		if (leaf.control !== "none") {
			differ(
				["region", "control"],
				at(path),
				`${path} is cut as case scaffolding and holds a ${leaf.control} control`,
			);
			continue;
		}
		if (!sideE.identity.leaves.has(path) || !cutOnE(path))
			differ(
				["region", "phantom"],
				at(path),
				`${path} is cut as case scaffolding and the emission writes it as no scaffolding`,
			);
	}
	for (const [path, container] of sideA.identity.containers) {
		if (!inRegion(path, sideA.region)) continue;
		const emitted = sideE.identity.containers.get(path);
		if (
			container.appearance !== null ||
			emitted === undefined ||
			emitted.kind !== container.kind ||
			!inRegion(path, sideE.region)
		)
			differ(
				["region", "container"],
				at(path),
				`${path} is cut as case scaffolding and the emission writes it as no scaffolding`,
			);
	}
}

/** Row 8 over one form: the same blocks, matched by kind and place, with the same members. */
function caseBlockDifferences(
	a: PublishedForm,
	e: PublishedForm,
	ownerA: (path: string) => string,
	ownerE: (path: string) => string,
	editApplied: boolean,
	differ: (segments: readonly string[], detail: string) => void,
): void {
	const byKey = (form: PublishedForm) =>
		new Map(form.blocks.map((block) => [blockKey(block), block]));
	const blocksA = byKey(a);
	const blocksE = byKey(e);
	for (const [key, block] of blocksA) {
		const other = blocksE.get(key);
		if (other === undefined) {
			differ(["case-blocks", block.kind, "missing"], `${key} is not written`);
			continue;
		}
		const left = comparableBlock(block, ownerA, editApplied);
		const right = comparableBlock(other, ownerE, editApplied);
		for (const member of Object.keys(left))
			if (!same(left[member], right[member]))
				differ(
					["case-blocks", block.kind, member],
					`${key} ${member}: ${JSON.stringify(left[member])} became ${JSON.stringify(right[member])}`,
				);
	}
	for (const [key, block] of blocksE)
		if (!blocksA.has(key))
			differ(["case-blocks", block.kind, "added"], `${key} is written`);
	if (!same([...a.modelIterationRows].sort(), [...e.modelIterationRows].sort()))
		differ(
			["case-blocks", "modelIterationRows"],
			`model-iteration rows ${a.modelIterationRows.join(" ")} became ${e.modelIterationRows.join(" ")}`,
		);
}
