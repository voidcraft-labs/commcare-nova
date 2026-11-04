/**
 * `mapFormLinkSemantics`: the one map from after-submit links stored when
 * the first destination that held was the only one to run, to links stored
 * now, when every destination that holds runs and the otherwise is its own
 * slot. Each class on a fixture, their order, totality, idempotence, that
 * every mapped document passes the commit gate, and the behavior claim the
 * cutover rests on: over every assignment of the original conditions, the
 * mapped app opens exactly the frame the old one did.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { deepEqual } from "@/lib/doc/deepEqual";
import {
	type FormLinkSemanticsChange,
	mapFormLinkSemantics,
} from "@/lib/doc/formLinkSemanticsMap";
import type {
	BlueprintDoc,
	FormLink,
	FormOtherwise,
	PostSubmitDestination,
} from "@/lib/domain";
import {
	and,
	eq,
	literal,
	sessionUser,
	term,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const SUB = testUuid("mod-sub");
const SOURCE = testUuid("frm-source");
const VISIT = testUuid("frm-visit");
const NOTE = testUuid("frm-note");

const toNote = { type: "form", moduleUuid: CARE, formUuid: NOTE } as const;
const toVisit = { type: "form", moduleUuid: CARE, formUuid: VISIT } as const;
const toCare = { type: "module", moduleUuid: CARE } as const;
const toIntake = { type: "module", moduleUuid: INTAKE } as const;
const toSub = { type: "module", moduleUuid: SUB } as const;
const TARGETS = [toNote, toVisit, toCare] as const;

/** Original condition `i`: an opaque boolean the claim assigns. */
const atom = (i: number): Expression =>
	eq(sessionUser("username"), literal(`u${i}`));

const link = (
	uuid: string,
	condition: Expression | undefined,
	target: FormLink["target"],
): FormLink => ({
	uuid: testUuid(uuid),
	...(condition !== undefined && { condition }),
	target,
});

/**
 * Intake (patient) → [Source (registration)]; Care (patient) → [Visit
 * (followup), Note (survey)]; Sub, a submenu of Care → [Sub note]. Source's
 * after-submit slots are written as given, in the shape they had when the
 * first link that held was the only one to run, so the input is no document
 * the head gate admits; the map's output must be.
 */
function oldShape(slots: {
	links?: FormLink[];
	postSubmit?: PostSubmitDestination;
	otherwise?: FormOtherwise;
	careOffTheMenu?: boolean;
}): BlueprintDoc {
	const built = buildDoc({
		appName: "Semantics",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "mood", label: proseText("Mood") }],
			},
		],
		modules: [
			{
				uuid: "mod-intake",
				name: "Intake",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-source",
						name: "Source",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: "mod-care",
				name: "Care",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-visit",
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "mood",
								label: proseText("Mood"),
								caseWrite: { caseType: "patient", property: "mood" },
							}),
						],
					},
					{
						uuid: "frm-note",
						name: "Note",
						type: "survey",
						fields: [f({ kind: "text", id: "n", label: proseText("N") })],
					},
				],
			},
			{
				uuid: "mod-sub",
				name: "Sub",
				forms: [
					{
						uuid: "frm-sub-note",
						name: "Sub note",
						type: "survey",
						fields: [f({ kind: "text", id: "s", label: proseText("S") })],
					},
				],
			},
		],
	});
	return produce(built, (draft) => {
		draft.modules[SUB].parentModuleUuid = CARE;
		if (slots.careOffTheMenu === true)
			draft.modules[CARE].hiddenFromMenu = true;
		const source = draft.forms[SOURCE];
		if (slots.links !== undefined && slots.links.length > 0)
			source.formLinks = slots.links;
		if (slots.postSubmit !== undefined) source.postSubmit = slots.postSubmit;
		if (slots.otherwise !== undefined) source.otherwise = slots.otherwise;
	});
}

