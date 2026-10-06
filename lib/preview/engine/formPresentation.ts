import type {
	Field,
	FieldKind,
	LanguageTag,
	Media,
	ProseTemplate,
	Uuid,
} from "@/lib/domain";
import { runtimeMessage } from "../runtimeMessages";
import type { FieldTreeNode } from "./fieldTree";
import type { FieldState } from "./types";

/** Runtime state is path keyed in the engine and UUID/path keyed in React.
 * Keep that storage distinction outside the worker's presentation rules. */
export interface FormPresentationSource {
	stateAt(field: Field, path: string): FieldState;
}

export interface PresentedField {
	readonly field: Field;
	readonly state: FieldState;
	readonly path: string;
	readonly parentPath: string;
	readonly depth: number;
	readonly sectionUuid?: Uuid;
	readonly onCurrentPage: boolean;
	readonly visible: boolean;
	readonly position?: number;
	readonly label?: string;
	readonly hint?: string;
	readonly help?: string;
}

export type FormPresentationNode =
	| {
			readonly kind: FieldKind;
			readonly path: string;
			readonly uuid: Uuid;
			readonly onCurrentPage: boolean;
			readonly position: number;
			readonly fallbackLabel?: string;
			readonly label?: string;
			readonly hint?: string;
			readonly help?: string;
			readonly media?: { label?: Media; hint?: Media; help?: Media };
			readonly repeatMode?: "user_controlled" | "count_bound" | "query_bound";
			readonly repeatCount?: number;
			readonly controls?: { add: boolean };
			readonly children?: readonly FormPresentationNode[];
	  }
	| {
			readonly kind: "repeat-instance";
			readonly path: string;
			readonly index: number;
			readonly label: string;
			readonly onCurrentPage: boolean;
			readonly controls: { remove: boolean };
			readonly children: readonly FormPresentationNode[];
	  };

function hasOwnPresentation(field: Field, state: FieldState): boolean {
	return (
		(state.resolvedLabel !== undefined
			? state.resolvedLabel.trim().length > 0
			: "label" in field &&
				field.label?.parts.some(
					(part) => part.kind !== "text" || part.text.trim().length > 0,
				) === true) ||
		("label_media" in field &&
			Object.values(field.label_media ?? {}).some(Boolean))
	);
}

/** An automatic iteration with only invisible calculations has no worker UI.
 * User-controlled repeats retain their Add/Remove controls even without inputs;
 * authored headings and media remain content in their own right. */
export function fieldHasWorkerPresentation(
	node: FieldTreeNode,
	path: string,
	source: FormPresentationSource,
): boolean {
	const { field, children = [] } = node;
	const state = source.stateAt(field, path);
	if (field.kind === "hidden" || !state.visible) return false;
	if (field.kind === "repeat") {
		return (
			field.repeat_mode === "user_controlled" ||
			hasOwnPresentation(field, state) ||
			visibleRepeatInstances(node, path, source).length > 0
		);
	}
	if (field.kind === "group" || field.kind === "section")
		return (
			hasOwnPresentation(field, state) ||
			children.some((child) =>
				fieldHasWorkerPresentation(child, `${path}/${child.field.id}`, source),
			)
		);
	return true;
}

/** Concrete instance indices, never template children or store insertion order. */
export function visibleRepeatInstances(
	node: FieldTreeNode,
	path: string,
	source: FormPresentationSource,
): number[] {
	const { field, children = [] } = node;
	if (field.kind !== "repeat") return [];
	const count = source.stateAt(field, path).repeatCount ?? 0;
	return Array.from({ length: count }, (_, index) => index).filter(
		(index) =>
			field.repeat_mode === "user_controlled" ||
			children.some((child) =>
				fieldHasWorkerPresentation(
					child,
					`${path}[${index}]/${child.field.id}`,
					source,
				),
			),
	);
}

/** The authored tree is also the equality boundary for React subscriptions. */
export function fieldTreesEqual(
	left: readonly FieldTreeNode[],
	right: readonly FieldTreeNode[],
	fieldsEqual: (left: Field, right: Field) => boolean = Object.is,
): boolean {
	return (
		left.length === right.length &&
		left.every(
			(node, index) =>
				right[index] !== undefined &&
				fieldsEqual(node.field, right[index].field) &&
				fieldTreesEqual(
					node.children ?? [],
					right[index].children ?? [],
					fieldsEqual,
				),
		)
	);
}

/** A serializable ordered worker hierarchy and a complete ordered runtime view.
 * Hidden fields remain in `fields` so their calculation/submission participation
 * is observable. They never become worker-facing nodes. */
