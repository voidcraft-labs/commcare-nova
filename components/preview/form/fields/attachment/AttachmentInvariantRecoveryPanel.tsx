"use client";

import { useEffect, useState } from "react";
import { useFieldsAndOrder } from "@/lib/doc/hooks/useFieldsAndOrder";
import { fieldRegistry } from "@/lib/domain";
import {
	discardAttachmentInvariantRecovery,
	listAttachmentInvariantRecoveries,
	subscribeAttachmentSlotState,
} from "./attachmentClient";

/**
 * Recovery-only surface for an attachment whose old concrete path cannot be
 * projected into the current authored tree.
 *
 * This deliberately does not register a current field path. The stable field
 * UUID gives the worker a question-qualified destructive action, but only a
 * future valid engine migration may assert where that answer now lives.
 */
export function AttachmentInvariantRecoveryPanel({
	appId,
	entryKey,
}: {
	readonly appId: string;
	readonly entryKey: string;
}) {
	const { fields } = useFieldsAndOrder();
	const [, setRevision] = useState(0);
	useEffect(
		() =>
			subscribeAttachmentSlotState(entryKey, () => {
				setRevision((current) => current + 1);
			}),
		[entryKey],
	);
	const recoveries = listAttachmentInvariantRecoveries({ appId, entryKey });
	if (recoveries.length === 0) return null;

	return (
		<section
			aria-label="Attachment recovery"
			className="mx-6 mb-6 rounded-lg border border-nova-amber/40 bg-nova-amber/10 p-4"
		>
			<h3 className="text-sm font-medium text-nova-text">
				Attachment needs attention
			</h3>
			<ul className="mt-3 space-y-3">
				{recoveries.map((recovery) => {
					const field = fields[recovery.fieldUuid];
					const authoredLabel =
						field !== undefined &&
						"label" in field &&
						typeof field.label === "string" &&
						field.label.trim().length > 0
							? field.label.trim()
							: undefined;
					const question =
						authoredLabel ??
						(field === undefined
							? `Question ${recovery.fieldUuid}`
							: fieldRegistry[field.kind].label);
					const signature = recovery.captureKind === "signature";
					const action = signature
						? `Clear signature for ${question}`
						: `Remove attachment from ${question}`;
					return (
						<li
							key={recovery.slotKey}
							data-attachment-invariant-recovery
							data-field-uuid={recovery.fieldUuid}
							className="space-y-2"
						>
							<p className="text-sm font-medium text-nova-text">{question}</p>
							<p className="text-xs leading-relaxed text-nova-text-muted">
								{recovery.message}
							</p>
							<button
								type="button"
								data-attachment-recovery
								data-attachment-recovery-field-uuid={recovery.fieldUuid}
								onClick={() => {
									discardAttachmentInvariantRecovery({
										appId,
										entryKey,
										slotKey: recovery.slotKey,
									});
								}}
								className="inline-flex min-h-11 items-center rounded-lg border border-nova-amber/50 px-3 py-2 text-sm font-medium text-nova-text transition-colors hover:bg-nova-amber/15"
							>
								{action}
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