/** Map, hold the output to the gate and to idempotence, and return it. */
function mapped(doc: BlueprintDoc): {
	doc: BlueprintDoc;
	changes: readonly FormLinkSemanticsChange[];
} {
	const result = mapFormLinkSemantics(doc);
	assertAdmittedDoc(result.doc);
	const again = mapFormLinkSemantics(result.doc);
	expect(again.changes).toEqual([]);
	expect(deepEqual(again.doc.forms, result.doc.forms)).toBe(true);
	return result;
}

const notOf = (clause: Expression): Expression => ({ kind: "not", clause });
const andOf = (...clauses: [Expression, ...Expression[]]): Expression => ({
	kind: "and",
	clauses,
});

describe("L1: guards into conditions", () => {
	it("conjoins every earlier conditional destination's negation, built directly", () => {
		const doc = oldShape({
			links: [
				link("lnk-1", atom(1), toNote),
				link("lnk-2", atom(2), toVisit),
				link("lnk-3", atom(3), toCare),
			],
			postSubmit: "module",
		});
		const { doc: next, changes } = mapped(doc);
		expect(next.forms[SOURCE]?.formLinks?.map((l) => l.condition)).toEqual([
			atom(1),
			andOf(atom(2), notOf(atom(1))),
			andOf(atom(3), notOf(atom(1)), notOf(atom(2))),
		]);
		expect(changes[0]).toEqual({
			kind: "conditions-written",
			formUuid: SOURCE,
			linkUuids: [testUuid("lnk-2"), testUuid("lnk-3")],
		});
	});

	it("keeps an original conjunction as one clause, unflattened", () => {
		const compound = and(atom(1), atom(4));
		const { doc: next } = mapped(
			oldShape({
				links: [
					link("lnk-1", compound, toNote),
					link("lnk-2", atom(2), toCare),
				],
				postSubmit: "app_home",
			}),
		);
		expect(next.forms[SOURCE]?.formLinks?.[1]?.condition).toEqual(
			andOf(atom(2), notOf(compound)),
		);
	});
});

describe("L2: a terminal else to the otherwise", () => {
	it("moves the last unconditional destination into the otherwise link, keeping its uuid, and drops a stored after-submit", () => {
		const { doc: next, changes } = mapped(
			oldShape({
				links: [
					link("lnk-1", atom(1), toNote),
					link("lnk-else", undefined, toVisit),
				],
				postSubmit: "module",
			}),
		);
		const form = next.forms[SOURCE];
		expect(form?.formLinks?.map((l) => l.uuid)).toEqual([testUuid("lnk-1")]);
		expect(form?.otherwise).toEqual({
			kind: "link",
			uuid: testUuid("lnk-else"),
			target: toVisit,
		});
		expect(form?.postSubmit).toBeUndefined();
		expect(changes).toEqual([
			{
				kind: "otherwise-set",
				formUuid: SOURCE,
				otherwise: {
					kind: "link",
					uuid: testUuid("lnk-else"),
					target: toVisit,
				},
			},
			{
				kind: "after-submit-dropped",
				formUuid: SOURCE,
				destination: "module",
			},
		]);
	});
});

