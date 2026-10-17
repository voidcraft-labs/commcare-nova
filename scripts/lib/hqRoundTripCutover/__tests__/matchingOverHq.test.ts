/**
 * The matcher over CommCare HQ's own answers: for each frozen fixture, the
 * source read and the form id read HQ gave after the fixture's legacy create
 * and after its legacy republish (`proof/hq-reads/cutover/`), served to the
 * real readers through a peer. What this proves is that Nova's reading of
 * HQ's real answers is the one part 10 of step 2's plan states: both paths
 * pair every menu and form with itself, the two reads align, and the
 * identity rows are exactly the ids HQ holds.
 */

import { Element } from "domhandler";
import { appendChild, getOuterHTML } from "domutils";
import { describe, expect, it } from "vitest";
import { parseXml } from "@/lib/commcare/xmlParse";
import {
	alignStoredFormIds,
	deploymentIdentities,
	effectiveHqPaths,
	type HqSideMenu,
	hqSideOf,
	matchByEvidence,
	matchByPublishedDocument,
	pathsFact,
} from "../matching";
import { readRawDocument } from "../oldShape";
import { type QuestionPathMenu, questionPaths } from "../questionPaths";
import { HISTORIES } from "./fixtures/fixtureDocuments";
import { reordered } from "./fixtures/matchingInputs";
import {
	readFixtureCarriers,
	readFixtureHistory,
	readFixtureManifest,
	readHistoryCarriers,
} from "./fixtures/preStep";
import {
	bodyJson,
	type RetainedState,
	retainedCutoverRead,
	retainedFormIds,
	retainedSource,
	withBody,
} from "./fixtures/retainedCutoverReads";

const DOCUMENTS = readFixtureManifest()
	.fixtures.filter((fixture) => fixture.kind === "corpus")
	.map((fixture) => fixture.id);
const STATES: readonly RetainedState[] = ["after-create", "after-republish"];

async function hqOf(document: string, state: RetainedState) {
	const source = await retainedSource(
		retainedCutoverRead(document, state, "app-source.json"),
	);
	const formIds = await retainedFormIds(
		retainedCutoverRead(document, state, "application.json"),
	);
	return { source, formIds, hq: hqSideOf(source) };
}

function todayOf(document: string): QuestionPathMenu[] {
	return [
		...questionPaths(readRawDocument(document, readFixtureCarriers(document))),
	];
}

/** Each HQ position's pair as `menu` or `menu/form`, to the paired uuid. */
function pairsByPosition(pairs: ReturnType<typeof matchByEvidence>["pairs"]) {
	return {
		menus: Object.fromEntries([...pairs.menus]),
		forms: Object.fromEntries(
			pairs.forms.map((pair) => [`${pair.menu}/${pair.form}`, pair.uuid]),
		),
	};
}

/** Every menu and form of `menus` at its own position. */
function itself(menus: readonly QuestionPathMenu[]) {
	return {
		menus: Object.fromEntries(menus.map((menu, index) => [index, menu.uuid])),
		forms: Object.fromEntries(
			menus.flatMap((menu, index) =>
				menu.forms.map((form, formIndex) => [
					`${index}/${formIndex}`,
					form.uuid,
				]),
			),
		),
	};
}

