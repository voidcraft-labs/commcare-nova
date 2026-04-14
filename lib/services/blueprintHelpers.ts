/**
 * blueprintHelpers — standalone mutation and query functions for AppBlueprint.
 *
 * These functions operate directly on a mutable AppBlueprint object. On the
 * client they're called inside Immer drafts (via Zustand store actions). On
 * the server (SA agent) they're called on a plain mutable object.
 *
 * Every mutation function modifies its input in place and returns any output
 * the caller needs (e.g., new UUIDs, rename results). They never create or
 * return a new AppBlueprint — immutability is handled by Immer at the call site.
 *
 * Extracted from the former MutableBlueprint class. The class is gone — these
 * standalone functions are the canonical mutation/query API for blueprints.
 */

import { transformBareHashtags } from "../preview/engine/labelRefs";
import { rewriteHashtagRefs, rewriteXPathRefs } from "../preview/xpath/rewrite";
import type {
	AppBlueprint,
	BlueprintForm,
	BlueprintModule,
	CaseProperty,
	CaseType,
	ConnectConfig,
	FormType,
	PostSubmitDestination,
	Question,
} from "../schemas/blueprint";
import { normalizeConnectConfig } from "./connectConfig";
import {
	type QuestionPath,
	qpath,
	qpathId,
	qpathParent,
	reassignUuids,
} from "./questionPath";

// ── Result types ────────────────────────────────────────────────────────

export interface SearchResult {
	type: "module" | "form" | "question" | "case_list_column";
	moduleIndex: number;
	formIndex?: number;
	questionPath?: QuestionPath;
	/** Which field matched (e.g. 'label', 'case_property', 'id', 'name'). */
	field: string;
	/** The matched value. */
	value: string;
	/** Human-readable location string. */
	context: string;
}

export interface RenameResult {
	formsChanged: string[];
	columnsChanged: string[];
}

export interface QuestionRenameResult {
	newPath: QuestionPath;
	xpathFieldsRewritten: number;
	/** True when the rename was blocked because a sibling already has the
	 *  requested ID. When true, no mutation was applied. */
	conflict?: boolean;
}

// ── QuestionUpdate type ─────────────────────────────────────────────────

export interface QuestionUpdate {
	type: Question["type"];
	label: string | null;
	hint: string | null;
	required: string | null;
	validation: string | null;
	validation_msg: string | null;
	relevant: string | null;
	calculate: string | null;
	default_value: string | null;
	options: Array<{ value: string; label: string }> | null;
	case_property_on: string | null;
}

// ── NewQuestion type ────────────────────────────────────────────────────

export interface NewQuestion {
	id: string;
	type: Question["type"];
	label?: string;
	hint?: string;
	required?: string;
	validation?: string;
	validation_msg?: string;
	relevant?: string;
	calculate?: string;
	default_value?: string;
	options?: Array<{ value: string; label: string }>;
	case_property_on?: string;
	children?: NewQuestion[];
}

// ── Query helpers (pure, no mutation) ───────────────────────────────────

/**
 * Walk the question tree matching path segments to find a question and its
 * parent array. The parent array reference is needed for splice operations
 * (remove, insert, move).
 */
export function findByPath(
	questions: Question[],
	path: QuestionPath,
): { question: Question; parent: Question[] } | undefined {
	const segments = (path as string).split("/");
	let current = questions;
	for (let i = 0; i < segments.length - 1; i++) {
		const parent = current.find((q) => q.id === segments[i]);
		if (!parent?.children) return undefined;
		current = parent.children;
	}
	const lastId = segments[segments.length - 1];
	const question = current.find((q) => q.id === lastId);
	if (!question) return undefined;
	return { question, parent: current };
}

/** Recursive bare-ID search — returns the full QuestionPath for the first
 *  question whose `id` matches. Used by the SA agent to resolve user-facing
 *  IDs (flat names like "patient_name") to tree paths ("group1/patient_name"). */
export function resolveQuestionId(
	bp: AppBlueprint,
	mIdx: number,
	fIdx: number,
	bareId: string,
): QuestionPath | undefined {
	const form = bp.modules[mIdx]?.forms[fIdx];
	if (!form) return undefined;
	return findQuestionPath(form.questions, bareId, undefined);
}

