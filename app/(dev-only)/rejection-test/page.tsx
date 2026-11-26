"use client";
import { useState } from "react";
import { InlineField } from "@/components/builder/detail/formSettings/InlineField";
import { EditableText } from "@/components/builder/EditableText";
import { EditableTitle } from "@/components/builder/EditableTitle";
import {
	REJECTION_SURFACE_CLS,
	RejectionBody,
	RejectionCallout,
	RejectionInline,
} from "@/components/builder/RejectionNotice";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { fieldIdFormatVerdict } from "@/lib/doc/identifierVerdicts";
import type { CommitOutcome } from "@/lib/domain";
import { showToast } from "@/lib/ui/toastStore";

// Standalone dev gallery: no builder dependency. Each section mounts a real
// rejection surface, wired to a gate stub that always refuses, so the bounce
// can be eyeballed in isolation: type into a control, press Enter, watch it.
//
// Each sample is REAL current builder copy (lib/doc/userFacingErrors.ts, the
// field-ID verdict's userMessage, and lib/commcare/connectSlugs.ts for the
// Connect ID), paired with the surface that actually shows it in the app:
//   - EditableTitle edits the app / module / form NAME (home, module, form
//     screens): clearing the app name is the refusable title edit.
//   - EditableText is the inline text / formula editor (XPathEditor), a bad
//     formula reference is its rejection.
//   - InlineField is a form-settings field (Connect config, close condition).
//   - FieldIdentitySection / XPathField share the anchored popup, a refused field-ID
//     rename surfaces there, NOT on EditableTitle.

const APP_NAME_REQUIRED = "Your app needs a name. Add one to get started.";
const FORMULA_BAD_REF =
	'A formula on "visit_score" in "Follow-up" points to a field that isn\'t here. Check for a typo, or a field that was renamed or removed.';
const FIELD_ID_TAKEN =
	'Another field is already named "age". Give this one a different ID, or rename that one first.';
// A learning module's receiver ID must fit its saved column. This fixture uses
// the same format verdict as the Builder, including its suggested repair.
const connectIdTooLong = (id: string): string | null => {
	const verdict = fieldIdFormatVerdict(id, "learning-module");
	return verdict.ok ? null : verdict.userMessage;
};
const CONNECT_ID_DUP =
	'Another field is already named "learn_intro". Give this one a different ID, or rename the other field first.';
const CONNECT_MISSING_ROLE =
	"This activity uses the learning role. You can enable learning in the app settings.";

const alwaysReject =
	(message: string) =>
	(_: string): CommitOutcome => ({ ok: false, messages: [message] });

function Section({
	title,
	hint,
	children,
}: {
	title: string;
	hint: string;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-3">
			<div>
				<h2 className="text-sm font-medium text-nova-text">{title}</h2>
				<p className="text-xs text-nova-text-muted">{hint}</p>
			</div>
			{children}
		</section>
	);
}

