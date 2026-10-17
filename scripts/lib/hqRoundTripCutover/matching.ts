/**
 * The cutover's matcher: which of Nova's menus and forms each menu and form
 * CommCare HQ holds for a deployment is, so an existing project space keeps
 * its menu ids, form ids and `xmlns` (part 10 of step 2's plan, "The
 * matching algorithm"). No id pairs them: a pre-step publish drew fresh ones
 * on every upload. Pure: HQ's two reads and Nova's walked documents in, pairs
 * and identity rows out.
 *
 * Two paths, and a deployment takes the first whenever it can:
 *
 *   1. By the published document. HQ's copy is that document's, in its
 *      order, when it agrees with it position for position, so menu `i` is the
 *      published menu `i` and its form `j` the published form `j`. Each pair
 *      is carried to today's document by uuid. Nothing is weighed.
 *   2. By evidence. Where no published document can be had, or HQ's copy is
 *      no longer what it sent, pairs rest on names, case types and question
 *      paths through six stages, each settled by one deciding rule, and on
 *      nothing positional.
 *
 * The HQ side reads each form's XForm from the source read's attachments,
 * under the key that response's own form id names, and collects the path of
 * every element with no element child under the instance's root, after
 * dropping what the pre-step emitter added that no Nova question holds: a
 * subtree whose root's name starts with `__nova_`, a Connect block's subtree
 * (by its namespace declaration) with a block element that holds only such
 * subtrees, and, against a given Nova form, a generated `nova_count_` or
 * `nova_constraint_message_` leaf that form does not hold. The four literals
 * are this module's own: the tree's emitter no longer spells them as the
 * pre-step emitter did, and HQ holds forms from before the step.
 */

import { isTag, type Element as XmlElement } from "domhandler";
import { derivedFormXmlns, derivedUniqueId } from "@/lib/commcare/wireIdentity";
import { parseXml } from "@/lib/commcare/xmlParse";
import { asUuid } from "@/lib/domain";
import type { QuestionPathMenu } from "./questionPaths";

/** The one Connect namespace the pre-step emitter declared on a block. */
const CONNECT_XMLNS = "http://commcareconnect.com/data/v1/learn";
/** The prefix the pre-step emitter gave every node it added to a form. */
const NOVA_NODE_PREFIX = "__nova_";
/** The generated leaves a form's own questions may lack. */
const GENERATED_LEAF_PREFIXES = ["nova_count_", "nova_constraint_message_"];

// ── HQ's side ───────────────────────────────────────────────────────

/** One leaf of an HQ form's instance. */
export interface HqPath {
	readonly path: string;
	/** A generated `nova_count_` or `nova_constraint_message_` leaf. */
	readonly generated: boolean;
}

export interface HqSideForm {
	readonly position: number;
	readonly xmlns: string;
	/** The source read's minted id: a key into that read only. */
	readonly readUniqueId: string;
	/** The texts of the form's `name`, one per language. */
	readonly names: readonly string[];
	readonly paths: readonly HqPath[];
}

export interface HqSideMenu {
	readonly position: number;
	readonly uniqueId: string;
	/** The empty string where HQ holds none. */
	readonly caseType: string;
	readonly names: readonly string[];
	readonly forms: readonly HqSideForm[];
}