/** Look up a question's stable UUID given its tree path. */
export function findUuidByPath(
	bp: AppBlueprint,
	mIdx: number,
	fIdx: number,
	path: QuestionPath,
): string | undefined {
	const form = bp.modules[mIdx]?.forms[fIdx];
	if (!form) return undefined;
	return findByPath(form.questions, path)?.question.uuid;
}

/** Full-text search across the entire blueprint — modules, forms, questions,
 *  columns, and all XPath/display fields. */
export function searchBlueprint(
	bp: AppBlueprint,
	query: string,
): SearchResult[] {
	const results: SearchResult[] = [];
	const q = query.toLowerCase();

	for (let mIdx = 0; mIdx < bp.modules.length; mIdx++) {
		const mod = bp.modules[mIdx];

		if (mod.name.toLowerCase().includes(q)) {
			results.push({
				type: "module",
				moduleIndex: mIdx,
				field: "name",
				value: mod.name,
				context: `Module ${mIdx} "${mod.name}"`,
			});
		}
		if (mod.case_type?.toLowerCase().includes(q)) {
			results.push({
				type: "module",
				moduleIndex: mIdx,
				field: "case_type",
				value: mod.case_type,
				context: `Module ${mIdx} "${mod.name}" case_type`,
			});
		}

		/* Case list + detail columns */
		const allColumns = [
			...(mod.case_list_columns || []),
			...(mod.case_detail_columns || []),
		];
		for (const col of allColumns) {
			if (
				col.field.toLowerCase().includes(q) ||
				col.header.toLowerCase().includes(q)
			) {
				results.push({
					type: "case_list_column",
					moduleIndex: mIdx,
					field: "column",
					value: `${col.field} (${col.header})`,
					context: `Module ${mIdx} "${mod.name}" column "${col.header}"`,
				});
			}
		}

		for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
			const form = mod.forms[fIdx];
			if (form.name.toLowerCase().includes(q)) {
				results.push({
					type: "form",
					moduleIndex: mIdx,
					formIndex: fIdx,
					field: "name",
					value: form.name,
					context: `m${mIdx}-f${fIdx} "${form.name}" (${form.type})`,
				});
			}
			searchQuestions(form.questions, q, mIdx, fIdx, results, undefined);
		}
	}

	return results;
}

/** Get the children array for a given parent path, or root questions if
 *  no parent. Initializes empty `children` arrays along the path as needed. */
export function getParentArray(
	questions: Question[],
	parentPath?: QuestionPath,
): Question[] {
	if (!parentPath) return questions;
	const segments = (parentPath as string).split("/");
	let current = questions;
	for (const seg of segments) {
		const parent = current.find((q) => q.id === seg);
		if (!parent) throw new Error(`Parent "${seg}" not found`);
		if (!parent.children) parent.children = [];
		current = parent.children;
	}
	return current;
}

/** Collect all question IDs in a tree (for duplicate-ID prevention). */
export function collectAllIds(questions: Question[]): Set<string> {
	const ids = new Set<string>();
	for (const q of questions) {
		ids.add(q.id);
		if (q.children) {
			for (const id of collectAllIds(q.children)) ids.add(id);
		}
	}
	return ids;
}

// ── Mutation helpers (modify blueprint in place) ────────────────────────

/** Set the data model case types. Used by generateSchema. */
export function setCaseTypes(bp: AppBlueprint, caseTypes: CaseType[]): void {
	bp.case_types = caseTypes;
}

/** Set app structure from scaffold output. Preserves case_types. */
export function setScaffold(
	bp: AppBlueprint,
	scaffold: {
		app_name: string;
		description?: string;
		connect_type?: "learn" | "deliver" | "";
		modules: Array<{
			name: string;
			case_type?: string | null;
			purpose?: string;
			forms: Array<{
				name: string;
				type: string;
				purpose?: string;
				formDesign?: string;
			}>;
		}>;
	},
): void {
	bp.app_name = scaffold.app_name;
	const connectType = scaffold.connect_type;
	if (connectType === "learn" || connectType === "deliver") {
		bp.connect_type = connectType;
	}
	/* Stamp uuids at the wire-format boundary so every module + form leaving
	 * setScaffold has stable identity. Matches how `newQuestionToBlueprint`
	 * mints question uuids on creation — see Task 4 of the Phase 3 plan. */
	bp.modules = scaffold.modules.map((sm) => ({
		uuid: crypto.randomUUID(),
		name: sm.name,
		...(sm.case_type != null && { case_type: sm.case_type }),
		forms: sm.forms.map((sf) => ({
			uuid: crypto.randomUUID(),
			name: sf.name,
			type: sf.type as FormType,
			questions: [],
		})),
	}));
}