describe("L3: an after-submit beside destinations", () => {
	it("becomes the built-in otherwise when every destination has a condition", () => {
		const { doc: next, changes } = mapped(
			oldShape({
				links: [link("lnk-1", atom(1), toNote)],
				postSubmit: "previous",
			}),
		);
		expect(next.forms[SOURCE]?.otherwise).toEqual({
			kind: "destination",
			destination: "previous",
		});
		expect(next.forms[SOURCE]?.postSubmit).toBeUndefined();
		expect(changes).toEqual([
			{
				kind: "otherwise-set",
				formUuid: SOURCE,
				otherwise: { kind: "destination", destination: "previous" },
			},
		]);
	});

	it("becomes no otherwise for the app home, which an absent otherwise means", () => {
		const { doc: next, changes } = mapped(
			oldShape({
				links: [link("lnk-1", atom(1), toNote)],
				postSubmit: "app_home",
			}),
		);
		expect(next.forms[SOURCE]?.otherwise).toBeUndefined();
		expect(next.forms[SOURCE]?.postSubmit).toBeUndefined();
		expect(changes).toEqual([]);
	});

	it("is dropped beside a sole unconditional destination, where it never ran", () => {
		const { doc: next, changes } = mapped(
			oldShape({
				links: [link("lnk-1", undefined, toCare)],
				postSubmit: "module",
			}),
		);
		expect(next.forms[SOURCE]?.postSubmit).toBeUndefined();
		expect(next.forms[SOURCE]?.otherwise).toBeUndefined();
		expect(changes).toEqual([
			{
				kind: "after-submit-dropped",
				formUuid: SOURCE,
				destination: "module",
			},
		]);
	});
});

describe("L4: an unoffered menu target", () => {
	it("points a link to an unoffered submenu at the menu that holds it", () => {
		const { doc: next, changes } = mapped(
			oldShape({
				links: [link("lnk-1", atom(1), toSub)],
				otherwise: {
					kind: "link",
					uuid: testUuid("lnk-else"),
					target: toSub,
				},
			}),
		);
		expect(next.forms[SOURCE]?.formLinks?.[0]?.target).toEqual(toCare);
		expect(next.forms[SOURCE]?.otherwise).toMatchObject({ target: toCare });
		expect(changes).toEqual([
			{
				kind: "target-moved",
				formUuid: SOURCE,
				linkUuid: testUuid("lnk-1"),
				from: SUB,
				to: CARE,
			},
			{
				kind: "target-moved",
				formUuid: SOURCE,
				linkUuid: testUuid("lnk-else"),
				from: SUB,
				to: CARE,
			},
		]);
	});

	it("removes a sole destination whose submenu's parent is off the menu, and the built-in otherwise becomes the after-submit", () => {
		const { doc: next, changes } = mapped(
			oldShape({
				links: [link("lnk-1", atom(1), toSub)],
				otherwise: { kind: "destination", destination: "module" },
				careOffTheMenu: true,
			}),
		);
		const form = next.forms[SOURCE];
		expect(form?.formLinks).toBeUndefined();
		expect(form?.otherwise).toBeUndefined();
		expect(form?.postSubmit).toBe("module");
		expect(changes).toEqual([
			{
				kind: "link-removed",
				formUuid: SOURCE,
				linkUuid: testUuid("lnk-1"),
				to: SUB,
			},
		]);
	});

	it("turns the otherwise link into the sole destination when the removed one was the last", () => {
		const { doc: next } = mapped(
			oldShape({
				links: [link("lnk-1", atom(1), toSub)],
				otherwise: {
					kind: "link",
					uuid: testUuid("lnk-else"),
					target: toIntake,
				},
				careOffTheMenu: true,
			}),
		);
		expect(next.forms[SOURCE]?.formLinks).toEqual([
			{ uuid: testUuid("lnk-else"), target: toIntake },
		]);
		expect(next.forms[SOURCE]?.otherwise).toBeUndefined();
	});

	it("removes an otherwise link whose submenu's parent is off the menu", () => {
		const { doc: next, changes } = mapped(
			oldShape({
				links: [link("lnk-1", atom(1), toIntake)],
				otherwise: {
					kind: "link",
					uuid: testUuid("lnk-else"),
					target: toSub,
				},
				careOffTheMenu: true,
			}),
		);
		expect(next.forms[SOURCE]?.formLinks?.map((l) => l.uuid)).toEqual([
			testUuid("lnk-1"),
		]);
		expect(next.forms[SOURCE]?.otherwise).toBeUndefined();
		expect(changes).toEqual([
			{
				kind: "link-removed",
				formUuid: SOURCE,
				linkUuid: testUuid("lnk-else"),
				to: SUB,
			},
		]);
	});

	it("removes the otherwise with the last destination that may not run", () => {
		const { doc: next } = mapped(
			oldShape({
				links: [
					link("lnk-1", atom(1), toSub),
					link("lnk-2", undefined, toIntake),
				],
				otherwise: { kind: "destination", destination: "module" },
				careOffTheMenu: true,
			}),
		);
		expect(next.forms[SOURCE]?.formLinks?.map((l) => l.uuid)).toEqual([
			testUuid("lnk-2"),
		]);
		expect(next.forms[SOURCE]?.otherwise).toBeUndefined();
	});
});

