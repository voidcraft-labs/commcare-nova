/**
 * The Nova side of the cutover's matcher, walked from the raw pre-step
 * carriers before any transform step runs.
 *
 * It gives every menu in the order the pre-step emitter wrote them, with its
 * stored `name` and `caseType`, and under each every form in order, with its
 * stored `name` and its set of authored leaf paths: a question's path is its
 * container chain's ids and its own id under `/data`, which is what the
 * pre-step emitter wrote. A container adds its id as a step, a repeat whose
 * `repeat_mode` is `query_bound` adds the step `item` after it, and a
 * container under which the walk added no leaf is a leaf itself, since the
 * pre-step emitter wrote it as an element with no element child.
 *
 * A no-matches registration form is lifted into a hidden menu appended after
 * the authored menus exactly where the pre-step emission plan lifted it: its
 * entry is `search-no-matches`, it is the first such form of its menu, the
 * menu's stored Search opens first and the menu has a case type. That menu's
 * uuid is `syntheticModuleUuid` of the form, its name the form's and its case
 * type its host's.
 *
 * No production function reads the pre-step document here: neither the
 * emission plan nor `collectFieldLocations` accepts one at the head of the
 * stack. `__tests__/questionPaths.test.ts` held this walk equal to them, in
 * the tree whose schema was still the pre-step one, and holds it to each
 * frozen fixture's `paths.json` from then on.
 */

import { syntheticModuleUuid } from "@/lib/commcare/emissionPlan";
import { asUuid } from "@/lib/domain";
import {
	type JsonRecord,
	RAW_CONTAINER_KINDS,
	type RawDocument,
} from "./oldShape";

export interface QuestionPathForm {
	readonly uuid: string;
	readonly name: string;
	/** Every authored leaf path, in the walk's order. */
	readonly paths: readonly string[];
}

export interface QuestionPathMenu {
	readonly uuid: string;
	readonly name: string;
	/** The menu's stored case type; null where it has none. */
	readonly caseType: string | null;
	/** Whether this is the hidden menu a no-matches form is lifted into. */
	readonly lifted: boolean;
	readonly forms: readonly QuestionPathForm[];
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function caseTypeOf(menu: JsonRecord | undefined): string | null {
	const caseType = menu?.caseType;
	return typeof caseType === "string" && caseType !== "" ? caseType : null;
}

function opensOnSearch(menu: JsonRecord | undefined): boolean {
	const config = menu?.caseSearchConfig;
	return (
		config !== null &&
		typeof config === "object" &&
		!Array.isArray(config) &&
		(config as JsonRecord).searchFirst === true
	);
}

function isNoMatchesForm(form: JsonRecord): boolean {
	const entry = form.entry;
	return (
		entry !== null &&
		typeof entry === "object" &&
		!Array.isArray(entry) &&
		(entry as JsonRecord).kind === "search-no-matches"
	);
}

/** The authored leaf paths of one form, from its field rows. */
export function formLeafPaths(
	document: RawDocument,
	formUuid: string,
): string[] {
	const paths: string[] = [];
	const walk = (parentUuid: string, parentPath: string): void => {
		for (const uuid of document.fieldOrder[parentUuid] ?? []) {
			const field = document.fields[uuid];
			if (field === undefined) continue;
			const path = `${parentPath}/${text(field.id)}`;
			if (!RAW_CONTAINER_KINDS.has(text(field.kind))) {
				paths.push(path);
				continue;
			}
			const childPath =
				field.kind === "repeat" && field.repeat_mode === "query_bound"
					? `${path}/item`
					: path;
			const before = paths.length;
			walk(uuid, childPath);
			if (paths.length === before) paths.push(childPath);
		}
	};
	walk(formUuid, "/data");
	return paths;
}

/** Every menu of the pre-step emission, in its order, with its forms' paths. */
export function questionPaths(
	document: RawDocument,
): readonly QuestionPathMenu[] {
	const authored: QuestionPathMenu[] = [];
	const lifted: QuestionPathMenu[] = [];
	const formOf = (uuid: string, form: JsonRecord): QuestionPathForm => ({
		uuid,
		name: text(form.name),
		paths: formLeafPaths(document, uuid),
	});
	for (const menuUuid of document.moduleOrder) {
		const menu = document.modules[menuUuid];
		const caseType = caseTypeOf(menu);
		const liftsNoMatches = opensOnSearch(menu) && caseType !== null;
		let liftedOne = false;
		const forms: QuestionPathForm[] = [];
		for (const formUuid of document.formOrder[menuUuid] ?? []) {
			const form = document.forms[formUuid];
			if (form === undefined) continue;
			if (liftsNoMatches && !liftedOne && isNoMatchesForm(form)) {
				liftedOne = true;
				lifted.push({
					uuid: syntheticModuleUuid(asUuid(formUuid)),
					name: text(form.name),
					caseType,
					lifted: true,
					forms: [formOf(formUuid, form)],
				});
				continue;
			}
			forms.push(formOf(formUuid, form));
		}
		authored.push({
			uuid: menuUuid,
			name: text(menu?.name),
			caseType,
			lifted: false,
			forms,
		});
	}
	return [...authored, ...lifted];
}
