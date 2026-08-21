/**
 * SectionPage: one page of a sectioned form in the running preview.
 *
 * The page is the section's heading (the same `SectionHeading` box the edit
 * canvas draws, so a flip lands it at the same Y) over the section's
 * children rendered by the ordinary interactive renderer, rooted at the
 * section: `prefix` is the section's data path and `parentPath` its field
 * path, exactly what a group hands its children, so every question below
 * reads and writes the same engine paths it would on a single-page form.
 *
 * The heading is a real `h2` the page is labelled by, and it takes focus
 * once after a user-driven page turn (`takeFocusOnMount` reads and clears
 * the pager's intent), never on the form's first open.
 */
"use client";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useId, useRef } from "react";
import { useLocalizedField } from "@/components/builder/localization/BuilderLocalizationProvider";
import { fpath } from "@/lib/doc/fieldPath";
import { proseTemplateIsEmpty } from "@/lib/domain/prose";
import type { SectionPage as SectionPageModel } from "@/lib/preview/engine/formEngine";
import { useEngineState } from "@/lib/preview/hooks/useEngineState";
import { LabelContent } from "@/lib/references/LabelContent";
import { InteractiveFormRenderer } from "../InteractiveFormRenderer";
import { depthPadding } from "../virtual/rowStyles";
import { SectionHeading, sectionKicker } from "./SectionHeading";

interface SectionPageProps {
	readonly page: SectionPageModel;
	/** 0-based position among the pages a worker can see. */
	readonly index: number;
	readonly count: number;
	/** Read-and-clear: whether this mount follows a user-driven page turn. */
	readonly takeFocusOnMount: () => boolean;
}

export function SectionPage({
	page,
	index,
	count,
	takeFocusOnMount,
}: SectionPageProps) {
	const field = useLocalizedField(page.uuid);
	const state = useEngineState(page.uuid);
	const headingId = useId();
	const headingRef = useRef<HTMLElement | null>(null);
	const setHeading = useCallback((element: HTMLElement | null) => {
		headingRef.current = element;
	}, []);
	const reducedMotion = useReducedMotion();

	useEffect(() => {
		if (takeFocusOnMount()) headingRef.current?.focus();
	}, [takeFocusOnMount]);

	if (field?.kind !== "section") return null;
	const hasTitle =
		field.label !== undefined && !proseTemplateIsEmpty(field.label);

	return (
		<motion.section
			aria-labelledby={headingId}
			initial={reducedMotion ? false : { opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
		>
			{/* The leading pad is the edit canvas's root insertion row; the
			 * horizontal geometry is the header row's. */}
			<div
				className="pt-6"
				style={{
					paddingLeft: depthPadding(0),
					paddingRight: depthPadding(0),
				}}
			>
				<div className="px-3">
					<SectionHeading
						as="h2"
						id={headingId}
						tabIndex={-1}
						titleRef={setHeading}
						titleInset
						index={index}
						count={count}
						title={
							hasTitle && field.label ? (
								<LabelContent
									label={field.label}
									resolvedLabel={state.resolvedLabel}
									isEditMode={false}
									className="text-lg font-semibold leading-7 text-nova-text"
								/>
							) : (
								/* An untitled page shows only its kicker, the way the
								 * device shows an untitled field-list; the heading still
								 * needs a name, so the kicker is the name. */
								<span className="sr-only">{sectionKicker(index, count)}</span>
							)
						}
					/>
				</div>
			</div>
			<InteractiveFormRenderer
				parentEntityId={page.uuid}
				prefix={page.path}
				parentPath={fpath(field.id)}
				depth={0}
				accessibleContext={headingId}
			/>
		</motion.section>
	);
}