describe("L5: values carried to a menu", () => {
	it("drops them", () => {
		const carrying: FormLink = {
			...link("lnk-1", atom(1), toCare),
			datums: [
				{
					name: { kind: "selected-case", module: CARE },
					xpath: term(literal("x")),
				},
			],
		};
		const { doc: next, changes } = mapped(oldShape({ links: [carrying] }));
		expect(next.forms[SOURCE]?.formLinks?.[0]).toEqual(
			link("lnk-1", atom(1), toCare),
		);
		expect(changes).toEqual([
			{
				kind: "datums-dropped",
				formUuid: SOURCE,
				linkUuid: testUuid("lnk-1"),
				to: CARE,
			},
		]);
	});
});

describe("L6: an unoffered built-in otherwise", () => {
	it("becomes the nearest the menu offers, saying what it replaced", () => {
		const { doc: next, changes } = mapped(
			oldShape({
				links: [link("lnk-1", atom(1), toNote)],
				postSubmit: "parentMenu",
			}),
		);
		expect(next.forms[SOURCE]?.otherwise).toEqual({
			kind: "destination",
			destination: "module",
		});
		expect(changes).toEqual([
			{
				kind: "otherwise-set",
				formUuid: SOURCE,
				otherwise: { kind: "destination", destination: "parentMenu" },
			},
			{
				kind: "otherwise-set",
				formUuid: SOURCE,
				otherwise: { kind: "destination", destination: "module" },
				from: "parentMenu",
			},
		]);
	});
});

describe("the order of the classes", () => {
	it("reads L1 to L3 over the original links, and L5 after L4's retarget", () => {
		const { doc: next, changes } = mapped(
			oldShape({
				links: [
					link("lnk-1", atom(1), toNote),
					{
						...link("lnk-2", atom(2), toSub),
						datums: [
							{
								name: { kind: "selected-case", module: CARE },
								xpath: term(literal("x")),
							},
						],
					},
					link("lnk-else", undefined, toCare),
				],
				postSubmit: "module",
			}),
		);
		expect(changes.map((change) => change.kind)).toEqual([
			"conditions-written",
			"otherwise-set",
			"after-submit-dropped",
			"target-moved",
			"datums-dropped",
		]);
		// The else was not written a condition: L2 took it from the original
		// list, so L3 found no after-submit beside the destinations left.
		expect(changes[0]).toMatchObject({ linkUuids: [testUuid("lnk-2")] });
		expect(next.forms[SOURCE]?.formLinks?.[1]).toEqual({
			uuid: testUuid("lnk-2"),
			condition: andOf(atom(2), notOf(atom(1))),
			target: toCare,
		});
		expect(changes.at(-1)).toMatchObject({ to: CARE });
	});
});