/** Update top-level app fields. */
export function updateApp(
	bp: AppBlueprint,
	updates: { app_name?: string },
): void {
	if (updates.app_name !== undefined) bp.app_name = updates.app_name;
}

/** Update module fields. */
export function updateModule(
	bp: AppBlueprint,
	mIdx: number,
	updates: {
		name?: string;
		case_list_columns?: Array<{ field: string; header: string }>;
		case_detail_columns?: Array<{ field: string; header: string }> | null;
	},
): void {
	const mod = bp.modules[mIdx];
	if (!mod) throw new Error(`Module ${mIdx} not found`);

	if (updates.name !== undefined) mod.name = updates.name;
	if (updates.case_list_columns !== undefined) {
		mod.case_list_columns = updates.case_list_columns;
	}
	if (updates.case_detail_columns !== undefined) {
		if (updates.case_detail_columns === null) {
			delete mod.case_detail_columns;
		} else {
			mod.case_detail_columns = updates.case_detail_columns;
		}
	}
}

/** Update form fields. */
export function updateForm(
	bp: AppBlueprint,
	mIdx: number,
	fIdx: number,
	updates: {
		name?: string;
		type?: FormType;
		close_condition?: {
			question: string;
			answer: string;
			operator?: "=" | "selected";
		} | null;
		connect?: ConnectConfig | null;
		post_submit?: PostSubmitDestination | null;
	},
): void {
	const form = bp.modules[mIdx]?.forms[fIdx];
	if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`);

	if (updates.name !== undefined) form.name = updates.name;
	if (updates.type !== undefined) form.type = updates.type;
	if (updates.close_condition !== undefined) {
		if (updates.close_condition === null) {
			delete form.close_condition;
		} else {
			form.close_condition = updates.close_condition;
		}
	}
	if (updates.connect !== undefined) {
		if (updates.connect === null) {
			delete form.connect;
		} else {
			const normalized = normalizeConnectConfig(updates.connect);
			if (normalized) form.connect = normalized;
			else delete form.connect;
		}
	}
	if (updates.post_submit !== undefined) {
		if (updates.post_submit === null) {
			delete form.post_submit;
		} else {
			form.post_submit = updates.post_submit;
		}
	}
}

/** Replace a form entirely at the given index. The incoming form must
 *  carry the same uuid as the form being replaced — replaceForm by its
 *  nature means the caller already knows which form to swap, so a missing
 *  uuid is a bug, not a legitimate mint site. */
export function replaceForm(
	bp: AppBlueprint,
	mIdx: number,
	fIdx: number,
	form: BlueprintForm,
): void {
	const mod = bp.modules[mIdx];
	if (!mod) throw new Error(`Module ${mIdx} not found`);
	if (fIdx < 0 || fIdx >= mod.forms.length)
		throw new Error(`Form index ${fIdx} out of range`);
	if (!form.uuid) {
		throw new Error(
			`replaceForm: incoming form "${form.name}" missing uuid — replaceForm cannot mint identity, callers must preserve the existing uuid`,
		);
	}
	mod.forms[fIdx] = form;
}

/** Append a form to a module. Stamps a uuid if the caller didn't provide
 *  one — matches `newQuestionToBlueprint`'s producer-side mint pattern.
 *  The plan calls this an assignment site, not a fallback: every form
 *  leaving this helper has stable identity. Accepts a uuid-less form
 *  shape for SA tools that build form literals on the fly. */
export function addForm(
	bp: AppBlueprint,
	mIdx: number,
	form: Omit<BlueprintForm, "uuid"> & { uuid?: string },
): void {
	const mod = bp.modules[mIdx];
	if (!mod) throw new Error(`Module ${mIdx} not found`);
	mod.forms.push({ ...form, uuid: form.uuid ?? crypto.randomUUID() });
}

/** Remove a form from a module. */
export function removeForm(bp: AppBlueprint, mIdx: number, fIdx: number): void {
	const mod = bp.modules[mIdx];
	if (!mod) throw new Error(`Module ${mIdx} not found`);
	if (fIdx < 0 || fIdx >= mod.forms.length)
		throw new Error(`Form index ${fIdx} out of range`);
	mod.forms.splice(fIdx, 1);
}

/** Append a module to the blueprint. Stamps a uuid if the caller didn't
 *  provide one — same pattern as `addForm` and `newQuestionToBlueprint`.
 *  Producer-side assignment, not a fallback. Accepts a uuid-less module
 *  shape for SA tools that build module literals on the fly. */
export function addModule(
	bp: AppBlueprint,
	module: Omit<BlueprintModule, "uuid"> & { uuid?: string },
): void {
	bp.modules.push({ ...module, uuid: module.uuid ?? crypto.randomUUID() });
}

/** Remove a module from the blueprint. */
export function removeModule(bp: AppBlueprint, mIdx: number): void {
	if (mIdx < 0 || mIdx >= bp.modules.length)
		throw new Error(`Module ${mIdx} out of range`);
	bp.modules.splice(mIdx, 1);
}

/** Update a single question's fields. Null removes the field, undefined skips it. */
export function updateQuestion(
	bp: AppBlueprint,
	mIdx: number,
	fIdx: number,
	questionPath: QuestionPath,
	updates: Partial<QuestionUpdate>,
): Question {
	const form = bp.modules[mIdx]?.forms[fIdx];
	if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`);

	const found = findByPath(form.questions, questionPath);
	if (!found)
		throw new Error(
			`Question "${questionPath}" not found in m${mIdx}-f${fIdx}`,
		);

	const question = found.question;
	const record = question as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined) continue;
		if (value === null) {
			delete record[key];
		} else {
			record[key] = value;
		}
	}

	return question;
}

