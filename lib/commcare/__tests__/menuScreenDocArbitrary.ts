/**
 * Documents whose menus show their forms in the menu above, for the suite
 * oracle corpus `menu-screens`, the frame invariant and the case-first
 * parity over the wire.
 *
 * Over a document `suiteDocArbitrary` draws, the second module is nested
 * under the first where the draw says so (the shape the workflow corpus
 * nests), each module is drawn to show its forms in the menu above, one
 * form may hold an after-submit link to another form, one form an entry
 * point, and one registration form may be offered by a case list that
 * always offers it (`caseListRegistrationForm`'s `always` arm): a bare case
 * list of the form's case type, added at the top level or under the first
 * module, returning to its list or on with the new case. So the corpus meets
 * every shape `lib/domain/menuScreens.ts` names: a top-level menu above, a
 * submenu above in a parent that keeps its screen, a submenu above under a
 * parent above, a submenu that keeps its screen under a parent above, and
 * links, entry points and Register returns into each.
 *
 * Every document the corpus holds is one the commit gate admits. A menu
 * drawn above loses its search, which the gate refuses there, and a form
 * whose display condition reads a case its screen no longer chooses first
 * loses that condition. Where the drawn edits are still refused, the link
 * goes first, then the entry point, then the Register host's place under the
 * first module, then the Register host, then the slot from the last module
 * drawn to the first, until the gate admits what is left. The edits are applied after the draw with no
 * random call of their own, so a draw of `suiteDocArbitrary` is the same
 * whether or not this arbitrary reads it.
 */
import * as fc from "fast-check";
import { testUuid } from "@/__tests__/helpers/uuid";
import { runValidation } from "@/lib/commcare/validator/runner";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	alwaysOfferedRegistrationOf,
	type BlueprintDoc,
	CASE_LIST_REGISTRATION_RETURNS,
	type CaseListRegistrationReturn,
	moduleShowsFormsInMenuAbove,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { suiteDocArbitrary } from "./suiteDocArbitrary";

/** The link and the entry point the draw may add. */
export const MENU_SCREENS_LINK = testUuid("menu-screens-link");
export const MENU_SCREENS_ENTRY_POINT = testUuid("menu-screens-entry-point");
/** The bare case list the draw may add, which always offers a registration
 *  form of another menu, and its one column. */
export const MENU_SCREENS_REGISTER_HOST = testUuid(
	"menu-screens-register-host",
);
const MENU_SCREENS_REGISTER_COLUMN = testUuid("menu-screens-register-column");

interface MenuScreenDraw {
	readonly nest: boolean;
	readonly above: readonly boolean[];
	readonly link: { readonly from: number; readonly to: number } | undefined;
	readonly entryPoint: number | undefined;
	readonly register:
		| {
				readonly form: number;
				readonly nested: boolean;
				readonly afterSubmit: CaseListRegistrationReturn;
		  }
		| undefined;
}

const drawArbitrary: fc.Arbitrary<MenuScreenDraw> = fc.record({
	nest: fc.boolean(),
	above: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
	link: fc.option(fc.record({ from: fc.nat(15), to: fc.nat(15) }), {
		nil: undefined,
	}),
	entryPoint: fc.option(fc.nat(15), { nil: undefined }),
	register: fc.option(
		fc.record({
			form: fc.nat(15),
			nested: fc.boolean(),
			afterSubmit: fc.constantFrom(...CASE_LIST_REGISTRATION_RETURNS),
		}),
		{ nil: undefined },
	),
});

/** Every form with the module holding it, in module then form order. */
function formsInOrder(
	doc: BlueprintDoc,
): readonly { readonly moduleUuid: Uuid; readonly formUuid: Uuid }[] {
	return doc.moduleOrder.flatMap((moduleUuid) =>
		(doc.formOrder[moduleUuid] ?? []).map((formUuid) => ({
			moduleUuid,
			formUuid,
		})),
	);
}

/** The document the gate admits after the two repairs the slot needs, or
 *  `undefined` where it refuses something else. */