describe("totality and idempotence", () => {
	it("returns a document for shapes no app held, and maps each only once", () => {
		const shapes: BlueprintDoc[] = [
			oldShape({}),
			// An otherwise with no destinations.
			oldShape({ otherwise: { kind: "destination", destination: "module" } }),
			// An unconditional destination before a conditional one.
			oldShape({
				links: [
					link("lnk-1", undefined, toNote),
					link("lnk-2", atom(2), toCare),
				],
			}),
			// A link to a menu that does not exist.
			oldShape({
				links: [
					link("lnk-1", atom(1), {
						type: "module",
						moduleUuid: testUuid("ghost"),
					}),
				],
			}),
			// Already the new shape.
			oldShape({
				links: [
					link("lnk-1", atom(1), toNote),
					link("lnk-2", andOf(atom(2), notOf(atom(1))), toCare),
				],
				otherwise: { kind: "destination", destination: "module" },
			}),
		];
		for (const doc of shapes) {
			const once = mapFormLinkSemantics(doc);
			const twice = mapFormLinkSemantics(once.doc);
			expect(twice.changes).toEqual([]);
			expect(deepEqual(twice.doc.forms, once.doc.forms)).toBe(true);
		}
		const untouched = oldShape({});
		expect(mapFormLinkSemantics(untouched)).toEqual({
			doc: untouched,
			changes: [],
		});
	});
});

// ── The behavior claim ─────────────────────────────────────────────────

/**
 * A FROZEN copy of the guard semantics Nova emitted before the cutover
 * (`lib/commcare/formLinkProjection.ts::planFormLinkGuards` at the base of
 * this change), over booleans: link i's guard is its condition and the
 * negation of every earlier conditional link's condition; an unconditional
 * link after conditional ones is guarded by those negations alone, and as
 * the last link it suppresses the fallback; otherwise the fallback, the
 * stored or default after-submit, is guarded by the negation of every
 * emitted guard, and the app home emits no frame. Core pushes every frame
 * whose guard holds. Never edit it to match the map: it is the oracle.
 */
function oldFrames(
	links: readonly { uuid: string; condition: boolean | undefined }[],
	postSubmit: PostSubmitDestination,
): string[] {
	const planned: { uuid: string; guard: boolean | undefined }[] = [];
	const priors: boolean[] = [];
	const formLinkGuard = (condition: boolean | undefined) =>
		(condition ?? true) && priors.every((prior) => !prior);
	for (const entry of links) {
		if (entry.condition === undefined) {
			planned.push({
				uuid: entry.uuid,
				guard: priors.length > 0 ? formLinkGuard(undefined) : undefined,
			});
			continue;
		}
		planned.push({ uuid: entry.uuid, guard: formLinkGuard(entry.condition) });
		priors.push(entry.condition);
	}
	const last = links.at(-1);
	const fallback:
		| { kind: "none" }
		| { kind: "suppressed-by-else" }
		| { kind: "guarded"; guard: boolean } =
		priors.length === 0
			? { kind: "none" }
			: last?.condition === undefined
				? { kind: "suppressed-by-else" }
				: {
						kind: "guarded",
						guard: planned.every(
							(entry) => entry.guard === undefined || !entry.guard,
						),
					};
	const frames = planned
		.filter((entry) => entry.guard === undefined || entry.guard)
		.map((entry) => entry.uuid);
	if (
		fallback.kind === "guarded" &&
		fallback.guard &&
		postSubmit !== "app_home"
	)
		frames.push(`built-in:${postSubmit}`);
	return frames;
}

/** Evaluate a mapped condition, each original condition read as its atom. */
function evaluate(
	expression: Expression,
	atoms: readonly Expression[],
	assignment: readonly boolean[],
): boolean {
	const index = atoms.findIndex((candidate) =>
		deepEqual(candidate, expression),
	);
	if (index >= 0) return assignment[index] ?? false;
	if (expression.kind === "and")
		return expression.clauses.every((clause) =>
			evaluate(clause, atoms, assignment),
		);
	if (expression.kind === "not")
		return !evaluate(expression.clause, atoms, assignment);
	throw new Error(`no atom for ${JSON.stringify(expression)}`);
}

/** The frames the mapped form pushes: every destination that holds, and the
 *  otherwise when no destination that may not run holds. */
