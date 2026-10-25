"use client";

/**
 * The platform note row: where the author works, a permanent line for each
 * way a feature this place uses behaves differently on a platform the app
 * runs on, read from the platform table (`platformSentence`), so the builder,
 * the guide and the gate state one difference in one set of words.
 *
 * It states only the declared platforms' clauses and only a feature that
 * some declared platform runs `different` or `ignores`: the gate admits no
 * use a declared platform cannot run, so a remedy never shows here. `stated`
 * names a feature to state whatever its reading (the one mount is
 * `search-first` beside a question that reads a Search field). It renders
 * nothing when no feature qualifies, carries no icon and has no dismiss: the
 * difference is a property of the app, not a notice to acknowledge.
 */

import { useDeclaredPlatforms } from "@/lib/doc/hooks/useDeclaredPlatforms";
import {
	PLATFORM_FEATURE_IDS,
	type PlatformFeatureId,
	platformBehavior,
	platformSentence,
} from "@/lib/domain/platforms";

export function PlatformNoteRow({
	features,
	stated = [],
	className,
}: {
	readonly features: readonly PlatformFeatureId[];
	readonly stated?: readonly PlatformFeatureId[];
	/** Spacing from the mount's neighbours, applied only when a note shows. */
	readonly className?: string;
}) {
	const platforms = useDeclaredPlatforms();
	const differs = new Set(
		features.filter((feature) =>
			platforms.some((platform) => {
				const reading = platformBehavior(feature, platform).reading;
				return reading === "different" || reading === "ignored";
			}),
		),
	);
	for (const feature of stated) differs.add(feature);
	const sentences = PLATFORM_FEATURE_IDS.filter((feature) =>
		differs.has(feature),
	)
		.map((feature) => ({ feature, text: platformSentence(feature, platforms) }))
		.filter((sentence) => sentence.text !== "");
	if (sentences.length === 0) return null;
	return (
		<div
			className={`flex flex-col gap-1${className === undefined ? "" : ` ${className}`}`}
			data-platform-notes=""
		>
			{sentences.map(({ feature, text }) => (
				<p
					key={feature}
					className="text-[13px] leading-relaxed text-nova-text-muted"
					data-platform-note={feature}
				>
					{text}
				</p>
			))}
		</div>
	);
}
