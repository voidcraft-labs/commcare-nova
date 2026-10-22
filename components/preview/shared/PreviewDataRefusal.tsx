"use client";

/**
 * The running app's refusal of data a device holds none of: no places for
 * the worker, a table with no rows (`lib/preview/engine/dataRefusal.ts`).
 * A phone stops there, so Preview shows what it does and what to change, in
 * place of the screen, and reports nothing: the app is right, the data is
 * empty.
 *
 * A form's refusal arrives on the engine's entry state. A menu's display
 * condition and a Search prompt's choices are read while their screen
 * renders, so {@link PreviewDataRefusalBoundary} catches the refusal there
 * and passes every other error to the boundary above it.
 */

import React from "react";
import {
	useBuilderLanguage,
	useLocalizedField,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { FORM_PRIMARY_ACTION_CLS } from "@/components/preview/screens/formActionButtonStyles";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import { usePersonas } from "@/lib/doc/hooks/useUserCollections";
import type { Uuid } from "@/lib/domain";
import {
	type PreviewDataRefusalReason,
	previewDataRefusalOf,
	previewDataRefusalSubject,
	searchInputForTable,
} from "@/lib/preview/engine/dataRefusal";
import { usePreviewLookupStatus } from "@/lib/preview/engine/useLookupPreviewData";
import {
	type DataRefusalCopyNames,
	type DataRefusalSurface,
	dataRefusalCopy,
} from "@/lib/preview/runtimeMessages";
import { usePreviewPersonaUuid } from "@/lib/session/hooks";

interface PanelProps {
	readonly surface: DataRefusalSurface;
	readonly reason: PreviewDataRefusalReason;
	/** The module whose Search screen refused, which names its prompt. */
	readonly moduleUuid?: Uuid;
	readonly action?: { readonly label: string; readonly onClick: () => void };
}

export function PreviewDataRefusalPanel(props: PanelProps) {
	const fieldUuid =
		props.reason.kind === "empty-choice-table"
			? props.reason.fieldUuid
			: undefined;
	return fieldUuid === undefined ? (
		<RefusalPanel {...props} />
	) : (
		<QuestionRefusalPanel {...props} fieldUuid={fieldUuid} />
	);
}

function QuestionRefusalPanel(
	props: PanelProps & { readonly fieldUuid: Uuid },
) {
	const projectProse = useProseProjection();
	const question = useLocalizedField(props.fieldUuid);
	const label =
		question !== undefined && "label" in question && question.label
			? projectProse(question.label)
			: undefined;
	return <RefusalPanel {...props} question={label || undefined} />;
}

function RefusalPanel({
	surface,
	reason,
	moduleUuid,
	action,
	question,
}: PanelProps & { readonly question?: string }) {
	const { language } = useBuilderLanguage();
	const lookup = usePreviewLookupStatus();
	const personaUuid = usePreviewPersonaUuid();
	const worker = usePersonas().find(
		(persona) => persona.uuid === personaUuid,
	)?.name;
	const module = useModule(moduleUuid);
	const named =
		reason.kind === "empty-choice-table"
			? searchInputForTable(
					module?.caseListConfig?.searchInputs ?? [],
					reason.tableId,
				)
			: undefined;
	const input = named === undefined ? undefined : named.label || named.name;
	const subject = previewDataRefusalSubject(
		reason,
		lookup.kind === "data" ? lookup.data : undefined,
	);
	const names: DataRefusalCopyNames = {
		...(worker === undefined ? {} : { worker }),
		...(question === undefined ? {} : { question }),
		...(input === undefined ? {} : { input }),
	};
	const copy = dataRefusalCopy(language, surface, subject, names);
	return (
		<div className="flex h-full items-center justify-center px-6 py-10">
			<div
				role="alert"
				data-preview-data-refusal={subject.kind}
				data-preview-data-refusal-surface={surface}
				className="flex max-w-md flex-col items-start gap-4 rounded-2xl border border-pv-input-border bg-pv-surface p-6 shadow-sm"
			>
				<div className="space-y-2">
					<h2 className="text-lg font-semibold text-nova-text">{copy.title}</h2>
					<p className="text-sm leading-relaxed text-nova-text-secondary">
						{copy.body}
					</p>
				</div>
				{action !== undefined && (
					<button
						type="button"
						onClick={action.onClick}
						className={FORM_PRIMARY_ACTION_CLS}
					>
						{action.label}
					</button>
				)}
			</div>
		</div>
	);
}

interface BoundaryProps {
	/** `menu` for a menu screen; a case list's refused choice list is its
	 * Search screen's, whatever this says. */
	readonly surface: "menu";
	readonly moduleUuid?: Uuid;
	/** Changing it tries the screen again: the screen itself and the lookup
	 * data each can make the data there. */
	readonly resetKeys: readonly unknown[];
	/** The document, which the boundary watches only while it shows a
	 * refusal: any edit can be the one that fixes it, so each tries the
	 * screen again. */
	readonly doc: RefusalDoc;
	readonly children: React.ReactNode;
}

/** A document store: each commit replaces its state. */
interface RefusalDoc {
	readonly subscribe: (listener: () => void) => () => void;
	readonly getState: () => unknown;
}

interface BoundaryState {
	readonly error: unknown;
	readonly caughtWith: readonly unknown[] | undefined;
	/** The document's state when the refusal was caught. */
	readonly caughtAt: unknown;
}

/** What the boundary does with its document watch after it renders. */
export interface RefusalWatchStep {
	/** Drop the watch it holds. */
	readonly unwatch: boolean;
	/** `watch` the document, `retry` the screen now, or neither. */
	readonly next: "watch" | "retry" | "none";
}

/**
 * The boundary watches the document exactly while a refusal shows, and the
 * document it is given, so no commit after the refusal goes unseen: one that
 * landed before the watch began, or a different document, tries the screen
 * again at once.
 */
export function refusalWatchStep(args: {
	readonly refused: boolean;
	/** The document the boundary watches, if any. */
	readonly watched: RefusalDoc | undefined;
	readonly doc: RefusalDoc;
	readonly caughtAt: unknown;
}): RefusalWatchStep {
	const { refused, watched, doc } = args;
	if (!refused) return { unwatch: watched !== undefined, next: "none" };
	if (watched === doc) return { unwatch: false, next: "none" };
	return {
		unwatch: watched !== undefined,
		next: doc.getState() === args.caughtAt ? "watch" : "retry",
	};
}

/** The state that renders the screen again. */
const RETRY: BoundaryState = {
	error: undefined,
	caughtWith: undefined,
	caughtAt: undefined,
};

/**
 * Catch Core's data refusal while a menu or Search screen renders; let every
 * other error reach the boundary above, which reports it as the fault it is.
 */
export class PreviewDataRefusalBoundary extends React.Component<
	BoundaryProps,
	BoundaryState
> {
	state: BoundaryState = {
		error: undefined,
		caughtWith: undefined,
		caughtAt: undefined,
	};
	#watch: { readonly doc: RefusalDoc; readonly stop: () => void } | undefined;

	static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
		return { error };
	}

	static getDerivedStateFromProps(
		props: BoundaryProps,
		state: BoundaryState,
	): Partial<BoundaryState> | null {
		if (state.error === undefined) return null;
		if (state.caughtWith === undefined)
			return { caughtWith: props.resetKeys, caughtAt: props.doc.getState() };
		const changed =
			state.caughtWith.length !== props.resetKeys.length ||
			state.caughtWith.some((key, index) => key !== props.resetKeys[index]);
		return changed ? RETRY : null;
	}

	componentDidMount(): void {
		this.#watchWhileRefused();
	}

	componentDidUpdate(): void {
		this.#watchWhileRefused();
	}

	componentWillUnmount(): void {
		this.#watch?.stop();
		this.#watch = undefined;
	}

	/** Watch the document exactly while a refusal shows (`refusalWatchStep`). */
	#watchWhileRefused(): void {
		const { doc } = this.props;
		const step = refusalWatchStep({
			refused:
				this.state.error !== undefined &&
				previewDataRefusalOf(this.state.error) !== undefined,
			watched: this.#watch?.doc,
			doc,
			caughtAt: this.state.caughtAt,
		});
		if (step.unwatch) {
			this.#watch?.stop();
			this.#watch = undefined;
		}
		if (step.next === "retry") this.setState(RETRY);
		else if (step.next === "watch")
			this.#watch = {
				doc,
				stop: doc.subscribe(() => this.setState(RETRY)),
			};
	}

	render() {
		const { error } = this.state;
		if (error === undefined) return this.props.children;
		const refusal = previewDataRefusalOf(error);
		/* Not the data's doing: rethrow so the outer boundary reports it. */
		if (refusal === undefined) throw error;
		const surface =
			refusal.reason.kind === "empty-choice-table"
				? "search"
				: this.props.surface;
		return (
			<PreviewDataRefusalPanel
				surface={surface}
				reason={refusal.reason}
				{...(this.props.moduleUuid === undefined
					? {}
					: { moduleUuid: this.props.moduleUuid })}
			/>
		);
	}
}

/**
 * A menu or Search screen under the refusal boundary. It tries the screen
 * again when the document, the lookup data or the screen itself changes,
 * since each can give the device the data it lacked.
 */
export function PreviewDataRefusalScope({
	screenKey,
	moduleUuid,
	children,
}: {
	readonly screenKey: string;
	readonly moduleUuid?: Uuid;
	readonly children: React.ReactNode;
}) {
	const doc = useBlueprintDocApi();
	const lookup = usePreviewLookupStatus();
	return (
		<PreviewDataRefusalBoundary
			surface="menu"
			{...(moduleUuid === undefined ? {} : { moduleUuid })}
			resetKeys={[screenKey, lookup]}
			doc={doc}
		>
			{children}
		</PreviewDataRefusalBoundary>
	);
}