/** Add a question to a form. Returns the new question's stable UUID. */
export function addQuestion(
	bp: AppBlueprint,
	mIdx: number,
	fIdx: number,
	question: NewQuestion,
	opts?: {
		afterPath?: QuestionPath;
		beforePath?: QuestionPath;
		atIndex?: number;
		parentPath?: QuestionPath;
	},
): string {
	const form = bp.modules[mIdx]?.forms[fIdx];
	if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`);

	const newQ = newQuestionToBlueprint(question);

	let arr: Question[];
	if (opts?.parentPath) {
		const parent = findByPath(form.questions, opts.parentPath);
		if (!parent)
			throw new Error(`Parent question "${opts.parentPath}" not found`);
		if (!parent.question.children) parent.question.children = [];
		arr = parent.question.children;
	} else {
		arr = form.questions;
	}

	if (opts?.atIndex !== undefined) {
		arr.splice(opts.atIndex, 0, newQ);
	} else {
		const afterId = opts?.afterPath ? qpathId(opts.afterPath) : undefined;
		const beforeId = opts?.beforePath ? qpathId(opts.beforePath) : undefined;
		insertIntoArray(arr, newQ, afterId, beforeId);
	}

	return newQ.uuid;
}

/** Remove a question from a form. */
export function removeQuestion(
	bp: AppBlueprint,
	mIdx: number,
	fIdx: number,
	questionPath: QuestionPath,
): void {
	const form = bp.modules[mIdx]?.forms[fIdx];
	if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`);

	const found = findByPath(form.questions, questionPath);
	if (!found)
		throw new Error(
			`Question "${questionPath}" not found in m${mIdx}-f${fIdx}`,
		);

	const idx = found.parent.indexOf(found.question);
	if (idx !== -1) found.parent.splice(idx, 1);

	const bareId = qpathId(questionPath);
	if (form.close_condition?.question === bareId) {
		delete form.close_condition;
	}
}