function newFrames(
	doc: BlueprintDoc,
	atoms: readonly Expression[],
	assignment: readonly boolean[],
): string[] {
	const form = doc.forms[SOURCE];
	const destinations = form?.formLinks ?? [];
	const frames: string[] = [];
	let conditionalRan = false;
	for (const destination of destinations) {
		if (destination.condition === undefined) {
			frames.push(destination.uuid);
			continue;
		}
		if (evaluate(destination.condition, atoms, assignment)) {
			frames.push(destination.uuid);
			conditionalRan = true;
		}
	}
	if (destinations.length === 0) {
		const after = form?.postSubmit ?? "app_home";
		return after === "app_home" ? [] : [`built-in:${after}`];
	}
	const otherwise = form?.otherwise;
	if (otherwise !== undefined && !conditionalRan)
		frames.push(
			otherwise.kind === "link"
				? otherwise.uuid
				: `built-in:${otherwise.destination}`,
		);
	return frames;
}

interface ClaimShape {
	readonly name: string;
	readonly conditions: readonly (Expression | undefined)[];
	readonly postSubmit: PostSubmitDestination | undefined;
}

/** Every shape the old validator admitted on one form, up to three links. */
function claimShapes(): ClaimShape[] {
	const shapes: ClaimShape[] = [];
	const afters: readonly (PostSubmitDestination | undefined)[] = [
		undefined,
		"app_home",
		"module",
		"previous",
	];
	for (let conditional = 1; conditional <= 3; conditional += 1) {
		const conditions = Array.from({ length: conditional }, (_, i) => atom(i));
		for (const terminalElse of [false, true]) {
			for (const postSubmit of afters) {
				// Every link conditional needed a stored after-submit.
				if (!terminalElse && postSubmit === undefined) continue;
				shapes.push({
					name: `${conditional} conditional${terminalElse ? " + else" : ""}, after-submit ${postSubmit ?? "unset"}`,
					conditions: terminalElse ? [...conditions, undefined] : conditions,
					postSubmit,
				});
			}
		}
	}
	for (const postSubmit of afters) {
		shapes.push({
			name: `one unconditional link, after-submit ${postSubmit ?? "unset"}`,
			conditions: [undefined],
			postSubmit,
		});
	}
	// An original condition that is itself a conjunction stays one atom.
	shapes.push({
		name: "a compound first condition",
		conditions: [and(atom(7), atom(8)), atom(1)],
		postSubmit: "module",
	});
	return shapes;
}

describe("the behavior claim", () => {
	for (const shape of claimShapes()) {
		it(`opens exactly the frame the old app did: ${shape.name}`, () => {
			const links = shape.conditions.map((condition, index) =>
				link(`lnk-${index}`, condition, TARGETS[index % TARGETS.length]),
			);
			const doc = oldShape({
				links,
				...(shape.postSubmit !== undefined && {
					postSubmit: shape.postSubmit,
				}),
			});
			const { doc: next } = mapped(doc);
			// Registration's default after-submit is the app home.
			const oldAfter = shape.postSubmit ?? "app_home";
			const atoms = shape.conditions.filter(
				(condition): condition is Expression => condition !== undefined,
			);
			for (let bits = 0; bits < 2 ** atoms.length; bits += 1) {
				const assignment = atoms.map((_, i) => (bits & (1 << i)) !== 0);
				const values = new Map(
					atoms.map((condition, i) => [condition, assignment[i]] as const),
				);
				const before = oldFrames(
					links.map((entry) => ({
						uuid: entry.uuid,
						condition:
							entry.condition === undefined
								? undefined
								: values.get(entry.condition),
					})),
					oldAfter,
				);
				const after = newFrames(next, atoms, assignment);
				expect(before.length, JSON.stringify(assignment)).toBeLessThanOrEqual(
					1,
				);
				expect(after, JSON.stringify(assignment)).toEqual(before);
			}
		});
	}
});
