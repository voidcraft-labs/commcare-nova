import Fuse from "fuse.js";
import type { Question } from "@/lib/schemas/blueprint";
import type { TreeData } from "@/lib/services/builder";
import { qpath, type QuestionPath } from "@/lib/services/questionPath";

/** Match indices as [start, end] pairs for highlighting */
export type MatchIndices = ReadonlyArray<readonly [number, number]>;

export interface FilterResult {
	/** Pruned tree containing only matching branches */
	data: TreeData;
	/** Collapse keys to force open (e.g. "m0", "f0_1", question paths) */
	forceExpand: Set<string>;
	/** Node key → match indices for highlighting. Keys: "m{i}" for modules, "f{mi}_{fi}" for forms, question paths for questions */
	matchMap: Map<string, MatchIndices>;
}

/** Flat searchable item with location metadata */
interface SearchItem {
	text: string;
	/** Which field matched — used to pick the best match per node */
	field: "label" | "id" | "name";
	/** Key for matchMap and forceExpand lookups */
	nodeKey: string;
	kind: "module" | "form" | "question";
	moduleIndex: number;
	formIndex: number;
	/** Only for questions */
	questionPath?: QuestionPath;
}

/**
 * Filter a TreeData structure by a fuzzy search query.
 * Returns null when query is empty (signals "show everything").
 */
export function filterTree(data: TreeData, query: string): FilterResult | null {
	const trimmed = query.trim();
	if (!trimmed) return null;

	// Step 1: Flatten all searchable items
	const items: SearchItem[] = [];

	for (let mi = 0; mi < data.modules.length; mi++) {
		const mod = data.modules[mi];
		items.push({
			text: mod.name,
			field: "name",
			nodeKey: `m${mi}`,
			kind: "module",
			moduleIndex: mi,
			formIndex: -1,
		});

		for (let fi = 0; fi < mod.forms.length; fi++) {
			const form = mod.forms[fi];
			items.push({
				text: form.name,
				field: "name",
				nodeKey: `f${mi}_${fi}`,
				kind: "form",
				moduleIndex: mi,
				formIndex: fi,
			});

			if (form.questions) {
				flattenQuestions(form.questions, mi, fi, undefined, items);
			}
		}
	}

	// Step 2: Run fuse.js
	const fuse = new Fuse(items, {
		keys: ["text"],
		includeMatches: true,
		threshold: 0.15,
		distance: 100,
	});

	const results = fuse.search(trimmed);
	if (results.length === 0) {
		return {
			data: { ...data, modules: [] },
			forceExpand: new Set(),
			matchMap: new Map(),
		};
	}

	// Step 3: Collect matched node keys and their highlight indices
	const matchedKeys = new Set<string>();
	const matchMap = new Map<string, MatchIndices>();

	for (const result of results) {
		const item = result.item;
		matchedKeys.add(item.nodeKey);

		// Extract match indices from fuse result
		if (result.matches && result.matches.length > 0) {
			const indices = result.matches[0].indices as Array<[number, number]>;
			// Only keep the best existing entry or overwrite
			if (!matchMap.has(item.nodeKey)) {
				matchMap.set(item.nodeKey, indices);
			}
		}
	}

	// Step 4: Build pruned tree and forceExpand set
	const forceExpand = new Set<string>();

	const prunedModules = data.modules
		.map((mod, mi) => {
			const moduleKey = `m${mi}`;
			const moduleMatched = matchedKeys.has(moduleKey);

			const prunedForms = mod.forms
				.map((form, fi) => {
					const formKey = `f${mi}_${fi}`;
					const formMatched = matchedKeys.has(formKey);

					// Filter questions
					const prunedQuestions = form.questions
						? filterQuestions(form.questions, mi, fi, undefined, matchedKeys)
						: undefined;

					const hasMatchingQuestions =
						prunedQuestions && prunedQuestions.length > 0;

					if (formMatched || hasMatchingQuestions) {
						if (hasMatchingQuestions) {
							// Force expand the form so matching questions are visible
							forceExpand.add(formKey);
						}
						return {
							...form,
							questions: formMatched ? form.questions : prunedQuestions,
						};
					}
					return null;
				})
				.filter((f): f is NonNullable<typeof f> => f !== null);

			if (moduleMatched || prunedForms.length > 0) {
				if (prunedForms.length > 0) {
					// Force expand the module so matching forms are visible
					forceExpand.add(moduleKey);
				}
				return {
					...mod,
					forms: moduleMatched ? mod.forms : prunedForms,
				};
			}
			return null;
		})
		.filter((m): m is NonNullable<typeof m> => m !== null);

	return {
		data: { ...data, modules: prunedModules },
		forceExpand,
		matchMap,
	};
}

/** Recursively flatten questions into searchable items */
function flattenQuestions(
	questions: Question[],
	mi: number,
	fi: number,
	parentPath: QuestionPath | undefined,
	items: SearchItem[],
) {
	for (const q of questions) {
		const path = qpath(q.id, parentPath);
		if (q.label) {
			items.push({
				text: q.label,
				field: "label",
				nodeKey: path,
				kind: "question",
				moduleIndex: mi,
				formIndex: fi,
				questionPath: path,
			});
		}
		items.push({
			text: q.id,
			field: "id",
			nodeKey: q.label ? `${path}__id` : path,
			kind: "question",
			moduleIndex: mi,
			formIndex: fi,
			questionPath: path,
		});
		if (q.children) {
			flattenQuestions(q.children, mi, fi, path, items);
		}
	}
}

/** Recursively filter questions, keeping only branches with matches */
function filterQuestions(
	questions: Question[],
	mi: number,
	fi: number,
	parentPath: QuestionPath | undefined,
	matchedKeys: Set<string>,
): Question[] {
	const result: Question[] = [];

	for (const q of questions) {
		const path = qpath(q.id, parentPath);
		const directMatch = matchedKeys.has(path) || matchedKeys.has(`${path}__id`);

		// Recursively check children
		const filteredChildren = q.children
			? filterQuestions(q.children, mi, fi, path, matchedKeys)
			: undefined;

		const hasMatchingChildren = filteredChildren && filteredChildren.length > 0;

		if (directMatch || hasMatchingChildren) {
			result.push({
				...q,
				children: directMatch ? q.children : filteredChildren,
			});
		}
	}

	return result;
}

/** Split text into highlighted and non-highlighted segments using match indices */
export function highlightSegments(
	text: string,
	indices: MatchIndices,
): Array<{ text: string; highlight: boolean }> {
	if (!indices.length) return [{ text, highlight: false }];

	// Merge overlapping/adjacent ranges
	const merged: Array<[number, number]> = [];
	const sorted = [...indices].sort((a, b) => a[0] - b[0]);
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1] + 1) {
			last[1] = Math.max(last[1], end);
		} else {
			merged.push([start, end]);
		}
	}

	const segments: Array<{ text: string; highlight: boolean }> = [];
	let cursor = 0;

	for (const [start, end] of merged) {
		if (cursor < start) {
			segments.push({ text: text.slice(cursor, start), highlight: false });
		}
		segments.push({ text: text.slice(start, end + 1), highlight: true });
		cursor = end + 1;
	}

	if (cursor < text.length) {
		segments.push({ text: text.slice(cursor), highlight: false });
	}

	return segments;
}
