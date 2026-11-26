"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useFieldTextForm } from "@/lib/doc/hooks/useFieldTextForm";
import type { Uuid } from "@/lib/domain";
import { labelShowsAsTyped } from "@/lib/domain";
import {
	type QuestionBanner,
	usePresentationField,
	useScreenBanners,
} from "@/lib/preview/hooks/useVisibleFieldOrder";
import { LabelContent } from "@/lib/references/LabelContent";
import { usePreviewPlatformRules } from "@/lib/session/hooks";

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
	const { questionBanner } = usePreviewPlatformRules();
	const banners = useScreenBanners(uuid, path);
	if (!questionBanner || !banners.length) return null;
	return <AndroidBanners banners={banners} />;
}

function AndroidBanners({ banners }: { banners: readonly QuestionBanner[] }) {
	const labels = useRef<HTMLDivElement>(null);
	const [visibleText, setVisibleText] = useState<ReadonlyMap<string, string>>(
		() => new Map(),
	);
	// Markwon groups the displayed text, after formatting and substitution.
	// Read our own platform label renderer's result so a change in a value,
	// language or plain-text setting also updates the pairing.
	useLayoutEffect(() => {
		const container = labels.current;
		if (!container) return;
		function measure() {
			if (!container) return;
			const next = new Map(
				Array.from(
					container.querySelectorAll<HTMLElement>("[data-banner-source]"),
					(element) => [
						element.dataset.bannerSource ?? "",
						element.textContent ?? "",
					],
				),
			);
			setVisibleText((previous) =>
				previous.size === next.size &&
				[...next].every(([key, value]) => previous.get(key) === value)
					? previous
					: next,
			);
		}
		measure();
		const observer = new MutationObserver(measure);
		observer.observe(container, {
			childList: true,
			characterData: true,
			subtree: true,
		});
		return () => observer.disconnect();
	}, []);
	const text = (banner: QuestionBanner) =>
		visibleText.get(banner.path) ?? banner.text;
	const short = banners.filter((b) => text(b).length < 15);
	const rows: QuestionBanner[][] = [];
	for (let ix = 1; ix < short.length; ix += 2)
		rows.push([short[ix - 1], short[ix]]);
	rows.push(...banners.filter((b) => text(b).length >= 15).map((b) => [b]));
	if (short.length % 2 === 1) rows.push([short[short.length - 1]]);
	return (
		<div className="mx-3 mb-2 space-y-1">
			<div ref={labels} hidden>
				{banners.map((banner) => (
					<div key={banner.path} data-banner-source={banner.path}>
						<BannerLabel banner={banner} />
					</div>
				))}
			</div>
			{rows.map(([first, second]) => (
				<div
					key={first.path}
					data-question-banner={first.tone}
					className={`rounded px-3 py-2 text-sm font-semibold ${colors[first.tone]}`}
				>
					{second ? (
						`${text(first)}; ${text(second)}`
					) : (
						<BannerLabel banner={first} />
					)}
				</div>
			))}
		</div>
	);
}
