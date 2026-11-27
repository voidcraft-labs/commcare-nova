import type {
	Field,
	FieldKind,
	LanguageTag,
	Media,
	ProseTemplate,
	Uuid,
} from "@/lib/domain";
import { fieldProseTemplate } from "@/lib/domain/expressionSource";
import { fieldHasWorkerControl } from "@/lib/domain/fieldForm";
import type { Form } from "@/lib/domain/forms";
import { PLATFORMS, type Platform } from "@/lib/domain/platforms";
import { effectivePreviewPlatform } from "../platform";
import { runtimeMessage } from "../runtimeMessages";
import { workerFieldProseSlot } from "../workerProse";
import { controlValuePath, type FieldTreeNode } from "./fieldTree";
import { repeatAddCaption } from "./repeatAddCaption";
import { type FieldState, repeatRowRelevantInState } from "./types";

/** Runtime state is path keyed in the engine and UUID/path keyed in React.
 * Keep that storage distinction outside the worker's presentation rules. */
export interface FormPresentationSource {
	readonly workerRelevant: ReadonlySet<string> | undefined;
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
			readonly media?: { label?: Media; help?: Media };
			readonly repeatMode?: "user_controlled" | "count_bound" | "query_bound";
			readonly repeatCount?: number;
			readonly controls?: { add: boolean; addLabel?: string };
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
	if (
		!fieldHasWorkerControl(field.kind) ||
		!state.visible ||
		source.workerRelevant?.has(path) === false
	)
		return false;
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
				fieldHasWorkerPresentation(
					child,
					controlValuePath(child, path),
					source,
				),
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
	if (field.kind !== "repeat" || source.workerRelevant?.has(path) === false)
		return [];
	const state = source.stateAt(field, path);
	const count = state.repeatCount ?? 0;
	return Array.from({ length: count }, (_, index) => index).filter(
		(index) =>
			repeatRowRelevantInState(state, index) &&
			(field.repeat_mode === "user_controlled" ||
				children.some((child) =>
					fieldHasWorkerPresentation(
						child,
						controlValuePath(child, `${path}[${index}]`),
						source,
					),
				)),
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
				node.submittedPath === right[index].submittedPath &&
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
		rootPath?: string;
		language?: LanguageTag;
		platform?: Platform;
		textForm?: Pick<Form, "plainText">;
		currentSectionUuid?: Uuid;
		/** The current screen's path (`FormScreenPage.path`) where the form is
		 *  not paged by section: `/data` for Web Apps' one screen, a group's or
		 *  a question's path on Android. A field is on the current page when
		 *  it is the screen, inside it, or a container holding it. */
		currentScreenPath?: string;
		containsControl?: (outer: string, inner: string) => boolean;
		availableSectionUuids?: ReadonlySet<Uuid>;
		text(prose: ProseTemplate): string;
	},
): {
	fields: PresentedField[];
	currentSectionUuid?: Uuid;
	nodes: FormPresentationNode[];
} {
	const rootPath = options.rootPath ?? "/data";
	const platform = effectivePreviewPlatform(PLATFORMS, options.platform);
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
		const prose = fieldProseTemplate(
			field,
			slot === "label"
				? slot
				: workerFieldProseSlot(field, slot, options.textForm ?? {}, platform),
		);
		return prose === undefined ? undefined : options.text(prose);
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
			const path = controlValuePath(node, parentPath);
			const state = source.stateAt(field, path);
			const section = field.kind === "section" ? field.uuid : sectionUuid;
			const screenPath = options.currentScreenPath;
			const onCurrentPage =
				screenPath === undefined
					? section === options.currentSectionUuid
					: options.containsControl !== undefined
						? options.containsControl(screenPath, path) ||
							options.containsControl(path, screenPath)
						: screenPath === rootPath ||
							path === screenPath ||
							path.startsWith(`${screenPath}/`) ||
							path.startsWith(`${screenPath}[`) ||
							screenPath.startsWith(`${path}/`) ||
							screenPath.startsWith(`${path}[`);
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
							path: instancePath.slice(rootPath.length + 1),
							index,
							label: runtimeMessage(options.language, "instancePosition", {
								position: index + 1,
							}),
							onCurrentPage,
							controls: {
								remove: field.repeat_mode === "user_controlled",
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
				...("help_media" in field && field.help_media
					? { help: field.help_media }
					: {}),
			};
			presentation.push({
				kind: field.kind,
				path: path.slice(rootPath.length + 1),
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
							controls:
								field.repeat_mode === "user_controlled"
									? {
											add: true,
											addLabel: repeatAddCaption(
												field,
												state,
												state.repeatCount ?? 0,
												options.text,
											),
										}
									: { add: false },
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
		nodes: walk(tree, rootPath, 0, true),
	};
}
