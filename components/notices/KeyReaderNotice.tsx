/**
 * The home page's one line for a person whose own saved CommCare HQ key an
 * update sent to read their project spaces. It names the project spaces and
 * never an app, since the person may have left the Project an app is in, and
 * it has its own dismissal, separate from any app's notice.
 *
 * The line names days in the viewer's own time zone, which only the browser
 * knows, so it renders once the page is running there.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerKey from "@iconify-icons/tabler/key";
import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/shadcn/button";
import { dismissKeyReaderNoticesAction } from "@/lib/notices/actions";
import type { KeyReaderNotice as KeyReaderRow } from "@/lib/notices/migrationNotice";
import {
	keyReaderNoticeLine,
	NOTICE_DIALOG_BUTTON,
} from "@/lib/notices/migrationNoticeCopy";
import { showToast } from "@/lib/ui/toastStore";

const subscribeNever = () => () => {};

export function KeyReaderNotice({ rows }: { rows: readonly KeyReaderRow[] }) {
	const inBrowser = useSyncExternalStore(
		subscribeNever,
		() => true,
		() => false,
	);
	const [dismissed, setDismissed] = useState(false);
	const [pending, setPending] = useState(false);
	if (!inBrowser || dismissed || rows.length === 0) return null;

	const dismiss = async () => {
		setPending(true);
		try {
			await dismissKeyReaderNoticesAction();
			setDismissed(true);
		} catch {
			showToast(
				"error",
				"Nova couldn't dismiss this note",
				"It's still here for you. Try again in a moment.",
			);
		} finally {
			setPending(false);
		}
	};

	return (
		<div
			role="status"
			className="flex items-center gap-3 rounded-lg border border-nova-border bg-nova-surface px-4 py-3 text-sm"
		>
			<Icon
				icon={tablerKey}
				width="18"
				height="18"
				aria-hidden="true"
				className="shrink-0 text-nova-violet-bright"
			/>
			<span className="flex-1 text-nova-text">{keyReaderNoticeLine(rows)}</span>
			<Button
				type="button"
				variant="ghost-action"
				onClick={() => void dismiss()}
				disabled={pending}
			>
				{NOTICE_DIALOG_BUTTON}
			</Button>
		</div>
	);
}
