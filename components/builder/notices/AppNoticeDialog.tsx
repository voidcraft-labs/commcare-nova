/**
 * What changed in this app: every notice this member has not dismissed, one
 * section per notice under its cutover's lead, each line from its reason's
 * renderer. An entity's name links to the entity where it still exists and
 * reads by the name it had when the cutover ran where it does not.
 *
 * "Got it" dismisses every notice shown, for this member alone. The dialog
 * closes whatever the server answers, since a notice it no longer finds is
 * one the builder should stop showing too.
 */
"use client";

import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { dismissAppNoticeAction } from "@/lib/notices/actions";
import { documentNoticeNames } from "@/lib/notices/documentNames";
import type { AppMigrationNotice } from "@/lib/notices/migrationNotice";
import {
	NOTICE_DIALOG_BUTTON,
	NOTICE_DIALOG_TITLE,
	type NoticeLine,
	noticeLead,
} from "@/lib/notices/migrationNoticeCopy";
import { useNavigate } from "@/lib/routing/hooks";
import { showToast } from "@/lib/ui/toastStore";
import {
	type NoticeEntityDestination,
	noticeDialogSections,
	noticeEntityDestination,
} from "./appNoticeModel";

interface AppNoticeDialogProps {
	readonly appId: string;
	readonly notices: readonly AppMigrationNotice[];
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	/** Called with the ids the member dismissed. */
	readonly onDismissed: (noticeIds: readonly string[]) => void;
}

export function AppNoticeDialog({
	appId,
	notices,
	open,
	onOpenChange,
	onDismissed,
}: AppNoticeDialogProps) {
	const [dismissing, setDismissing] = useState(false);

	const dismiss = async () => {
		const ids = notices.map((notice) => notice.id);
		setDismissing(true);
		try {
			await Promise.all(
				ids.map((noticeId) => dismissAppNoticeAction({ appId, noticeId })),
			);
			onOpenChange(false);
			onDismissed(ids);
		} catch {
			showToast(
				"error",
				"Nova couldn't dismiss these updates",
				"They're still here for you. Try again in a moment.",
			);
		} finally {
			setDismissing(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{NOTICE_DIALOG_TITLE}</DialogTitle>
				</DialogHeader>
				{open ? (
					<NoticeSections
						notices={notices}
						onFollow={() => onOpenChange(false)}
					/>
				) : null}
				<DialogFooter>
					<Button
						type="button"
						onClick={() => void dismiss()}
						disabled={dismissing || notices.length === 0}
					>
						{NOTICE_DIALOG_BUTTON}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The dialog's body. Reads the document once as it opens, which is enough:
 * the names a line shows only need to be right when the person reads them.
 */
function NoticeSections({
	notices,
	onFollow,
}: {
	notices: readonly AppMigrationNotice[];
	onFollow: () => void;
}) {
	const doc = useBlueprintDocApi().getState();
	const navigate = useNavigate();
	const sections = noticeDialogSections(notices, documentNoticeNames(doc));

	const follow = (destination: NoticeEntityDestination) => {
		onFollow();
		switch (destination.kind) {
			case "module":
				navigate.openModule(destination.moduleUuid);
				return;
			case "form":
				navigate.openForm(
					destination.moduleUuid,
					destination.formUuid,
					destination.fieldUuid,
				);
				return;
			case "case-list":
				navigate.openCaseList(destination.moduleUuid);
				return;
			case "search":
				navigate.openSearchConfig(destination.moduleUuid);
				return;
			case "app-setup":
				navigate.openAppSetup(destination.section, destination.entryPointUuid);
				return;
		}
	};

	const renderLine = (line: NoticeLine) =>
		line.parts.map((part, index) => {
			const key = `${index}`;
			if (part.kind === "text") return <span key={key}>{part.text}</span>;
			const destination = part.exists
				? noticeEntityDestination(doc, part.entity)
				: null;
			return destination === null ? (
				<span key={key} className="font-medium text-nova-text">
					{part.text}
				</span>
			) : (
				<Button
					key={key}
					type="button"
					variant="link"
					onClick={() => follow(destination)}
					className="inline h-auto px-0 align-baseline text-[13px] whitespace-normal"
				>
					{part.text}
				</Button>
			);
		});

	return (
		<DialogBody className="flex flex-col gap-6">
			{sections.map((section) => (
				<section key={section.noticeId} className="flex flex-col gap-4">
					<p className="text-sm text-nova-text-secondary">
						{noticeLead(section.cutover, section.createdAt)}
					</p>
					{section.groups.map((group) => (
						<div key={group.key} className="flex flex-col gap-2">
							{group.kind === "deployment" ? (
								<h3 className="text-[13px] font-medium text-nova-text">
									{group.heading}
								</h3>
							) : null}
							<ul className="flex flex-col gap-2 text-[13px] leading-relaxed text-nova-text-secondary">
								{group.lines.map((line, index) => (
									// Lines never reorder while the dialog is open.
									// biome-ignore lint/suspicious/noArrayIndexKey: two entries can render the same sentence, so the text is no key.
									<li key={index}>{renderLine(line)}</li>
								))}
							</ul>
						</div>
					))}
				</section>
			))}
		</DialogBody>
	);
}