function admittedWithRepairs(doc: BlueprintDoc): BlueprintDoc | undefined {
	rebuildFieldParent(doc);
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length === 0) return doc;
	if (
		!findings.every(
			(finding) =>
				finding.code === "FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE" &&
				finding.location.formUuid !== undefined,
		)
	)
		return undefined;
	for (const finding of findings) {
		const formUuid = finding.location.formUuid as Uuid;
		const { displayCondition: _dropped, ...form } = doc.forms[formUuid];
		doc.forms[formUuid] = form;
	}
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).length === 0
		? doc
		: undefined;
}

interface Edits {
	readonly above: readonly Uuid[];
	readonly link: { readonly source: Uuid; readonly target: Uuid } | undefined;
	readonly entryPoint: Uuid | undefined;
	readonly register:
		| {
				readonly formUuid: Uuid;
				readonly nested: boolean;
				readonly afterSubmit: CaseListRegistrationReturn;
		  }
		| undefined;
}

/** Adds the bare case list of the registration form's case type that always
 *  offers it, under the first module where `nested` says so, else after
 *  every module. */
function addRegisterHost(
	doc: BlueprintDoc,
	register: NonNullable<Edits["register"]>,
): void {
	const { formUuid, nested, afterSubmit } = register;
	const formModule = formsInOrder(doc).find(
		(f) => f.formUuid === formUuid,
	)?.moduleUuid;
	const caseType =
		formModule === undefined ? undefined : doc.modules[formModule]?.caseType;
	if (caseType === undefined) return;
	const [root] = doc.moduleOrder;
	const parent = nested ? root : undefined;
	const column = plainColumn(MENU_SCREENS_REGISTER_COLUMN, "case_name", "Name");
	doc.modules[MENU_SCREENS_REGISTER_HOST] = {
		uuid: MENU_SCREENS_REGISTER_HOST,
		id: "register_host",
		name: "Register host",
		caseType,
		...(parent !== undefined && { parentModuleUuid: parent }),
		caseListConfig: {
			columns: [column],
			listColumnOrder: [column.uuid],
			detailColumnOrder: [column.uuid],
			searchInputs: [],
		},
		caseListMenuItem: {},
		caseListRegistrationForm: { kind: "always", formUuid, afterSubmit },
	};
	doc.formOrder[MENU_SCREENS_REGISTER_HOST] = [];
	// A child follows its parent's block, which `moduleOrder` keeps whole.
	const at =
		parent === undefined
			? doc.moduleOrder.length
			: doc.moduleOrder.findLastIndex(
					(uuid) =>
						uuid === parent || doc.modules[uuid]?.parentModuleUuid === parent,
				) + 1;
	doc.moduleOrder.splice(at, 0, MENU_SCREENS_REGISTER_HOST);
}

/** The nested draw with the edits applied. */
function applied(base: BlueprintDoc, edits: Edits): BlueprintDoc {
	const doc = structuredClone(base);
	for (const moduleUuid of edits.above) {
		const { caseSearchConfig: _search, ...mod } = doc.modules[moduleUuid];
		doc.modules[moduleUuid] = { ...mod, formsInMenuAbove: true };
	}
	const forms = formsInOrder(doc);
	if (edits.link !== undefined) {
		const { source, target } = edits.link;
		const targetModule = forms.find((f) => f.formUuid === target)?.moduleUuid;
		if (targetModule !== undefined)
			doc.forms[source] = {
				...doc.forms[source],
				formLinks: [
					{
						uuid: MENU_SCREENS_LINK,
						target: {
							type: "form",
							moduleUuid: targetModule,
							formUuid: target,
						},
					},
				],
			};
	}
	if (edits.entryPoint !== undefined)
		doc.forms[edits.entryPoint] = {
			...doc.forms[edits.entryPoint],
			entryPoint: { uuid: MENU_SCREENS_ENTRY_POINT, id: "menu-screens-entry" },
		};
	if (edits.register !== undefined) addRegisterHost(doc, edits.register);
	rebuildFieldParent(doc);
	return doc;
}