describe.each(DOCUMENTS)("over %s", (document) => {
	describe.each(STATES)("%s", (state) => {
		it("agrees with the document position for position and pairs every menu and form with itself", async () => {
			const { hq } = await hqOf(document, state);
			const today = todayOf(document);
			const result = matchByPublishedDocument(hq, today, today);
			expect(result.agrees).toBe(true);
			if (!result.agrees) return;
			expect(pairsByPosition(result.result.pairs)).toEqual(itself(today));
		});

		it("pairs the same by evidence, every menu at stage 1 and every form at stage 2, with no tie and no contest", async () => {
			const { hq } = await hqOf(document, state);
			const today = todayOf(document);
			const result = matchByEvidence(hq, today);
			expect(pairsByPosition(result.pairs)).toEqual(itself(today));
			expect(result.pairsPerStage[1]).toBe(hq.length);
			expect(result.pairsPerStage[2]).toBe(
				hq.reduce((sum, menu) => sum + menu.forms.length, 0),
			);
			expect(result.ties).toBe(0);
			expect(result.contests).toBe(0);
		});

		it("aligns the two reads and records exactly the ids HQ holds", async () => {
			const { hq, formIds } = await hqOf(document, state);
			const today = todayOf(document);
			const application = bodyJson(
				retainedCutoverRead(document, state, "application.json"),
			);
			const storedModules = application.modules as {
				unique_id: string;
				forms: { unique_id: string; xmlns: string }[];
			}[];
			const aligned = alignStoredFormIds(hq, formIds);
			const expected = new Map<string, string>();
			hq.forEach((menu) => {
				const stored = storedModules.find(
					(module) => module.unique_id === menu.uniqueId,
				);
				menu.forms.forEach((form) => {
					expected.set(
						`${menu.position}/${form.position}`,
						stored?.forms[form.position]?.unique_id ?? "",
					);
				});
			});
			expect(Object.fromEntries(aligned)).toEqual(Object.fromEntries(expected));
			if (state !== "after-republish") return;
			const match = matchByPublishedDocument(hq, today, today);
			if (!match.agrees) throw new Error("HQ's copy was expected to agree.");
			const identities = deploymentIdentities(
				hq,
				match.result.pairs,
				aligned,
				today,
			);
			expect(identities.collisions).toEqual([]);
			expect(identities.rows).toEqual([
				...today.map((menu, index) => ({
					entityKind: "module",
					novaEntityUuid: menu.uuid,
					remoteUniqueId: hq[index]?.uniqueId,
					remoteXmlns: null,
				})),
				...today.flatMap((menu, index) =>
					menu.forms.map((form, formIndex) => ({
						entityKind: "form",
						novaEntityUuid: form.uuid,
						remoteUniqueId: expected.get(`${index}/${formIndex}`),
						remoteXmlns: hq[index]?.forms[formIndex]?.xmlns,
					})),
				),
			]);
		});

		it("gives the same pairs by evidence whatever order Nova's side is handed over in", async () => {
			const { hq } = await hqOf(document, state);
			const today = todayOf(document);
			const expected = pairsByPosition(matchByEvidence(hq, today).pairs);
			for (let seed = 1; seed <= 20; seed++) {
				expect(
					pairsByPosition(matchByEvidence(hq, reordered(today, seed)).pairs),
				).toEqual(expected);
			}
		});
	});
});

/** Per history, the pairs path two makes at each stage (part 10, the histories table). */
const STAGES: Readonly<
	Record<string, { stages: Record<number, number>; contests: number }>
> = {
	"menu-moved": { stages: { 1: 3, 2: 5 }, contests: 0 },
	"form-moved": { stages: { 1: 3, 2: 4, 3: 1 }, contests: 0 },
	"empty-menu-moved": { stages: { 1: 3, 2: 2 }, contests: 0 },
	"menu-renamed": { stages: { 1: 2, 2: 1, 3: 1, 4: 1 }, contests: 0 },
	"empty-menu-renamed": { stages: { 1: 2, 2: 2, 5: 1 }, contests: 0 },
	"questions-removed": { stages: { 1: 1, 2: 1 }, contests: 0 },
	"typeless-menu-renamed": { stages: { 3: 1, 4: 1 }, contests: 0 },
	"form-renamed": { stages: { 1: 1, 2: 1, 6: 1 }, contests: 0 },
	"question-renamed": { stages: { 1: 1, 2: 1, 6: 1 }, contests: 0 },
	"form-reordered": { stages: { 1: 1, 2: 2 }, contests: 0 },
	"twin-moved": { stages: { 1: 2 }, contests: 1 },
};

