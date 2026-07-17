/**
 * FieldAdvisorySection — the inspector's detail + resolution surface
 * for a no-writer advisory (`lib/doc/noWriterAdvisories.ts`) on the
 * selected field. The canvas chip (`NoWriterAdvisoryChip`) is the
 * signal; this section explains what's gated and carries the one
 * builder-side resolution: declaring the property as set outside this
 * app (optionally noting what sets it), which records the fact on the
 * catalog and silences the advisory everywhere. The other resolution —
 * adding a writer field — is ordinary authoring, so the section only
 * names it.
 *
 * Renders nothing when the selected field gate-reads no dead-end
 * property, so the body mounts it unconditionally.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerPencilOff from "@iconify-icons/tabler/pencil-off";
import { useState } from "react";
import {
	INSPECTOR_INPUT_CLS,
	InspectorHint,
	InspectorSection,
} from "@/components/builder/inspector/inspectorChrome";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCarrierNoWriterAdvisories } from "@/lib/doc/hooks/useNoWriterAdvisories";
import type { NoWriterAdvisory } from "@/lib/doc/noWriterAdvisories";
import type { Field } from "@/lib/domain";

interface FieldAdvisorySectionProps {
	field: Field;
}

export function FieldAdvisorySection({ field }: FieldAdvisorySectionProps) {
	const advisories = useCarrierNoWriterAdvisories(field.uuid);
	if (advisories.length === 0) return null;
	return (
		<InspectorSection label="Advisory">
			{advisories.map((advisory) => (
				<AdvisoryResolver
					key={`${advisory.caseType}/${advisory.property}`}
					field={field}
					advisory={advisory}
				/>
			))}
		</InspectorSection>
	);
}

function AdvisoryResolver({
	field,
	advisory,
}: {
	field: Field;
	advisory: NoWriterAdvisory;
}) {
	const { inline } = useBlueprintMutations();
	const [note, setNote] = useState("");
	const [rejection, setRejection] = useState<string[]>([]);

	/* How THIS field reads the property — its own gate slots drive the
	 * explanation; reads on other carriers are summarized as a count so
	 * the card stays about the thing the user selected. */
	const ownSlots = advisory.reads
		.filter((read) => read.carrier === field.uuid)
		.map((read) => read.slot);
	const gatedBehaviors = [
		...(ownSlots.includes("relevant") ? ["when this field shows"] : []),
		...(ownSlots.includes("validate") ? ["this field's validation"] : []),
	];
	const behaviorText =
		gatedBehaviors.length > 0
			? gatedBehaviors.join(" and ")
			: "this field's behavior";
	const elsewhere = advisory.reads.filter(
		(read) => read.carrier !== field.uuid,
	).length;

	const declareExternal = () => {
		const trimmed = note.trim();
		const outcome = inline.markCasePropertyExternal(
			advisory.caseType,
			advisory.property,
			trimmed.length > 0 ? { note: trimmed } : {},
		);
		if (!outcome.ok) setRejection(outcome.messages);
	};

	return (
		<div className="space-y-2.5 rounded-lg border border-nova-amber/30 bg-nova-amber/5 p-3">
			<p className="flex items-start gap-1.5 text-[12px] leading-snug text-nova-text">
				<Icon
					icon={tablerPencilOff}
					width="13"
					height="13"
					className="mt-0.5 shrink-0 text-nova-amber"
				/>
				<span>
					<code className="font-mono">{advisory.property}</code> controls{" "}
					{behaviorText}, but no form in this app sets it — records can only
					reach the gated state if something outside this app writes it.
					{elsewhere > 0 &&
						` It also gates ${elsewhere} other place${elsewhere === 1 ? "" : "s"} in the app.`}
				</span>
			</p>
			<InspectorHint>
				If a form here should set it, add a field with id{" "}
				<code className="font-mono">{advisory.property}</code> saving to{" "}
				<code className="font-mono">{advisory.caseType}</code>. If another app
				or system sets it, record that below and this stops flagging.
			</InspectorHint>
			<input
				type="text"
				value={note}
				onChange={(e) => setNote(e.target.value)}
				className={INSPECTOR_INPUT_CLS}
				placeholder="What sets it? (optional note)"
				autoComplete="off"
				data-1p-ignore
			/>
			<button
				type="button"
				onClick={declareExternal}
				className="w-full min-h-11 rounded-lg border border-nova-amber/40 px-3 text-[13px] text-nova-text transition-colors hover:bg-nova-amber/10"
			>
				Mark as set outside this app
			</button>
			{rejection.length > 0 && (
				<p className="text-[11px] leading-relaxed text-nova-rose">
					{rejection.join(" ")}
				</p>
			)}
		</div>
	);
}