/** The drawn document with the edits the gate admits. */
export function withMenuScreens(
	drawn: BlueprintDoc,
	draw: MenuScreenDraw,
): BlueprintDoc {
	const base = structuredClone(drawn);
	const [root, child] = base.moduleOrder;
	if (draw.nest && root !== undefined && child !== undefined)
		base.modules[child] = { ...base.modules[child], parentModuleUuid: root };
	rebuildFieldParent(base);
	const forms = formsInOrder(base);
	const pick = (index: number | undefined) =>
		index === undefined || forms.length === 0
			? undefined
			: forms[index % forms.length]?.formUuid;
	let above = base.moduleOrder.filter((_, index) => draw.above[index] === true);
	const source = pick(draw.link?.from);
	const target = pick(draw.link?.to);
	let link =
		source !== undefined && target !== undefined && source !== target
			? { source, target }
			: undefined;
	let entryPoint = pick(draw.entryPoint);
	const registrations = forms.filter(
		(f) => base.forms[f.formUuid]?.type === "registration",
	);
	const registerForm =
		draw.register === undefined || registrations.length === 0
			? undefined
			: registrations[draw.register.form % registrations.length]?.formUuid;
	let register =
		draw.register === undefined || registerForm === undefined
			? undefined
			: {
					formUuid: registerForm,
					nested: draw.register.nested,
					afterSubmit: draw.register.afterSubmit,
				};
	for (;;) {
		const edits = { above, link, entryPoint, register };
		const doc = admittedWithRepairs(applied(base, edits));
		if (doc !== undefined) return doc;
		if (link !== undefined) link = undefined;
		else if (entryPoint !== undefined) entryPoint = undefined;
		else if (register?.nested === true)
			register = { ...register, nested: false };
		else if (register !== undefined) register = undefined;
		else if (above.length > 0) above = above.slice(0, -1);
		else return applied(base, edits);
	}
}

export const menuScreenDocArbitrary: fc.Arbitrary<BlueprintDoc> = fc
	.tuple(suiteDocArbitrary, drawArbitrary)
	.map(([doc, draw]) => withMenuScreens(doc, draw));

/** The shapes the `menu-screens` corpus must keep drawing. */
export interface MenuScreensCensus {
	total: number;
	above: number;
	topLevelAbove: number;
	submenuAboveInParentWithScreen: number;
	submenuUnderParentAbove: number;
	link: number;
	entryPoint: number;
	register: number;
	registerUnderParent: number;
	registerNewCase: number;
}

export function emptyMenuScreensCensus(): MenuScreensCensus {
	return {
		total: 0,
		above: 0,
		topLevelAbove: 0,
		submenuAboveInParentWithScreen: 0,
		submenuUnderParentAbove: 0,
		link: 0,
		entryPoint: 0,
		register: 0,
		registerUnderParent: 0,
		registerNewCase: 0,
	};
}

export function countMenuScreens(
	census: MenuScreensCensus,
	doc: BlueprintDoc,
): void {
	census.total++;
	const modules = doc.moduleOrder.map((uuid) => doc.modules[uuid]);
	const isAbove = (uuid: Uuid | undefined) =>
		uuid !== undefined && moduleShowsFormsInMenuAbove(doc.modules[uuid]);
	if (modules.some((mod) => moduleShowsFormsInMenuAbove(mod))) census.above++;
	if (
		modules.some(
			(mod) =>
				moduleShowsFormsInMenuAbove(mod) && mod.parentModuleUuid === undefined,
		)
	)
		census.topLevelAbove++;
	if (
		modules.some(
			(mod) =>
				moduleShowsFormsInMenuAbove(mod) &&
				mod.parentModuleUuid !== undefined &&
				!isAbove(mod.parentModuleUuid),
		)
	)
		census.submenuAboveInParentWithScreen++;
	if (modules.some((mod) => isAbove(mod.parentModuleUuid)))
		census.submenuUnderParentAbove++;
	const forms = Object.values(doc.forms);
	if (forms.some((form) => form.formLinks !== undefined)) census.link++;
	if (forms.some((form) => form.entryPoint !== undefined)) census.entryPoint++;
	const register = alwaysOfferedRegistrationOf(doc, MENU_SCREENS_REGISTER_HOST);
	if (register !== undefined) {
		census.register++;
		if (doc.modules[MENU_SCREENS_REGISTER_HOST]?.parentModuleUuid !== undefined)
			census.registerUnderParent++;
		if (register.afterSubmit === "new-case") census.registerNewCase++;
	}
}
