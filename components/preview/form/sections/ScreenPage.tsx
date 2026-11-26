/**
 * ScreenPage: one screen of a form without sections, as Preview running as
 * Android pages it (`lib/preview/platform.ts`, `formScreens`).
 *
 * Android pages such a form one screen per group shown on one screen
 * (`fieldList`) and per question outside one. Over each screen it draws one
 * header line, the labels of the screen's enclosing groups joined with
 * ` > `, a repeat entry's label followed by its 1-based position, unlabeled
 * containers skipped (`views/QuestionsView.java::deriveGroupText`); a
 * labeled field-list group's screen includes its own label. A screen with no labeled
 * group around it has no header line.
 *
 * The body is the ordinary running renderer over the whole form, scoped to
 * this screen (`FormScreenScope`): repeat entries, capture slots and engine
 * paths keep the identities they have everywhere else, and only this
 * screen's rows draw. The header takes focus once after a user-driven turn
 * (`takeFocusOnMount`), never on the form's first open.
 */
"use client";
import { motion, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useId, useRef } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { Uuid } from "@/lib/domain";
import { formRootName } from "@/lib/domain/formAnswerRoot";
import { referenceNames } from "@/lib/domain/referenceNames";
import type { FormScreenPage } from "@/lib/preview/engine/formEngine";
import { rebaseOntoContext } from "@/lib/preview/engine/instancePaths";
import { useEngineStateAt } from "@/lib/preview/hooks/useEngineState";
import { usePresentationSelector } from "@/lib/preview/hooks/usePresentationDocument";
import { usePresentationField } from "@/lib/preview/hooks/useVisibleFieldOrder";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import { FormScreenScopeContext } from "../FormScreenScope";
import { InteractiveFormRenderer } from "../InteractiveFormRenderer";
import { depthPadding } from "../virtual/rowStyles";
import { QuestionBanners } from "./QuestionBanners";

/** One labeled container around a screen, outermost first. */
interface HeaderPart {
	readonly uuid: Uuid;
	readonly path: string;
	/** A repeat entry's 1-based position. */
	readonly position?: number;
}

/** Split `/data/visits[1]/details` into `visits` at entry 1, then `details`. */
function pathSteps(
	path: string,
): ReadonlyArray<{ readonly id: string; readonly index?: number }> {
	return path
		.split("/")
		.slice(2)
		.map((step) => {
			const open = step.indexOf("[");
			return open === -1
				? { id: step }
				: { id: step.slice(0, open), index: Number(step.slice(open + 1, -1)) };
		});
}

/** The document the running form presents (`usePresentationSelector`). */
type PresentationDoc = Parameters<
	Parameters<typeof usePresentationSelector>[0]
>[0];

function headerParts(
	doc: PresentationDoc,
	formUuid: Uuid,
	screen: FormScreenPage,
): readonly HeaderPart[] {
	const parts: HeaderPart[] = [];
	const names = referenceNames(doc);
	const parents: Uuid[] = [];
	const seen = new Set<Uuid>();
	for (
		let at: Uuid | undefined = screen.uuid;
		at !== undefined && at !== formUuid && !seen.has(at);
		at = doc.fieldParent[at]
	) {
		seen.add(at);
		parents.unshift(at);
	}
	for (const uuid of parents) {
		const field = doc.fields[uuid];
		if ((field?.kind !== "group" && field?.kind !== "repeat") || !field.label)
			continue;
		const steps = names.fieldPathSegments(uuid);
		if (steps === undefined) continue;
		const path = rebaseOntoContext(
			`/${formRootName(doc.forms[formUuid])}/${steps.join("/")}`,
			screen.path,
		);
		const row =
			field.kind === "repeat" ? pathSteps(path).at(-1)?.index : undefined;
		parts.push({
			uuid,
			path: row === undefined ? path : path.slice(0, path.lastIndexOf("[")),
			...(field.kind === "repeat" && { position: (row ?? 0) + 1 }),
		});
	}

	return parts;
}

function HeaderPartText({ part }: { readonly part: HeaderPart }) {
	const field = usePresentationField(part.uuid);
	const state = useEngineStateAt(part.uuid, part.path);
	const projectProse = useProseProjection();
	const label =
		field !== undefined && "label" in field && field.label
			? (state.resolvedLabel ?? projectProse(field.label))
			: "";
	return (
		<>
			{label}
			{part.position !== undefined ? ` (${part.position})` : null}
		</>
	);
}

export function ScreenPage({
	formUuid,
	page,
	index,
	takeFocusOnMount,
}: {
	readonly formUuid: Uuid;
	readonly page: FormScreenPage;
	/** 0-based position among the screens a worker can see. */
	readonly index: number;
	/** Read-and-clear: whether this mount follows a user-driven turn. */
	readonly takeFocusOnMount: () => boolean;
}) {
	const { language } = useBuilderLanguage();
	const partsKey = usePresentationSelector((doc) =>
		JSON.stringify(headerParts(doc, formUuid, page)),
	);
	const parts = JSON.parse(partsKey) as readonly HeaderPart[];
	const headingId = useId();
	const headingRef = useRef<HTMLHeadingElement | null>(null);
	const reducedMotion = useReducedMotion();

	useEffect(() => {
		if (takeFocusOnMount()) headingRef.current?.focus();
	}, [takeFocusOnMount]);

	return (
		<motion.section
			aria-labelledby={headingId}
			initial={reducedMotion ? false : { opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
		>
			<div
				className="pt-6"
				style={{
					paddingLeft: depthPadding(0),
					paddingRight: depthPadding(0),
				}}
			>
				<h2
					id={headingId}
					ref={headingRef}
					tabIndex={-1}
					data-screen-header=""
					className={
						parts.length > 0
							? "nova-focusable px-3 text-sm font-semibold text-nova-text outline-none"
							: "sr-only"
					}
				>
					{parts.length > 0
						? parts.map((part, position) => (
								<Fragment key={part.path}>
									{position > 0 ? " > " : null}
									<HeaderPartText part={part} />
								</Fragment>
							))
						: runtimeMessage(language, "questionPosition", {
								position: index + 1,
							})}
				</h2>
			</div>
			<QuestionBanners uuid={page.uuid} path={page.path} />
			<FormScreenScopeContext.Provider value={page.path}>
				<InteractiveFormRenderer parentEntityId={formUuid} />
			</FormScreenScopeContext.Provider>
		</motion.section>
	);
}