describe.each(HISTORIES.map((history) => [history.document, history.name]))(
	"over %s's history %s",
	(document, name) => {
		const rows = readFixtureHistory(document, name).rows;
		const lastSeq = rows.at(-1)?.seq ?? 1;
		const today = [
			...questionPaths(
				readRawDocument(document, readHistoryCarriers(document, name, lastSeq)),
			),
		];
		const published = todayOf(document);
		const todayUuids = new Set(
			today.flatMap((menu) => [
				menu.uuid,
				...menu.forms.map((form) => form.uuid),
			]),
		);
		/** The published entity at each HQ position that today's document still holds. */
		const remaining = () => {
			const all = itself(published);
			return {
				menus: Object.fromEntries(
					Object.entries(all.menus).filter(([, uuid]) => todayUuids.has(uuid)),
				),
				forms: Object.fromEntries(
					Object.entries(all.forms).filter(([, uuid]) => todayUuids.has(uuid)),
				),
			};
		};

		it.each(STATES)(
			"pairs every menu and form it leaves with itself by the published document, %s",
			async (state) => {
				const { hq } = await hqOf(document, state);
				const result = matchByPublishedDocument(hq, published, today);
				expect(result.agrees).toBe(true);
				if (!result.agrees) return;
				expect(pairsByPosition(result.result.pairs)).toEqual(remaining());
			},
		);

		it.each(STATES)(
			"pairs by evidence at the stages the histories table names, %s",
			async (state) => {
				const { hq } = await hqOf(document, state);
				const result = matchByEvidence(hq, today);
				const expected = STAGES[name];
				for (const stage of [1, 2, 3, 4, 5, 6]) {
					expect(result.pairsPerStage[stage] ?? 0).toBe(
						expected?.stages[stage] ?? 0,
					);
				}
				expect(result.contests).toBe(expected?.contests);
				expect(result.ties).toBe(0);
				if (name === "twin-moved") {
					expect(result.pairs.forms).toEqual([]);
					expect(
						result.unpaired.filter((entity) => entity.kind === "form"),
					).toHaveLength(2);
					return;
				}
				expect(pairsByPosition(result.pairs)).toEqual(remaining());
				for (let seed = 1; seed <= 20; seed++) {
					expect(
						pairsByPosition(matchByEvidence(hq, reordered(today, seed)).pairs),
					).toEqual(pairsByPosition(result.pairs));
				}
			},
		);
	},
);

describe("a copy changed in HQ leaves path one", () => {
	const DOCUMENT = "targeted-form-links-hidden-and-fallback";
	const answer = () =>
		retainedCutoverRead(DOCUMENT, "after-republish", "app-source.json");

	async function differencesAfter(
		edit: (body: Record<string, unknown>) => void,
	) {
		const body = structuredClone(bodyJson(answer()));
		edit(body);
		const hq: HqSideMenu[] = hqSideOf(
			await retainedSource(withBody(answer(), body)),
		);
		const today = todayOf(DOCUMENT);
		const result = matchByPublishedDocument(hq, today, today);
		expect(result.agrees).toBe(false);
		return result.agrees ? null : result.differences;
	}

	type Modules = {
		name: Record<string, string>;
		forms: { name: Record<string, string>; unique_id: string }[];
	}[];

	it("with one form's name changed, one name difference (modules.0.forms.0.name)", async () => {
		expect(
			await differencesAfter((body) => {
				const form = (body.modules as Modules)[0]?.forms[0];
				if (form !== undefined) form.name = { en: "Changed in HQ" };
			}),
		).toEqual({ menus: 0, forms: 0, names: 1, caseTypes: 0, paths: 0 });
	});

	it("with one element added to a form's instance, one paths difference (_attachments)", async () => {
		expect(
			await differencesAfter((body) => {
				const form = (body.modules as Modules)[0]?.forms[0];
				const attachments = body._attachments as Record<string, string>;
				const key = `${form?.unique_id}.xml`;
				const xml = parseXml(attachments[key] ?? "");
				const instanceRoot = findInstanceRoot(xml.children);
				if (instanceRoot === undefined) throw new Error("No instance root.");
				appendChild(instanceRoot, new Element("added_in_hq", {}, []));
				attachments[key] = getOuterHTML(xml, { xmlMode: true });
			}),
		).toEqual({ menus: 0, forms: 0, names: 0, caseTypes: 0, paths: 1 });
	});

	it("with one form removed, one count difference (modules.0.forms)", async () => {
		expect(
			await differencesAfter((body) => {
				(body.modules as Modules)[0]?.forms.pop();
			}),
		).toMatchObject({ forms: 1 });
	});

	it("with two menus exchanged, the names and case types of both and the names of their forms (modules)", async () => {
		const differences = await differencesAfter((body) => {
			const modules = body.modules as Modules;
			[modules[0], modules[1]] = [
				modules[1] as Modules[number],
				modules[0] as Modules[number],
			];
		});
		expect(differences?.names).toBeGreaterThanOrEqual(2);
		expect(differences?.menus).toBe(0);
	});
});