export function projectFormPresentation(
	tree: readonly FieldTreeNode[],
	source: FormPresentationSource,
	options: {
		language?: LanguageTag;
		currentSectionUuid?: Uuid;
		availableSectionUuids?: ReadonlySet<Uuid>;
		text(prose: ProseTemplate): string;
	},
): {
	fields: PresentedField[];
	currentSectionUuid?: Uuid;
	nodes: FormPresentationNode[];
} {
	const fields: PresentedField[] = [];
	const text = (
		field: Field,
		state: FieldState,
		slot: "label" | "hint" | "help",
	) => {
		const resolved =
			slot === "label"
				? state.resolvedLabel
				: slot === "hint"
					? state.resolvedHint
					: state.resolvedHelp;
		if (resolved !== undefined) return resolved;
		const prose = slot in field ? field[slot as keyof Field] : undefined;
		return typeof prose === "object" && prose !== null && "parts" in prose
			? options.text(prose)
			: undefined;
	};
	function walk(
		nodes: readonly FieldTreeNode[],
		parentPath: string,
		depth: number,
		ancestorVisible: boolean,
		sectionUuid?: Uuid,
	): FormPresentationNode[] {
		const presentation: FormPresentationNode[] = [];
		for (const node of nodes) {
			const { field, children = [] } = node;
			const path = `${parentPath}/${field.id}`;
			const state = source.stateAt(field, path);
			const section = field.kind === "section" ? field.uuid : sectionUuid;
			const onCurrentPage = section === options.currentSectionUuid;
			const visible =
				ancestorVisible &&
				(field.kind !== "section" ||
					options.availableSectionUuids === undefined ||
					options.availableSectionUuids.has(field.uuid)) &&
				fieldHasWorkerPresentation(node, path, source);
			const position = presentation.length + 1;
			const label = text(field, state, "label");
			const hint = text(field, state, "hint");
			const help = text(field, state, "help");
			fields.push({
				field,
				state,
				path,
				parentPath,
				depth,
				...(section === undefined ? {} : { sectionUuid: section }),
				onCurrentPage,
				visible,
				...(visible ? { position } : {}),
				label,
				hint,
				help,
			});
			let projectedChildren: FormPresentationNode[] | undefined;
			if (field.kind === "repeat") {
				projectedChildren = [];
				const visibleInstances = new Set(
					visibleRepeatInstances(node, path, source),
				);
				const count = state.repeatCount ?? 0;
				for (let index = 0; index < count; index++) {
					const instancePath = `${path}[${index}]`;
					const instanceVisible = visible && visibleInstances.has(index);
					const instanceChildren = walk(
						children,
						instancePath,
						depth + 1,
						instanceVisible,
						section,
					);
					if (instanceVisible)
						projectedChildren.push({
							kind: "repeat-instance",
							path: instancePath.replace(/^\/data\//, ""),
							index,
							label: runtimeMessage(options.language, "instancePosition", {
								position: index + 1,
							}),
							onCurrentPage,
							controls: {
								remove: field.repeat_mode === "user_controlled" && count > 1,
							},
							children: instanceChildren,
						});
				}
			} else if (node.children !== undefined) {
				projectedChildren = walk(children, path, depth + 1, visible, section);
			}
			if (!visible) continue;
			const media = {
				...("label_media" in field && field.label_media
					? { label: field.label_media }
					: {}),
				...("hint_media" in field && field.hint_media
					? { hint: field.hint_media }
					: {}),
				...("help_media" in field && field.help_media
					? { help: field.help_media }
					: {}),
			};
			presentation.push({
				kind: field.kind,
				path: path.replace(/^\/data\//, ""),
				uuid: field.uuid,
				onCurrentPage,
				position,
				label,
				...(field.kind !== "group" &&
				field.kind !== "section" &&
				field.kind !== "repeat" &&
				field.kind !== "label" &&
				!label?.trim()
					? {
							fallbackLabel: runtimeMessage(
								options.language,
								"questionPosition",
								{ position },
							),
						}
					: {}),
				hint,
				help,
				...(Object.keys(media).length ? { media } : {}),
				...(field.kind === "repeat"
					? {
							repeatMode: field.repeat_mode,
							repeatCount: state.repeatCount ?? 0,
							controls: { add: field.repeat_mode === "user_controlled" },
						}
					: {}),
				...(projectedChildren === undefined
					? {}
					: { children: projectedChildren }),
			});
		}
		return presentation;
	}
	return {
		fields,
		...(options.currentSectionUuid === undefined
			? {}
			: { currentSectionUuid: options.currentSectionUuid }),
		nodes: walk(tree, "/data", 0, true),
	};
}
