// components/builder/navigation/EndOfFormNavigationSection.tsx
//
// The form-settings row for end-of-form navigation: what happens today,
// plus one way in. The list is ordered, its conditions are recursive
// trees, and the sequence decides which branch a worker takes — none of
// which fits a popover — so the panel names the setting and hands off to
// the centre canvas, the same split the display conditions already use.

"use client";

import { Button } from "@/components/shadcn/button";
import type { Uuid } from "@/lib/doc/types";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { useEndOfFormNavigation } from "./useEndOfFormNavigation";

/** What the form does after a submission today, in one sentence. */
function summary(destinationCount: number, otherwise: string): string {
	if (destinationCount === 0) return `Goes to ${otherwise}.`;
	const conditions =
		destinationCount === 1 ? "1 condition" : `${destinationCount} conditions`;
	return `Checks ${conditions}, otherwise goes to ${otherwise}.`;
}

export function EndOfFormNavigationSection({
	moduleUuid,
	formUuid,
	onNavigateAway,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	/** Dismiss the settings popover that hosts this row. Opening the
	 *  screen is a screen change, and the popover's open-state survives it
	 *  (its owner is hidden, not unmounted), so it would otherwise still
	 *  be sitting open on return. */
	readonly onNavigateAway?: () => void;
}) {
	const resolved = useEndOfFormNavigation(moduleUuid, formUuid);
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	if (resolved === null) return null;

	const { model } = resolved;
	const otherwise =
		model.otherwise.kind === "link"
			? `"${model.otherwise.label}"`
			: OTHERWISE_WORDS[model.otherwise.destination];

	return (
		<section className="space-y-3">
			<div>
				<h3 className="text-[13px] font-medium leading-5 text-nova-text-secondary">
					After submitting
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
					Where people go once they submit this form.
				</p>
			</div>
			<div className="rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3">
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					{summary(model.rows.length, otherwise)}
				</p>
				<Button
					type="button"
					variant="outline"
					size="xl"
					onClick={() => {
						onNavigateAway?.();
						navigate.openFormNavigation(moduleUuid, formUuid);
					}}
					className="mt-3 w-full border-white/[0.08] bg-transparent text-[14px] text-nova-text-secondary not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.05] not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.05]"
				>
					{canEdit ? "Edit destinations" : "View destinations"}
				</Button>
			</div>
		</section>
	);
}

/** The three post-submit destinations, as the summary sentence says them. */
const OTHERWISE_WORDS = {
	previous: "the previous screen",
	module: "this menu",
	app_home: "the app home screen",
	/* HQ's legacy spellings of the two above; an imported app can carry
	 * one, and the summary should name the screen it actually reaches. */
	root: "the app home screen",
	parent_module: "this menu",
} as const;
