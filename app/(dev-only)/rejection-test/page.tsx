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
import type { CommitOutcome } from "@/lib/domain";
import { showToast } from "@/lib/ui/toastStore";

// Standalone test page — no builder dependency. Every commit surface is
// wired to a gate stub that always refuses with a real validator
// sentence, so each rejection presentation can be exercised and eyeballed
// in isolation: type into a control, press Enter, watch the bounce.

// The CONCISE builder copy these surfaces now render (lib/doc/userFacingErrors.ts
// + the field-id verdict's userMessage) — not the verbose SA-facing messages.
const DUPLICATE_MODULE =
	'Another module is already named "Clients". Give each module a different name.';
const HIDDEN_NO_VALUE =
	'"visit_score" in "Follow-up" is a hidden field with nothing to fill it in, so it stays blank. Give it a calculated value or a default.';
const LAST_PARTICIPATING =
	"This Connect app has no form taking part in Connect yet. Give at least one form a Connect block, or turn Connect off for the app.";
const ID_TOO_LONG =
	"That id is too long (44 characters). Keep it to 40 or fewer.";

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
					title="EditableTitle — floating callout"
					hint="Click the title, change it, press Enter. Every commit is refused: the input shakes, keeps your draft, and the callout explains."
				>
					<EditableTitle
						value="Clients"
						onSave={alwaysReject(DUPLICATE_MODULE)}
					/>
				</Section>

				<Section
					title="EditableText — inline notice"
					hint="Edit and press Enter; the notice expands beneath, the border flips rose."
				>
					<div className="max-w-sm">
						<EditableText
							label="Search screen title"
							value="Find a client"
							onSave={alwaysReject(DUPLICATE_MODULE)}
						/>
					</div>
				</Section>

				<Section
					title="InlineField — dense panel variant"
					hint="Left: live reason while typing (no register line). Right: gate rejection on Enter ('Not saved')."
				>
					<div className="grid grid-cols-2 gap-4 max-w-lg">
						<InlineField
							label="Module ID"
							value="clients"
							onChange={() => ({ ok: true }) as CommitOutcome}
							validate={(v) => (v.length > 12 ? ID_TOO_LONG : null)}
							mono
						/>
						<InlineField
							label="Learn module name"
							value="Client basics"
							onChange={alwaysReject(LAST_PARTICIPATING)}
						/>
					</div>
				</Section>

				<Section
					title="Standalone callout / inline (controlled)"
					hint="Toggle the pieces directly to inspect entrance/exit motion."
				>
					<div className="flex gap-3">
						<button
							type="button"
							className="px-3 py-1.5 text-xs rounded-md border border-white/[0.08] hover:border-nova-violet/40 cursor-pointer"
							onClick={() =>
								setCalloutMessage((m) => (m ? null : DUPLICATE_MODULE))
							}
						>
							Toggle callout
						</button>
						<button
							type="button"
							className="px-3 py-1.5 text-xs rounded-md border border-white/[0.08] hover:border-nova-violet/40 cursor-pointer"
							onClick={() =>
								setInlineMessage((m) => (m ? null : HIDDEN_NO_VALUE))
							}
						>
							Toggle inline
						</button>
					</div>
					<div className="relative inline-block">
						<span className="text-lg font-display font-semibold px-1">
							Clients
						</span>
						<RejectionCallout message={calloutMessage} />
					</div>
					<div className="max-w-sm pt-16">
						<RejectionInline message={inlineMessage} />
					</div>
				</Section>

				<Section
					title="Anchored popup chrome (XPathField / FieldHeader)"
					hint="The static surface those popovers now share."
				>
					<div className={`px-3 py-2.5 max-w-sm ${REJECTION_SURFACE_CLS}`}>
						<RejectionBody
							message="This expression creates a loop: visit_score depends on risk_level, which depends on visit_score. Break the cycle by removing one of the references."
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
									lines: [DUPLICATE_MODULE],
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
									lines: [HIDDEN_NO_VALUE, LAST_PARTICIPATING, ID_TOO_LONG],
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