/** Move a question within a form (same-level or cross-level). */
export function moveQuestion(
	bp: AppBlueprint,
	mIdx: number,
	fIdx: number,
	questionPath: QuestionPath,
	opts: {
		afterPath?: QuestionPath;
		beforePath?: QuestionPath;
		targetParentPath?: QuestionPath;
	},
): void {
	const form = bp.modules[mIdx]?.forms[fIdx];
	if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`);

	/* No-op if moving relative to itself */
	if (opts.afterPath === questionPath || opts.beforePath === questionPath)
		return;

	const isCrossLevel = "targetParentPath" in opts;

	/* Prevent circular nesting — can't move a group into itself or its descendants */
	if (isCrossLevel && opts.targetParentPath !== undefined) {
		const targetStr = opts.targetParentPath as string;
		const draggedStr = questionPath as string;
		if (targetStr === draggedStr || targetStr.startsWith(`${draggedStr}/`))
			return;
	}

	const found = findByPath(form.questions, questionPath);
	if (!found)
		throw new Error(
			`Question "${questionPath}" not found in m${mIdx}-f${fIdx}`,
		);

	/* Remove from current position */
	const idx = found.parent.indexOf(found.question);
	if (idx !== -1) found.parent.splice(idx, 1);

	/* Determine target array — cross-level uses targetParentPath, otherwise same parent */
	const targetArray = isCrossLevel
		? getParentArray(form.questions, opts.targetParentPath)
		: found.parent;

	const afterId = opts.afterPath ? qpathId(opts.afterPath) : undefined;
	const beforeId = opts.beforePath ? qpathId(opts.beforePath) : undefined;
	insertIntoArray(targetArray, found.question, afterId, beforeId);
}

/** Duplicate a question, returning its new path and stable UUID. */
export function duplicateQuestion(
	bp: AppBlueprint,
	mIdx: number,
	fIdx: number,
	questionPath: QuestionPath,
): { newPath: QuestionPath; newUuid: string } {
	const form = bp.modules[mIdx]?.forms[fIdx];
	if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`);

	const found = findByPath(form.questions, questionPath);
	if (!found)
		throw new Error(
			`Question "${questionPath}" not found in m${mIdx}-f${fIdx}`,
		);

	/* Deep-clone and generate new ID */
	const clone: Question = structuredClone(found.question);
	let newId = `${clone.id}_copy`;
	const allIds = collectAllIds(form.questions);
	if (allIds.has(newId)) {
		let counter = 2;
		while (allIds.has(`${clone.id}_${counter}`)) counter++;
		newId = `${clone.id}_${counter}`;
	}
	clone.id = newId;

	/* Fresh UUIDs for the clone and all descendants — identity must be unique */
	reassignUuids([clone]);

	/* Clear case mapping on the clone to avoid duplicate mappings */
	delete clone.case_property_on;

	insertIntoArray(found.parent, clone, qpathId(questionPath));
	return {
		newPath: qpath(newId, qpathParent(questionPath)),
		newUuid: clone.uuid,
	};
}