export default function RejectionTestPage() {
	const [calloutMessage, setCalloutMessage] = useState<string | null>(null);
	const [inlineMessage, setInlineMessage] = useState<string | null>(null);

	return (
		<div className="min-h-screen bg-nova-deep text-nova-text p-10">
			<ToastContainer />
			<div className="max-w-2xl mx-auto space-y-10">
				<h1 className="text-lg font-display font-semibold">
					Rejection surfaces
				</h1>

				<Section
					title="App / module / form title — EditableTitle"
					hint="The title editor on the home, module, and form screens. Change it, press Enter — the stub refuses, so the input shakes, keeps your draft, and the callout explains. Clearing the app name is the real refusal."
				>
					<EditableTitle
						value="Clinic Intake"
						onSave={alwaysReject(APP_NAME_REQUIRED)}
						ariaLabel="Application name"
					/>
				</Section>

				<Section
					title="Formula / text field — EditableText"
					hint="The inline notice under a text or formula editor. Edit and press Enter; the notice expands beneath, the border flips rose."
				>
					<div className="max-w-sm">
						<EditableText
							label="Calculation"
							value="#form/total div #form/visits"
							onSave={alwaysReject(FORMULA_BAD_REF)}
						/>
					</div>
				</Section>

				<Section
					title="Form-settings field — InlineField"
					hint="Left: live reason while typing (no register line). Right: gate rejection on Enter ('Not saved')."
				>
					<div className="grid grid-cols-2 gap-4 max-w-lg">
						<InlineField
							label="Connect ID"
							value="learn_intro_module_for_client_onboarding_session_v2"
							onChange={() => ({ ok: true }) as CommitOutcome}
							validate={connectIdTooLong}
							mono
						/>
						<InlineField
							label="Connect ID"
							value="learn_intro"
							onChange={alwaysReject(CONNECT_ID_DUP)}
							mono
						/>
					</div>
				</Section>

				<Section
					title="Standalone callout / inline (motion)"
					hint="Toggle the raw pieces directly to inspect entrance/exit animation."
				>
					<div className="flex gap-3">
						<button
							type="button"
							className="px-3 py-1.5 text-xs rounded-md border border-white/[0.08] hover:border-nova-violet/40 cursor-pointer"
							onClick={() =>
								setCalloutMessage((m) => (m ? null : FIELD_ID_TAKEN))
							}
						>
							Toggle callout
						</button>
						<button
							type="button"
							className="px-3 py-1.5 text-xs rounded-md border border-white/[0.08] hover:border-nova-violet/40 cursor-pointer"
							onClick={() =>
								setInlineMessage((m) => (m ? null : FORMULA_BAD_REF))
							}
						>
							Toggle inline
						</button>
					</div>
					<div className="relative inline-block">
						<span className="text-lg font-display font-semibold px-1">
							visit_score
						</span>
						<RejectionCallout message={calloutMessage} />
					</div>
					<div className="max-w-sm pt-16">
						<RejectionInline message={inlineMessage} />
					</div>
				</Section>

				<Section
					title="Anchored popup chrome — XPathField / FieldIdentitySection"
					hint="The static surface those popovers share. A refused field-ID rename (FieldIdentitySection) surfaces here."
				>
					<div className={`px-3 py-2.5 max-w-sm ${REJECTION_SURFACE_CLS}`}>
						<RejectionBody
							message={FIELD_ID_TAKEN}
							hint="Press Esc to discard changes"
						/>
					</div>
				</Section>

				<Section
					title="Toasts"
					hint="The announcing channel — only for rejections with no contextual anchor."
				>
					<div className="flex flex-wrap gap-3">
						<button
							type="button"
							className="px-3 py-1.5 text-xs rounded-md border border-white/[0.08] hover:border-nova-violet/40 cursor-pointer"
							onClick={() =>
								showToast("error", "Change not applied", undefined, {
									lines: [FIELD_ID_TAKEN],
								})
							}
						>
							Gate rejection (1 finding)
						</button>
						<button
							type="button"
							className="px-3 py-1.5 text-xs rounded-md border border-white/[0.08] hover:border-nova-violet/40 cursor-pointer"
							onClick={() =>
								showToast("error", "Change not applied", undefined, {
									lines: [
										FIELD_ID_TAKEN,
										CONNECT_MISSING_ROLE,
										FORMULA_BAD_REF,
									],
								})
							}
						>
							Gate rejection (3 findings)
						</button>
						<button
							type="button"
							className="px-3 py-1.5 text-xs rounded-md border border-white/[0.08] hover:border-nova-violet/40 cursor-pointer"
							onClick={() =>
								showToast(
									"warning",
									"App reloaded",
									"This app was changed outside this window — by an agent connection or another tab. We loaded the latest version so nothing gets overwritten; your last change here wasn't saved, so redo it if you still want it.",
								)
							}
						>
							Warning
						</button>
						<button
							type="button"
							className="px-3 py-1.5 text-xs rounded-md border border-white/[0.08] hover:border-nova-violet/40 cursor-pointer"
							onClick={() =>
								showToast(
									"info",
									"Field renamed to avoid conflict",
									'"visit_date" → "visit_date_2" (3 references updated)',
								)
							}
						>
							Info
						</button>
					</div>
				</Section>
			</div>
		</div>
	);
}
