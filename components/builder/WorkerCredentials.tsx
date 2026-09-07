"use client";

import { Icon } from "@iconify/react/offline";
import tablerCopy from "@iconify-icons/tabler/copy";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import type { ProvisionWorkersView } from "@/lib/deployment/actions";
import {
	workerCredentialRows,
	workerCredentialStatus,
	workerCredentialsText,
} from "@/lib/deployment/workerCredentialRows";
import type { UnconfirmedWorker } from "@/lib/deployment/workerProvisionPlan";

/**
 * Every password this call produced, whether or not its account is
 * certain.
 *
 * One block and ONE copy button for both kinds, deliberately. The person
 * doing this is about to hand these out, and copying six passwords one at
 * a time is how one gets missed; splitting the unconfirmed ones into a
 * second block with a second button would make missing them the default.
 * They are marked in place instead, so what is uncertain is the account
 * rather than whether the credential is worth keeping.
 */
export function WorkerCredentials({
	workers,
	unconfirmed,
	onDismiss,
}: {
	workers: ProvisionWorkersView["workers"];
	unconfirmed: readonly (readonly [string, UnconfirmedWorker])[];
	onDismiss: (key: string) => void;
}) {
	/* What was copied, not whether something was. The block now stays
	 * mounted across calls, so a latched boolean would still read "Copied"
	 * after a later answer added a password the clipboard has never held —
	 * telling somebody they have a credential they do not. */
	const [copiedText, setCopiedText] = useState<string | null>(null);
	const [copyError, setCopyError] = useState(false);
	const rows = workerCredentialRows(workers, unconfirmed);
	const withPasswords = rows.filter((row) => row.password !== null);
	const text = workerCredentialsText(rows);
	const doubtful = rows.filter((row) => row.uncertainty !== null);
	return (
		<div className="mt-3 rounded-lg border border-nova-border bg-nova-elevated px-3 py-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<p className="text-[13px] leading-relaxed text-nova-text">
					{withPasswords.length > 0
						? "You can copy these passwords before leaving this page. Nova won’t be able to show them again."
						: "These accounts are now in step with the app. Their passwords are unchanged."}
				</p>
				{withPasswords.length > 0 ? (
					<Button
						variant="ghost-action"
						onClick={async () => {
							try {
								await navigator.clipboard.writeText(text);
								setCopiedText(text);
								setCopyError(false);
							} catch {
								setCopyError(true);
							}
						}}
					>
						<Icon icon={tablerCopy} aria-hidden="true" />
						{copiedText === text ? "Copied" : "Copy all"}
					</Button>
				) : null}
			</div>
			{copyError ? (
				<p role="alert" className="mt-2 text-[12px] text-nova-rose">
					Couldn't copy them. Select the lines below instead.
				</p>
			) : null}
			{doubtful.length > 0 ? (
				<p className="mt-2 text-[12px] leading-relaxed text-nova-text-secondary">
					Nova couldn’t confirm these credentials. If a username has more than
					one password, you can keep each until you confirm which works in
					CommCare HQ.
				</p>
			) : null}
			<ul className="mt-2.5 flex flex-col gap-1.5 text-[13px]">
				{rows.map((row) => (
					<li key={row.key} className="break-words">
						<span className="text-nova-text">{row.personaName}</span>
						{row.uncertainty === null ? null : (
							<>
								<span className="ml-1.5 rounded border border-nova-amber/40 bg-nova-amber/10 px-1.5 py-0.5 text-[11px] text-nova-text-secondary">
									{workerCredentialStatus(row)}
								</span>
								<Button
									variant="ghost-action"
									className="ml-1.5 px-2"
									onClick={() => {
										if (row.dismissKey !== null) onDismiss(row.dismissKey);
									}}
								>
									I have this
								</Button>
							</>
						)}
						<span className="block font-mono text-[12px] text-nova-text-secondary">
							{row.username}
							{row.password !== null ? `  ${row.password}` : ""}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}