/** Rename a question and rewrite XPath references in sibling questions. */
export function renameQuestion(
	bp: AppBlueprint,
	mIdx: number,
	fIdx: number,
	questionPath: QuestionPath,
	newId: string,
): QuestionRenameResult {
	const form = bp.modules[mIdx]?.forms[fIdx];
	if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`);

	const found = findByPath(form.questions, questionPath);
	if (!found)
		throw new Error(
			`Question "${questionPath}" not found in m${mIdx}-f${fIdx}`,
		);

	const oldId = found.question.id;
	const oldXPathPath = questionPath as string;
	found.question.id = newId;

	let xpathFieldsRewritten = 0;
	xpathFieldsRewritten += rewriteXPathInQuestions(
		form.questions,
		oldXPathPath,
		newId,
	);

	if (form.close_condition?.question === oldId) {
		form.close_condition.question = newId;
	}

	const newPath = qpath(newId, qpathParent(questionPath));
	return { newPath, xpathFieldsRewritten };
}

/** Rename a case property across all modules, forms, questions, and columns. */
export function renameCaseProperty(
	bp: AppBlueprint,
	caseType: string,
	oldName: string,
	newName: string,
): RenameResult {
	const formsChanged: string[] = [];
	const columnsChanged: string[] = [];

	for (let mIdx = 0; mIdx < bp.modules.length; mIdx++) {
		const mod = bp.modules[mIdx];
		if (mod.case_type !== caseType) continue;

		for (const columns of [mod.case_list_columns, mod.case_detail_columns]) {
			if (columns) {
				for (const col of columns) {
					if (col.field === oldName) {
						col.field = newName;
						if (!columnsChanged.includes(`m${mIdx}`))
							columnsChanged.push(`m${mIdx}`);
					}
				}
			}
		}

		for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
			const form = mod.forms[fIdx];
			const formChanged = renamePropertyInQuestions(
				form.questions,
				oldName,
				newName,
			);
			if (formChanged) {
				formsChanged.push(`m${mIdx}-f${fIdx}`);
			}
		}
	}

	return { formsChanged, columnsChanged };
}

/** Update a case property on a case type. */
export function updateCaseProperty(
	bp: AppBlueprint,
	caseTypeName: string,
	propertyName: string,
	updates: Partial<Omit<CaseProperty, "name">>,
): void {
	const ct = bp.case_types?.find((c) => c.name === caseTypeName);
	if (!ct) throw new Error(`Case type "${caseTypeName}" not found`);
	const prop = ct.properties.find((p) => p.name === propertyName);
	if (!prop)
		throw new Error(
			`Property "${propertyName}" not found on case type "${caseTypeName}"`,
		);
	Object.assign(prop, updates);
}

// ── Internal helpers ────────────────────────────────────────────────────

/** Insert an item into an array after/before a given ID, or at the end. */
function insertIntoArray(
	arr: Question[],
	item: Question,
	afterId?: string,
	beforeId?: string,
): void {
	if (beforeId) {
		const idx = arr.findIndex((q) => q.id === beforeId);
		if (idx === -1) {
			arr.push(item);
		} else {
			arr.splice(idx, 0, item);
		}
		return;
	}
	if (!afterId) {
		arr.push(item);
		return;
	}
	const idx = arr.findIndex((q) => q.id === afterId);
	if (idx === -1) {
		arr.push(item);
	} else {
		arr.splice(idx + 1, 0, item);
	}
}

/** Convert a NewQuestion (SA/UI input shape) to a full Question with UUID. */
function newQuestionToBlueprint(nq: NewQuestion): Question {
	return {
		uuid: crypto.randomUUID(),
		id: nq.id,
		type: nq.type,
		...(nq.label != null && { label: nq.label }),
		...(nq.hint != null && { hint: nq.hint }),
		...(nq.required != null && { required: nq.required }),
		...(nq.validation != null && { validation: nq.validation }),
		...(nq.validation_msg != null && { validation_msg: nq.validation_msg }),
		...(nq.relevant != null && { relevant: nq.relevant }),
		...(nq.calculate != null && { calculate: nq.calculate }),
		...(nq.default_value != null && { default_value: nq.default_value }),
		...(nq.options != null && { options: nq.options }),
		...(nq.case_property_on != null && {
			case_property_on: nq.case_property_on,
		}),
		...((nq.type === "group" || nq.type === "repeat") && {
			children: (nq.children ?? []).map((c) => newQuestionToBlueprint(c)),
		}),
	};
}

/** Recursive search within a form's questions. */
function searchQuestions(
	questions: Question[],
	query: string,
	mIdx: number,
	fIdx: number,
	results: SearchResult[],
	parent: QuestionPath | undefined,
): void {
	for (const q of questions) {
		const questionPath = qpath(q.id, parent);
		const formRef = `m${mIdx}-f${fIdx}`;
		const matchFields: Array<{ field: string; value: string }> = [];

		if (q.id.toLowerCase().includes(query))
			matchFields.push({ field: "id", value: q.id });
		if (q.label?.toLowerCase().includes(query))
			matchFields.push({ field: "label", value: q.label });
		if (q.case_property_on && q.id.toLowerCase().includes(query))
			matchFields.push({
				field: "case_property",
				value: `${q.id}→${q.case_property_on}`,
			});
		if (q.validation?.toLowerCase().includes(query))
			matchFields.push({ field: "validation", value: q.validation });
		if (q.relevant?.toLowerCase().includes(query))
			matchFields.push({ field: "relevant", value: q.relevant });
		if (q.calculate?.toLowerCase().includes(query))
			matchFields.push({ field: "calculate", value: q.calculate });
		if (q.default_value?.toLowerCase().includes(query))
			matchFields.push({ field: "default_value", value: q.default_value });
		if (q.validation_msg?.toLowerCase().includes(query))
			matchFields.push({ field: "validation_msg", value: q.validation_msg });
		if (q.hint?.toLowerCase().includes(query))
			matchFields.push({ field: "hint", value: q.hint });

		if (q.options && q.options.length > 0) {
			for (const opt of q.options) {
				if (
					opt.value.toLowerCase().includes(query) ||
					opt.label.toLowerCase().includes(query)
				) {
					matchFields.push({
						field: "option",
						value: `${opt.value}: ${opt.label}`,
					});
					break;
				}
			}
		}

		for (const match of matchFields) {
			results.push({
				type: "question",
				moduleIndex: mIdx,
				formIndex: fIdx,
				questionPath,
				field: match.field,
				value: match.value,
				context: `${formRef} question "${q.id}" (${q.type}${q.case_property_on ? `, case_property_on:${q.case_property_on}` : ""})`,
			});
		}

		if (q.children) {
			searchQuestions(q.children, query, mIdx, fIdx, results, questionPath);
		}
	}
}

/** Recursive bare-ID search, returns full QuestionPath. */
function findQuestionPath(
	questions: Question[],
	id: string,
	parent: QuestionPath | undefined,
): QuestionPath | undefined {
	for (const q of questions) {
		const path = qpath(q.id, parent);
		if (q.id === id) return path;
		if (q.children) {
			const found = findQuestionPath(q.children, id, path);
			if (found) return found;
		}
	}
	return undefined;
}

/** Rewrite XPath path references in all questions (used by renameQuestion). */
function rewriteXPathInQuestions(
	questions: Question[],
	oldPath: string,
	newId: string,
): number {
	const xpathFields = [
		"relevant",
		"calculate",
		"default_value",
		"validation",
	] as const;
	const displayFields = ["label", "hint"] as const;
	const rewriter = (expr: string) => rewriteXPathRefs(expr, oldPath, newId);
	let count = 0;
	for (const q of questions) {
		for (const field of xpathFields) {
			const val = q[field];
			if (!val) continue;
			const rewritten = rewriter(val);
			if (rewritten !== val) {
				(q as unknown as Record<string, unknown>)[field] = rewritten;
				count++;
			}
		}
		for (const field of displayFields) {
			const text = q[field];
			if (!text) continue;
			const rewritten = transformBareHashtags(text, rewriter);
			if (rewritten !== text) {
				(q as unknown as Record<string, unknown>)[field] = rewritten;
				count++;
			}
		}
		if (q.children) {
			count += rewriteXPathInQuestions(q.children, oldPath, newId);
		}
	}
	return count;
}

/** Rename a case property in all questions (ID + XPath + hashtag refs). */
function renamePropertyInQuestions(
	questions: Question[],
	oldName: string,
	newName: string,
): boolean {
	const xpathFields = [
		"relevant",
		"calculate",
		"default_value",
		"validation",
	] as const;
	const displayFields = ["label", "hint"] as const;
	const hashtagRewriter = (expr: string) =>
		rewriteHashtagRefs(expr, "#case/", oldName, newName);
	const pathRewriter = (expr: string) =>
		rewriteXPathRefs(expr, oldName, newName);
	let changed = false;
	for (const q of questions) {
		if (q.id === oldName && q.case_property_on) {
			q.id = newName;
			changed = true;
		}
		for (const field of xpathFields) {
			const val = q[field];
			if (!val) continue;
			let rewritten = hashtagRewriter(val);
			rewritten = pathRewriter(rewritten);
			if (rewritten !== val) {
				(q as unknown as Record<string, unknown>)[field] = rewritten;
				changed = true;
			}
		}
		for (const field of displayFields) {
			const text = q[field];
			if (!text) continue;
			const rewritten = transformBareHashtags(text, (hashtag) =>
				pathRewriter(hashtagRewriter(hashtag)),
			);
			if (rewritten !== text) {
				(q as unknown as Record<string, unknown>)[field] = rewritten;
				changed = true;
			}
		}
		if (q.children) {
			changed =
				renamePropertyInQuestions(q.children, oldName, newName) || changed;
		}
	}
	return changed;
}
