"use client";

import { useFieldTextForm } from "@/lib/doc/hooks/useFieldTextForm";
import type { Uuid } from "@/lib/domain";
import { labelShowsAsTyped } from "@/lib/domain";
import {
	type QuestionBanner,
	usePresentationField,
	useScreenBanners,
} from "@/lib/preview/hooks/useVisibleFieldOrder";
import { LabelContent } from "@/lib/references/LabelContent";
import {
	usePreviewPlatform,
	usePreviewPlatformRules,
} from "@/lib/session/hooks";

function BannerLabel({ banner }: { banner: QuestionBanner }) {
	const field = usePresentationField(banner.uuid);
	const textForm = useFieldTextForm(banner.uuid);
	const rules = usePreviewPlatformRules();
	if (!field || !("label" in field) || !field.label) return null;
	return (
		<LabelContent
			label={field.label}
			resolvedLabel={banner.text}
			isEditMode={false}
			rendering={rules.labelMarkdown}
			plainLabel={labelShowsAsTyped(textForm, field)}
			className="text-current"
		/>
	);
}
const colors = {
	good: "bg-nova-mint/15 text-nova-mint",
	caution: "bg-nova-amber/15 text-nova-amber",
	bad: "bg-nova-rose/15 text-nova-rose",
};

/** FormNavigationUI.updateFloatingLabels puts pairs of short labels first,
 * borrowing the first question's color. Odd short labels follow longer ones. */
export function QuestionBanners({ uuid, path }: { uuid: Uuid; path: string }) {
	const platform = usePreviewPlatform();
	const banners = useScreenBanners(uuid, path);
	if (platform !== "android") return null;
	const short = banners.filter((b) => b.text.length < 15);
	const rows: QuestionBanner[][] = [];
	for (let ix = 1; ix < short.length; ix += 2)
		rows.push([short[ix - 1], short[ix]]);
	rows.push(...banners.filter((b) => b.text.length >= 15).map((b) => [b]));
	if (short.length % 2 === 1) rows.push([short[short.length - 1]]);
	if (!rows.length) return null;
	return (
		<div className="mx-3 mb-2 space-y-1">
			{rows.map(([first, second]) => (
				<div
					key={first.path}
					data-question-banner={first.tone}
					className={`rounded px-3 py-2 text-sm font-semibold ${colors[first.tone]}`}
				>
					{second ? (
						`${first.text}; ${second.text}`
					) : (
						<BannerLabel banner={first} />
					)}
				</div>
			))}
		</div>
	);
}