/** What `readHqAppSource` gives that the matcher reads. */
export interface HqSourceForMatching {
	readonly modules: readonly {
		readonly uniqueId: string;
		readonly caseType: string;
		readonly forms: readonly {
			readonly xmlns: string;
			readonly readUniqueId: string;
			readonly attachment: string | null;
		}[];
	}[];
	readonly raw: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** HQ holds a `name` as one text per language; none where it is no object. */
function nameTexts(value: unknown): string[] {
	if (!isRecord(value)) return [];
	return Object.values(value).filter(
		(text): text is string => typeof text === "string",
	);
}

function childElements(element: XmlElement): XmlElement[] {
	return element.children.filter(isTag);
}

function localName(name: string): string {
	const colon = name.indexOf(":");
	return colon < 0 ? name : name.slice(colon + 1);
}

function findElement(
	elements: readonly XmlElement[],
	name: string,
): XmlElement | undefined {
	for (const element of elements) {
		if (localName(element.name) === name) return element;
		const found = findElement(childElements(element), name);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * Every leaf path of a form's instance, each starting at the instance root's
 * own name (`/data/...`), with the pre-step emitter's added subtrees dropped.
 * A leaf is an element with no element child once those are dropped.
 */
export function collectHqPaths(xform: string): HqPath[] {
	const document = parseXml(xform);
	const model = findElement(document.children.filter(isTag), "model");
	const instance =
		model === undefined
			? undefined
			: childElements(model).find(
					(element) => localName(element.name) === "instance",
				);
	const root = instance === undefined ? undefined : childElements(instance)[0];
	if (root === undefined) return [];
	const rootPath = `/${root.name}`;
	// The root itself is never a leaf: a form with no question holds none.
	return collectUnder(root, rootPath).paths.filter(
		(entry) => entry.path !== rootPath,
	);
}

/**
 * The leaves under one element. A child whose name starts with `__nova_` and
 * a child that declares the Connect namespace are dropped with their
 * subtrees, and so is an element every one of whose children was dropped as
 * a Connect block; an element left with no element child is a leaf.
 */
function collectUnder(
	element: XmlElement,
	path: string,
): { readonly dropped: boolean; readonly paths: HqPath[] } {
	const children = childElements(element);
	const paths: HqPath[] = [];
	let kept = 0;
	let droppedAsConnect = 0;
	for (const child of children) {
		if (child.name.startsWith(NOVA_NODE_PREFIX)) continue;
		if (child.attribs.xmlns === CONNECT_XMLNS) {
			droppedAsConnect += 1;
			continue;
		}
		const under = collectUnder(child, `${path}/${child.name}`);
		if (under.dropped) {
			droppedAsConnect += 1;
			continue;
		}
		kept += 1;
		paths.push(...under.paths);
	}
	if (kept > 0) return { dropped: false, paths };
	if (children.length > 0 && droppedAsConnect === children.length) {
		return { dropped: true, paths: [] };
	}
	return { dropped: false, paths: [leaf(element.name, path)] };
}

function leaf(name: string, path: string): HqPath {
	return {
		path,
		generated: GENERATED_LEAF_PREFIXES.some((prefix) =>
			name.startsWith(prefix),
		),
	};
}

/** HQ's menus and forms from one source read, in its order. */
export function hqSideOf(source: HqSourceForMatching): HqSideMenu[] {
	const rawModules = Array.isArray(source.raw.modules)
		? source.raw.modules
		: [];
	return source.modules.map((module, position) => {
		const rawModule = rawModules[position];
		const rawForms =
			isRecord(rawModule) && Array.isArray(rawModule.forms)
				? rawModule.forms
				: [];
		return {
			position,
			uniqueId: module.uniqueId,
			caseType: module.caseType,
			names: nameTexts(isRecord(rawModule) ? rawModule.name : undefined),
			forms: module.forms.map((form, formPosition) => {
				const rawForm = rawForms[formPosition];
				return {
					position: formPosition,
					xmlns: form.xmlns,
					readUniqueId: form.readUniqueId,
					names: nameTexts(isRecord(rawForm) ? rawForm.name : undefined),
					paths:
						form.attachment === null ? [] : collectHqPaths(form.attachment),
				};
			}),
		};
	});
}

// ── The facts ───────────────────────────────────────────────────────

/** An HQ form's paths as they stand against one Nova form. */
export function effectiveHqPaths(
	hq: readonly HqPath[],
	novaPaths: readonly string[],
): Set<string> {
	const nova = new Set(novaPaths);
	return new Set(
		hq
			.filter((entry) => !entry.generated || nova.has(entry.path))
			.map((entry) => entry.path),
	);
}

/** The paths fact between an HQ form and a Nova form. */
export function pathsFact(
	hq: readonly HqPath[],
	novaPaths: readonly string[],
): {
	readonly holds: boolean;
	readonly shared: number;
	readonly apart: number;
} {
	const effective = effectiveHqPaths(hq, novaPaths);
	const nova = new Set(novaPaths);
	let shared = 0;
	for (const path of effective) if (nova.has(path)) shared += 1;
	const apart = effective.size - shared + (nova.size - shared);
	return { holds: shared * 2 > effective.size, shared, apart };
}

/** The name fact: a Nova name that is not empty and is one of HQ's texts. */
export function nameFact(
	novaName: string,
	hqNames: readonly string[],
): boolean {
	return novaName !== "" && hqNames.includes(novaName);
}

/** HQ's case type, where it is not empty, must be the Nova menu's. */
function caseTypeContradicts(hq: HqSideMenu, nova: QuestionPathMenu): boolean {
	return hq.caseType !== "" && hq.caseType !== (nova.caseType ?? "");
}

function caseTypeHolds(hq: HqSideMenu, nova: QuestionPathMenu): boolean {
	return hq.caseType !== "" && hq.caseType === nova.caseType;
}

// ── Results ─────────────────────────────────────────────────────────

/** Why an entity of today's document is left without a pair. */
export type UnpairedCause =
	| { readonly kind: "tie"; readonly stage: number }
	| { readonly kind: "contest" }
	| { readonly kind: "no-candidate" }
	/** Its HQ id is another entity's derived id, so none of its ids is kept. */
	| { readonly kind: "id-collision" };

export interface UnpairedEntity {
	readonly kind: "module" | "form";
	readonly uuid: string;
	readonly cause: UnpairedCause;
}

/** How HQ's copy differs from the published document, by kind. */
export interface HqDifferences {
	readonly menus: number;
	readonly forms: number;
	readonly names: number;
	readonly caseTypes: number;
	readonly paths: number;
}

/** One HQ form's position, and the Nova form it pairs with. */
export interface FormPair {
	readonly menu: number;
	readonly form: number;
	readonly uuid: string;
}

export interface MatchPairs {
	/** HQ menu position to the Nova menu uuid it pairs with. */
	readonly menus: ReadonlyMap<number, string>;
	readonly forms: readonly FormPair[];
}

export type MatchResult =
	| {
			readonly path: "published-document";
			readonly pairs: MatchPairs;
			/** Entities of today's document the published one does not hold. */
			readonly addedSince: number;
			/** Published entities today's document no longer holds. */
			readonly goneSince: number;
	  }
	| {
			readonly path: "evidence";
			readonly pairs: MatchPairs;
			/** Every entity of today's document left without a pair. */
			readonly unpaired: readonly UnpairedEntity[];
			/** Pairs made at each stage, by stage number. */
			readonly pairsPerStage: Readonly<Record<number, number>>;
			/** Nova entities a tie left without a pair at the stage it met them. */
			readonly ties: number;
			/** Contested pairs dissolved. */
			readonly contests: number;
			/** HQ menus and forms left with no Nova entity, by position. */
			readonly hqUnpaired: readonly {
				readonly menu: number;
				readonly form?: number;
			}[];
			/** Present where the published document differed from HQ's copy. */
			readonly differences?: HqDifferences;
	  };

// ── Path one ────────────────────────────────────────────────────────

/**
 * Whether HQ's copy is what the published document sent, position for
 * position: the counts, each name one of HQ's texts, each case type HQ's or
 * HQ's empty string, and each form's paths exactly HQ's. Each difference is
 * counted under its kind.
 */
export function publishedAgreement(
	hq: readonly HqSideMenu[],
	published: readonly QuestionPathMenu[],
): HqDifferences {
	const differences = { menus: 0, forms: 0, names: 0, caseTypes: 0, paths: 0 };
	differences.menus = Math.abs(hq.length - published.length);
	for (let index = 0; index < Math.min(hq.length, published.length); index++) {
		const hqMenu = hq[index] as HqSideMenu;
		const menu = published[index] as QuestionPathMenu;
		if (!hqMenu.names.includes(menu.name)) differences.names += 1;
		if (caseTypeContradicts(hqMenu, menu)) differences.caseTypes += 1;
		differences.forms += Math.abs(hqMenu.forms.length - menu.forms.length);
		for (
			let formIndex = 0;
			formIndex < Math.min(hqMenu.forms.length, menu.forms.length);
			formIndex++
		) {
			const hqForm = hqMenu.forms[formIndex] as HqSideForm;
			const form = menu.forms[formIndex];
			if (form === undefined) continue;
			if (!hqForm.names.includes(form.name)) differences.names += 1;
			const effective = effectiveHqPaths(hqForm.paths, form.paths);
			const nova = new Set(form.paths);
			if (
				effective.size !== nova.size ||
				[...effective].some((path) => !nova.has(path))
			) {
				differences.paths += 1;
			}
		}
	}
	return differences;
}

function differs(differences: HqDifferences): boolean {
	return Object.values(differences).some((count) => count > 0);
}

/**
 * Path one: HQ's entity at a position is the published document's entity
 * there, carried to today's document by uuid. Where HQ's copy differs from
 * the published document, no pair is made and the differences are given.
 */
export function matchByPublishedDocument(
	hq: readonly HqSideMenu[],
	published: readonly QuestionPathMenu[],
	today: readonly QuestionPathMenu[],
):
	| { readonly agrees: true; readonly result: MatchResult }
	| { readonly agrees: false; readonly differences: HqDifferences } {
	const differences = publishedAgreement(hq, published);
	if (differs(differences)) return { agrees: false, differences };
	const todayMenus = new Set(today.map((menu) => menu.uuid));
	const todayForms = new Set(
		today.flatMap((menu) => menu.forms.map((form) => form.uuid)),
	);
	const menus = new Map<number, string>();
	const forms: FormPair[] = [];
	let goneSince = 0;
	published.forEach((menu, menuIndex) => {
		if (todayMenus.has(menu.uuid)) menus.set(menuIndex, menu.uuid);
		else goneSince += 1;
		menu.forms.forEach((form, formIndex) => {
			if (todayForms.has(form.uuid)) {
				forms.push({ menu: menuIndex, form: formIndex, uuid: form.uuid });
			} else {
				goneSince += 1;
			}
		});
	});
	const publishedUuids = new Set(
		published.flatMap((menu) => [
			menu.uuid,
			...menu.forms.map((form) => form.uuid),
		]),
	);
	const addedSince = today
		.flatMap((menu) => [menu.uuid, ...menu.forms.map((form) => form.uuid)])
		.filter((uuid) => !publishedUuids.has(uuid)).length;
	return {
		agrees: true,
		result: {
			path: "published-document",
			pairs: { menus, forms },
			addedSince,
			goneSince,
		},
	};
}

// ── Path two ────────────────────────────────────────────────────────

interface Candidate {
	readonly hq: string;
	readonly nova: string;
	/** Compared in order, greater first. */
	readonly key: readonly number[];
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * The one deciding rule. Of the candidates whose two ends are both free,
 * those of the greatest key whose ends are in no other of them pair; the
 * others are tied and each end of a tie is closed for the stage (and, by the
 * caller, for later stages). Repeats until no candidate has both ends free.
 */
function decide(
	candidates: readonly Candidate[],
	free: (end: { hq: string } | { nova: string }) => boolean,
): { pairs: [string, string][]; tied: Set<string>[] } {
	const pairs: [string, string][] = [];
	const tiedHq = new Set<string>();
	const tiedNova = new Set<string>();
	const pairedHq = new Set<string>();
	const pairedNova = new Set<string>();
	for (;;) {
		const open = candidates.filter(
			(candidate) =>
				free({ hq: candidate.hq }) &&
				free({ nova: candidate.nova }) &&
				!tiedHq.has(candidate.hq) &&
				!tiedNova.has(candidate.nova) &&
				!pairedHq.has(candidate.hq) &&
				!pairedNova.has(candidate.nova),
		);
		if (open.length === 0) break;
		let best = open[0]?.key ?? [];
		for (const candidate of open) {
			if (compareKeys(candidate.key, best) > 0) best = candidate.key;
		}
		const top = open.filter(
			(candidate) => compareKeys(candidate.key, best) === 0,
		);
		const hqCount = new Map<string, number>();
		const novaCount = new Map<string, number>();
		for (const candidate of top) {
			hqCount.set(candidate.hq, (hqCount.get(candidate.hq) ?? 0) + 1);
			novaCount.set(candidate.nova, (novaCount.get(candidate.nova) ?? 0) + 1);
		}
		for (const candidate of top) {
			if (
				hqCount.get(candidate.hq) === 1 &&
				novaCount.get(candidate.nova) === 1
			) {
				pairs.push([candidate.hq, candidate.nova]);
				pairedHq.add(candidate.hq);
				pairedNova.add(candidate.nova);
			} else {
				tiedHq.add(candidate.hq);
				tiedNova.add(candidate.nova);
			}
		}
	}
	return { pairs, tied: [tiedHq, tiedNova] };
}

const formKey = (menu: number, form: number) => `${menu}/${form}`;

/**
 * Path two: pairs by what HQ holds and what today's document holds, in six
 * stages. A tie pairs nothing and closes its ends, except at stage 1, whose
 * ties stay open for stages 4 and 5; a contested pair after stage 3 is
 * dissolved and its three ends closed. Position is read nowhere.
 */
export function matchByEvidence(
	hq: readonly HqSideMenu[],
	today: readonly QuestionPathMenu[],
): Extract<MatchResult, { path: "evidence" }> {
	const hqMenus = new Map(hq.map((menu) => [String(menu.position), menu]));
	const novaMenus = new Map(today.map((menu) => [menu.uuid, menu]));
	const hqForms = new Map<string, { menu: HqSideMenu; form: HqSideForm }>();
	for (const menu of hq) {
		for (const form of menu.forms) {
			hqForms.set(formKey(menu.position, form.position), { menu, form });
		}
	}
	const novaForms = new Map<
		string,
		{ menu: QuestionPathMenu; form: QuestionPathMenu["forms"][number] }
	>();
	for (const menu of today) {
		for (const form of menu.forms) novaForms.set(form.uuid, { menu, form });
	}

	const menuPairs = new Map<string, string>(); // hq position -> nova uuid
	const menuPairedNova = new Set<string>();
	const formPairs = new Map<string, string>(); // hq form key -> nova uuid
	const formPairedNova = new Map<string, string>(); // nova uuid -> hq form key
	const formPairStage = new Map<string, number>();
	const closedHqMenus = new Set<string>();
	const closedNovaMenus = new Set<string>();
	const closedHqForms = new Set<string>();
	const closedNovaForms = new Set<string>();
	const causes = new Map<string, UnpairedCause>();
	const pairsPerStage: Record<number, number> = {};
	let ties = 0;
	let contests = 0;

	const menuFree = (end: { hq: string } | { nova: string }) =>
		"hq" in end
			? !menuPairs.has(end.hq) && !closedHqMenus.has(end.hq)
			: !menuPairedNova.has(end.nova) && !closedNovaMenus.has(end.nova);
	const formFree = (end: { hq: string } | { nova: string }) =>
		"hq" in end
			? !formPairs.has(end.hq) && !closedHqForms.has(end.hq)
			: !formPairedNova.has(end.nova) && !closedNovaForms.has(end.nova);

	const settleMenus = (
		stage: number,
		candidates: Candidate[],
		closeTies: boolean,
	) => {
		const { pairs, tied } = decide(candidates, menuFree);
		for (const [hqEnd, novaEnd] of pairs) {
			menuPairs.set(hqEnd, novaEnd);
			menuPairedNova.add(novaEnd);
			causes.delete(novaEnd);
		}
		pairsPerStage[stage] = (pairsPerStage[stage] ?? 0) + pairs.length;
		const [tiedHq, tiedNova] = tied as [Set<string>, Set<string>];
		ties += tiedNova.size;
		for (const novaEnd of tiedNova) {
			causes.set(novaEnd, { kind: "tie", stage });
			if (closeTies) closedNovaMenus.add(novaEnd);
		}
		if (closeTies) for (const hqEnd of tiedHq) closedHqMenus.add(hqEnd);
	};
	const settleForms = (stage: number, candidates: Candidate[]) => {
		const { pairs, tied } = decide(candidates, formFree);
		for (const [hqEnd, novaEnd] of pairs) {
			formPairs.set(hqEnd, novaEnd);
			formPairedNova.set(novaEnd, hqEnd);
			formPairStage.set(hqEnd, stage);
		}
		pairsPerStage[stage] = (pairsPerStage[stage] ?? 0) + pairs.length;
		const [tiedHq, tiedNova] = tied as [Set<string>, Set<string>];
		ties += tiedNova.size;
		for (const hqEnd of tiedHq) closedHqForms.add(hqEnd);
		for (const novaEnd of tiedNova) {
			closedNovaForms.add(novaEnd);
			causes.set(novaEnd, { kind: "tie", stage });
		}
	};
	const formCandidate = (
		hqKey: string,
		novaUuid: string,
		require: "name-and-paths" | "name-or-paths",
		keyed: boolean,
	): Candidate | null => {
		const hqEntry = hqForms.get(hqKey);
		const novaEntry = novaForms.get(novaUuid);
		if (hqEntry === undefined || novaEntry === undefined) return null;
		const name = nameFact(novaEntry.form.name, hqEntry.form.names);
		const paths = pathsFact(hqEntry.form.paths, novaEntry.form.paths);
		const holds =
			require === "name-and-paths" ? name && paths.holds : name || paths.holds;
		if (!holds) return null;
		return {
			hq: hqKey,
			nova: novaUuid,
			key: keyed ? [paths.shared, -paths.apart] : [0],
		};
	};
	const formsOfPairedMenus = (
		require: "name-and-paths" | "name-or-paths",
		keyed: boolean,
	): Candidate[] => {
		const candidates: Candidate[] = [];
		for (const [hqPosition, novaUuid] of menuPairs) {
			const hqMenu = hqMenus.get(hqPosition);
			const novaMenu = novaMenus.get(novaUuid);
			if (hqMenu === undefined || novaMenu === undefined) continue;
			for (const hqForm of hqMenu.forms) {
				for (const novaForm of novaMenu.forms) {
					const candidate = formCandidate(
						formKey(hqMenu.position, hqForm.position),
						novaForm.uuid,
						require,
						keyed,
					);
					if (candidate !== null) candidates.push(candidate);
				}
			}
		}
		return candidates;
	};

	// Stage 1: menus by name, the case type as the key.
	const stageOne: Candidate[] = [];
	for (const hqMenu of hq) {
		for (const novaMenu of today) {
			if (
				nameFact(novaMenu.name, hqMenu.names) &&
				!caseTypeContradicts(hqMenu, novaMenu)
			) {
				stageOne.push({
					hq: String(hqMenu.position),
					nova: novaMenu.uuid,
					key: [caseTypeHolds(hqMenu, novaMenu) ? 1 : 0],
				});
			}
		}
	}
	settleMenus(1, stageOne, false);

	// Stage 2: forms of paired menus, by name and paths.
	settleForms(2, formsOfPairedMenus("name-and-paths", true));

	// Stage 3: forms anywhere, by name and paths.
	const stageThree: Candidate[] = [];
	for (const hqKey of hqForms.keys()) {
		for (const novaUuid of novaForms.keys()) {
			const candidate = formCandidate(hqKey, novaUuid, "name-and-paths", true);
			if (candidate !== null) stageThree.push(candidate);
		}
	}
	settleForms(3, stageThree);

	// A contested pair is dissolved: a still-free HQ form holds name and paths
	// with a Nova form another HQ form took.
	const dissolved: [string, string][] = [];
	for (const hqKey of hqForms.keys()) {
		if (!formFree({ hq: hqKey })) continue;
		for (const novaUuid of formPairedNova.keys()) {
			if (formCandidate(hqKey, novaUuid, "name-and-paths", false) !== null) {
				dissolved.push([hqKey, novaUuid]);
			}
		}
	}
	for (const [hqKey, novaUuid] of dissolved) {
		const takenBy = formPairedNova.get(novaUuid);
		if (takenBy === undefined) {
			closedHqForms.add(hqKey);
			continue;
		}
		const stage = formPairStage.get(takenBy);
		if (stage !== undefined)
			pairsPerStage[stage] = (pairsPerStage[stage] ?? 1) - 1;
		formPairs.delete(takenBy);
		formPairedNova.delete(novaUuid);
		formPairStage.delete(takenBy);
		closedHqForms.add(takenBy);
		closedHqForms.add(hqKey);
		closedNovaForms.add(novaUuid);
		causes.set(novaUuid, { kind: "contest" });
		contests += 1;
	}

	// Stage 4: the menus still unpaired, by their paired forms, then case type.
	const stageFour: Candidate[] = [];
	for (const hqMenu of hq) {
		for (const novaMenu of today) {
			if (caseTypeContradicts(hqMenu, novaMenu)) continue;
			let count = 0;
			for (const [hqKey, novaUuid] of formPairs) {
				const hqEntry = hqForms.get(hqKey);
				const novaEntry = novaForms.get(novaUuid);
				if (
					hqEntry?.menu.position === hqMenu.position &&
					novaEntry?.menu.uuid === novaMenu.uuid
				) {
					count += 1;
				}
			}
			if (count === 0) continue;
			stageFour.push({
				hq: String(hqMenu.position),
				nova: novaMenu.uuid,
				key: [count, caseTypeHolds(hqMenu, novaMenu) ? 1 : 0],
			});
		}
	}
	settleMenus(4, stageFour, true);

	// Stage 5: the menus still unpaired, by case type alone.
	const stageFive: Candidate[] = [];
	for (const hqMenu of hq) {
		for (const novaMenu of today) {
			if (caseTypeHolds(hqMenu, novaMenu)) {
				stageFive.push({
					hq: String(hqMenu.position),
					nova: novaMenu.uuid,
					key: [0],
				});
			}
		}
	}
	settleMenus(5, stageFive, true);

	// Stage 6: forms of paired menus, by name or by paths.
	settleForms(6, formsOfPairedMenus("name-or-paths", false));

	const unpaired: UnpairedEntity[] = [];
	for (const menu of today) {
		if (!menuPairedNova.has(menu.uuid)) {
			unpaired.push({
				kind: "module",
				uuid: menu.uuid,
				cause: causes.get(menu.uuid) ?? { kind: "no-candidate" },
			});
		}
		for (const form of menu.forms) {
			if (formPairedNova.has(form.uuid)) continue;
			unpaired.push({
				kind: "form",
				uuid: form.uuid,
				cause: causes.get(form.uuid) ?? { kind: "no-candidate" },
			});
		}
	}
	const hqUnpaired: { menu: number; form?: number }[] = [];
	for (const menu of hq) {
		if (!menuPairs.has(String(menu.position))) {
			hqUnpaired.push({ menu: menu.position });
		}
		for (const form of menu.forms) {
			if (!formPairs.has(formKey(menu.position, form.position))) {
				hqUnpaired.push({ menu: menu.position, form: form.position });
			}
		}
	}
	return {
		path: "evidence",
		pairs: {
			menus: new Map(
				[...menuPairs].map(([position, uuid]) => [Number(position), uuid]),
			),
			forms: [...formPairs].map(([key, uuid]) => {
				const entry = hqForms.get(key) as {
					menu: HqSideMenu;
					form: HqSideForm;
				};
				return {
					menu: entry.menu.position,
					form: entry.form.position,
					uuid,
				};
			}),
		},
		unpaired,
		pairsPerStage,
		ties,
		contests,
		hqUnpaired,
	};
}

// ── The two reads aligned ───────────────────────────────────────────

/** One module of `ApplicationResource`'s detail, as HQ answers it. */
export type HqFormIdModule =
	| {
			readonly kind: "module";
			readonly uniqueId: string;
			readonly forms: readonly {
				readonly uniqueId: string;
				readonly xmlns: string;
			}[];
	  }
	/** HQ answers a whole module this way when one of its forms does not parse. */
	| { readonly kind: "error" };

/**
 * Each HQ form's stored id, by the source read's positions: the form id
 * read's module of the same `unique_id`, its form at the same position, and
 * that form's `xmlns` equal to the source's there. Null where they do not
 * align, or where no form id read answered.
 */
export function alignStoredFormIds(
	hq: readonly HqSideMenu[],
	formIds: readonly HqFormIdModule[] | null,
): Map<string, string | null> {
	const aligned = new Map<string, string | null>();
	const byId = new Map<string, Extract<HqFormIdModule, { kind: "module" }>>();
	for (const module of formIds ?? []) {
		if (module.kind === "module") byId.set(module.uniqueId, module);
	}
	for (const menu of hq) {
		const stored = byId.get(menu.uniqueId);
		for (const form of menu.forms) {
			const storedForm = stored?.forms[form.position];
			aligned.set(
				formKey(menu.position, form.position),
				storedForm !== undefined && storedForm.xmlns === form.xmlns
					? storedForm.uniqueId
					: null,
			);
		}
	}
	return aligned;
}

// ── Identity rows ───────────────────────────────────────────────────

/** One `app_deployment_identities` row. */
export interface IdentityRow {
	readonly entityKind: "module" | "form";
	readonly novaEntityUuid: string;
	readonly remoteUniqueId: string | null;
	readonly remoteXmlns: string | null;
}

export interface DeploymentIdentities {
	readonly rows: readonly IdentityRow[];
	/** Paired entities whose HQ id is another entity's derived id. */
	readonly collisions: readonly UnpairedEntity[];
	/** Paired Nova forms whose stored form id no read gave. */
	readonly formIdsUnknown: readonly string[];
}

/**
 * The identity rows the pairs give: a value equal to the derivation is
 * dropped, and an entity whose HQ id or `xmlns` is another entity's derived
 * one gets no row at all, so two entities of one export never share an id.
 */
export function deploymentIdentities(
	hq: readonly HqSideMenu[],
	pairs: MatchPairs,
	storedFormIds: ReadonlyMap<string, string | null>,
	today: readonly QuestionPathMenu[],
): DeploymentIdentities {
	const entities = today.flatMap((menu) => [
		menu.uuid,
		...menu.forms.map((form) => form.uuid),
	]);
	const forms = today.flatMap((menu) => menu.forms.map((form) => form.uuid));
	const derivedIdOwner = new Map(
		entities.map((uuid) => [derivedUniqueId(asUuid(uuid)), uuid]),
	);
	const derivedXmlnsOwner = new Map(
		forms.map((uuid) => [derivedFormXmlns(asUuid(uuid)), uuid]),
	);
	const isAnothers = (
		owners: Map<string, string>,
		value: string | null,
		self: string,
	) => {
		if (value === null) return false;
		const owner = owners.get(value);
		return owner !== undefined && owner !== self;
	};
	const rows: IdentityRow[] = [];
	const collisions: UnpairedEntity[] = [];
	const formIdsUnknown: string[] = [];
	for (const [position, uuid] of [...pairs.menus].sort(([a], [b]) => a - b)) {
		const menu = hq[position];
		if (menu === undefined) continue;
		if (isAnothers(derivedIdOwner, menu.uniqueId, uuid)) {
			collisions.push({
				kind: "module",
				uuid,
				cause: { kind: "id-collision" },
			});
			continue;
		}
		if (menu.uniqueId !== derivedUniqueId(asUuid(uuid))) {
			rows.push({
				entityKind: "module",
				novaEntityUuid: uuid,
				remoteUniqueId: menu.uniqueId,
				remoteXmlns: null,
			});
		}
	}
	for (const pair of [...pairs.forms].sort(
		(a, b) => a.menu - b.menu || a.form - b.form,
	)) {
		const form = hq[pair.menu]?.forms[pair.form];
		if (form === undefined) continue;
		const stored = storedFormIds.get(formKey(pair.menu, pair.form)) ?? null;
		if (
			isAnothers(derivedIdOwner, stored, pair.uuid) ||
			isAnothers(derivedXmlnsOwner, form.xmlns, pair.uuid)
		) {
			collisions.push({
				kind: "form",
				uuid: pair.uuid,
				cause: { kind: "id-collision" },
			});
			continue;
		}
		if (stored === null) formIdsUnknown.push(pair.uuid);
		const uniqueId =
			stored === null || stored === derivedUniqueId(asUuid(pair.uuid))
				? null
				: stored;
		const xmlns =
			form.xmlns === derivedFormXmlns(asUuid(pair.uuid)) ? null : form.xmlns;
		if (uniqueId === null && xmlns === null) continue;
		rows.push({
			entityKind: "form",
			novaEntityUuid: pair.uuid,
			remoteUniqueId: uniqueId,
			remoteXmlns: xmlns,
		});
	}
	return { rows, collisions, formIdsUnknown };
}
