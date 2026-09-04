"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import {
	type Form,
	formEntersFromMenu,
	isNoMatchesForm,
	moduleOpensOnSearch,
	type Uuid,
} from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { selectableSegmentCls } from "@/lib/styles";
import {
	NoMatchesFormReviewDialog,
	useNoMatchesFormEntry,
} from "../noMatchesFormReview";

export interface NoMatchesFormSettingProps {
	readonly moduleUuid: Uuid;
}

/**
 * What Results offers after a search finds nothing: only the notice, or a
 * registration form that opens with the search's answers (the module's
 * no-matches form, `Form.entry`). Offering a form is reviewed first
 * because it changes what people see: the module opens on Search, and the
 * form leaves the menu. The choice is one setting of the Search canvas so
 * the whole search-before-register shape reads in one place.
 */
export function NoMatchesFormSetting({
	moduleUuid,
}: NoMatchesFormSettingProps) {
	const canEdit = useCanEdit();
	const navigate = useNavigate();
	const mod = useModule(moduleUuid);
	const forms = useOrderedForms(moduleUuid);
	const entry = useNoMatchesFormEntry(moduleUuid);
	const [choosing, setChoosing] = useState(false);
	const choiceName = useId();
	const current = forms.find(isNoMatchesForm);
	const candidates = forms.filter(
		(form) => form.type === "registration" && formEntersFromMenu(form),
	);
	const offering = current !== undefined || choosing;
	const actionLabel = current?.entry?.label ?? current?.name;
	const help =
		current === undefined
			? "Results shows the notice when nothing matches. Offer a registration form so people can register what they searched for."
			: `Results offers “${actionLabel}” when nothing matches. It opens “${current.name}” with the search's answers${
					current.entry?.label === undefined ? "" : ", named after the action"
				}.`;

	const offer = (origin: HTMLElement) => {
		if (current !== undefined) return;
		if (candidates.length === 0) {
			entry.request({ kind: "create" }, origin);
			return;
		}
		setChoosing(true);
	};
	const choose = (form: Form | undefined, origin: HTMLElement) => {
		setChoosing(false);
		entry.request(
			form === undefined
				? { kind: "create" }
				: { kind: "existing", formUuid: form.uuid },
			origin,
		);
	};

	return (
		<section aria-labelledby="no-matches-heading" data-no-matches-setting>
			<div className="mb-4">
				<h2
					id="no-matches-heading"
					className="font-display tracking-tighter text-[17px] font-semibold text-nova-text"
				>
					When no cases match
				</h2>
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
					{help}
				</p>
			</div>

			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{entry.announcement}
			</p>
			{entry.refusal !== undefined && (
				<div
					role="alert"
					className="mb-3 flex max-w-xl gap-2 rounded-xl border border-nova-rose/25 bg-nova-rose/[0.06] px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary"
				>
					<Icon
						icon={tablerAlertCircle}
						width="16"
						height="16"
						className="mt-0.5 shrink-0 text-nova-rose"
					/>
					<span>{entry.refusal}</span>
				</div>
			)}

			{canEdit ? (
				<div className="max-w-xl rounded-2xl border border-white/[0.08] bg-nova-surface/20 p-4">
					<fieldset className="grid grid-cols-2 gap-1 rounded-2xl bg-nova-deep/50 p-1">
						<legend className="sr-only">
							What Results offers when nothing matches
						</legend>
						<label
							className={`${selectableSegmentCls(!offering)} has-[input:focus-visible]:border-nova-ring has-[input:focus-visible]:shadow-(--focus-ring)`}
						>
							<input
								type="radio"
								name={choiceName}
								value="notice"
								checked={!offering}
								onChange={(event) => {
									setChoosing(false);
									if (current !== undefined) {
										entry.request({ kind: "clear" }, event.currentTarget);
									}
								}}
								className="sr-only"
							/>
							Only the notice
						</label>
						<label
							className={`${selectableSegmentCls(offering)} has-[input:focus-visible]:border-nova-ring has-[input:focus-visible]:shadow-(--focus-ring)`}
						>
							<input
								type="radio"
								name={choiceName}
								value="register"
								checked={offering}
								onChange={(event) => offer(event.currentTarget)}
								className="sr-only"
							/>
							Offer a registration form
						</label>
					</fieldset>

					{current !== undefined && !choosing && (
						<div className="mt-4 flex flex-wrap items-center gap-2">
							<span className="min-w-0 flex-1 text-[14px] text-nova-text">
								<span className="font-medium">{current.name}</span>
								<span className="mt-0.5 block text-[13px] text-nova-text-muted">
									The action's label and the carried answers are in the form's
									settings.
								</span>
							</span>
							<Button
								type="button"
								variant="ghost-action"
								onClick={() => navigate.openForm(moduleUuid, current.uuid)}
							>
								Open form
								<Icon icon={tablerArrowRight} width="15" height="15" />
							</Button>
							{candidates.length > 0 && (
								<Button
									type="button"
									variant="ghost-action"
									onClick={() => setChoosing(true)}
								>
									Change
								</Button>
							)}
						</div>
					)}

					{choosing && (
						<div className="mt-4">
							<p className="text-sm font-medium text-nova-text">
								Which form should open?
							</p>
							<ul className="mt-2 grid gap-2">
								{candidates.map((form) => (
									<li key={form.uuid}>
										<Button
											type="button"
											variant="outline"
											onClick={(event) => choose(form, event.currentTarget)}
											className="h-auto min-h-11 w-full justify-between gap-3 border-white/[0.08] bg-white/[0.025] px-3 py-2.5 text-left text-[14px]"
										>
											<span className="min-w-0 flex-1 break-words font-medium text-nova-text">
												{form.name}
											</span>
											<span className="shrink-0 font-medium text-nova-violet-bright">
												Offer
											</span>
										</Button>
									</li>
								))}
								<li>
									<Button
										type="button"
										variant="outline"
										onClick={(event) => choose(undefined, event.currentTarget)}
										className="h-auto min-h-11 w-full justify-start gap-2 border-dashed border-white/[0.12] bg-transparent px-3 py-2.5 text-left text-[14px] text-nova-text-secondary"
									>
										<Icon icon={tablerPlus} width="15" height="15" />
										Add a new registration form
									</Button>
								</li>
							</ul>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setChoosing(false)}
								className="mt-2"
							>
								{current === undefined
									? "Keep the notice only"
									: "Keep the current form"}
							</Button>
						</div>
					)}

					<p className="mt-4 text-[13px] leading-relaxed text-nova-text-muted">
						{mod !== undefined && moduleOpensOnSearch(mod)
							? "The action and the carried answers work in the browser app. A phone never shows Results for an empty search."
							: "Offering a form turns Search first on: people search before they see any cases."}
					</p>
				</div>
			) : (
				current !== undefined && (
					<p className="text-[14px] text-nova-text">
						<span className="font-medium">{current.name}</span>
						<span className="text-nova-text-muted"> opens from Results</span>
					</p>
				)
			)}

			{entry.review !== null && (
				<NoMatchesFormReviewDialog
					review={entry.review}
					finalFocus={entry.finalFocus}
					onCancel={entry.cancel}
					onConfirm={entry.confirm}
				/>
			)}
		</section>
	);
}