function findInstanceRoot(nodes: readonly unknown[]): Element | undefined {
	for (const node of nodes) {
		if (!(node instanceof Element)) continue;
		if (node.name.endsWith("instance")) {
			return node.children.find(
				(child): child is Element => child instanceof Element,
			);
		}
		const found = findInstanceRoot(node.children);
		if (found !== undefined) return found;
	}
	return undefined;
}

describe("each exclusion of the HQ side is needed", () => {
	type Rule = "connect" | "nova-prefix";

	/** The test's own copy of the collector, with one rule switched off. */
	function collectWithout(xform: string, off: Rule) {
		const root = findInstanceRoot(parseXml(xform).children);
		if (root === undefined) return [];
		const leaves: { path: string; generated: boolean }[] = [];
		const walk = (element: Element, path: string): boolean => {
			const children = element.children.filter(
				(child): child is Element => child instanceof Element,
			);
			let kept = 0;
			let connect = 0;
			for (const child of children) {
				if (off !== "nova-prefix" && child.name.startsWith("__nova_")) continue;
				if (
					off !== "connect" &&
					child.attribs.xmlns === "http://commcareconnect.com/data/v1/learn"
				) {
					connect += 1;
					continue;
				}
				if (walk(child, `${path}/${child.name}`)) kept += 1;
				else connect += 1;
			}
			if (kept > 0) return true;
			if (children.length > 0 && connect === children.length) return false;
			if (element !== root) {
				leaves.push({ path, generated: false });
			}
			return true;
		};
		walk(root, `/${root.name}`);
		return leaves;
	}

	it("connect-deliver-default loses the paths fact with the Connect rule off", async () => {
		const document = "connect-deliver-default";
		const source = await retainedSource(
			retainedCutoverRead(document, "after-create", "app-source.json"),
		);
		const today = todayOf(document);
		const withRules = hqSideOf(source);
		let lost = 0;
		source.modules.forEach((module, menuIndex) => {
			module.forms.forEach((form, formIndex) => {
				const nova = today[menuIndex]?.forms[formIndex]?.paths ?? [];
				const kept = withRules[menuIndex]?.forms[formIndex]?.paths ?? [];
				if (nova.length > 0) expect(pathsFact(kept, nova).holds).toBe(true);
				if (form.attachment === null) return;
				if (
					!pathsFact(collectWithout(form.attachment, "connect"), nova).holds
				) {
					lost += 1;
				}
			});
		});
		expect(lost).toBeGreaterThan(0);
	});

	// These two documents hold more questions than generated leaves, so a
	// form of theirs keeps the paths fact with the rule off; what HQ's bytes
	// show is the leaves themselves, which no Nova form holds and the rule
	// drops. A form where the rule decides the pair is `matching.test.ts`'s.
	it.each([
		["container-live-count-entry", "nova_count_"],
		["xml-unicode", "nova_constraint_message_"],
	])(
		"%s holds %s leaves Nova does not, and drops each",
		async (document, prefix) => {
			const source = await retainedSource(
				retainedCutoverRead(document, "after-create", "app-source.json"),
			);
			const today = todayOf(document);
			const withRules = hqSideOf(source);
			let generated = 0;
			withRules.forEach((menu, menuIndex) => {
				menu.forms.forEach((form, formIndex) => {
					const nova = today[menuIndex]?.forms[formIndex]?.paths ?? [];
					for (const entry of form.paths) {
						const leaf = entry.path.slice(entry.path.lastIndexOf("/") + 1);
						if (!leaf.startsWith(prefix)) continue;
						expect(entry.generated).toBe(true);
						expect(nova).not.toContain(entry.path);
						generated += 1;
					}
					expect([...effectiveHqPaths(form.paths, nova)].sort()).toEqual(
						[...nova].sort(),
					);
				});
			});
			expect(generated).toBeGreaterThan(0);
		},
	);
});
