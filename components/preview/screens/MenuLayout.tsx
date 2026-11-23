"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
} from "react";
import { ProjectMediaAudio } from "@/components/builder/media/ProjectMediaResource";
import {
	type BlueprintDoc,
	type MediaAssetId,
	type MenuScreen,
	menuScreenLayout,
} from "@/lib/domain";
import { previewPlatformRules } from "@/lib/preview/platform";
import { usePreviewPlatform } from "@/lib/session/hooks";

const MenuAudio = createContext<"hidden" | "control" | "hold">("hidden");

/** Keep the same native buttons, names and tab order in either layout. */
export function PreviewMenuChoices({
	doc,
	screen,
	children,
}: {
	readonly doc: BlueprintDoc;
	readonly screen: MenuScreen;
	readonly children: ReactNode;
}) {
	const layout = menuScreenLayout(doc, screen);
	const platform = usePreviewPlatform();
	return (
		<MenuAudio
			value={
				layout === "list"
					? "control"
					: previewPlatformRules(platform).gridMenuAudio === "hold"
						? "hold"
						: "hidden"
			}
		>
			<div
				data-menu-layout={layout}
				className={
					layout === "grid"
						? "grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3 [&_[data-menu-choice]>button]:flex-1 [&_[data-menu-choice]>button]:min-h-24 [&_[data-menu-choice]>button]:flex-col [&_[data-menu-choice]>button]:justify-center [&_[data-menu-choice]>button]:text-center"
						: "grid gap-2"
				}
			>
				{children}
			</div>
		</MenuAudio>
	);
}

/** A spoken label beside its entry. In a list it is a separate control, so
 * playing it never opens the entry. On an Android grid a hold plays it, and
 * releasing then opens the entry as a tap does: `MenuGrid.onItemLongClick`
 * starts its own `MediaPlayer` and returns false, so the grid still delivers
 * the item click when the worker lets go. The label therefore plays from an
 * element outside the screen, which keeps playing once the entry opens. */
export function PreviewMenuChoice({
	audioLabel,
	label,
	children,
}: {
	readonly audioLabel?: MediaAssetId;
	readonly label: string;
	readonly children: ReactNode;
}) {
	const audio = useContext(MenuAudio);
	const choice = useRef<HTMLDivElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const stop = () => {
		clearTimeout(timer.current);
		timer.current = undefined;
	};
	useEffect(() => () => clearTimeout(timer.current), []);
	return (
		<div
			ref={choice}
			data-menu-choice
			className="min-w-0 flex flex-col"
			onPointerDown={(event) => {
				stop();
				if (
					audio !== "hold" ||
					audioLabel === undefined ||
					event.button !== 0 ||
					!(event.target instanceof Element) ||
					!event.target.closest("button")
				)
					return;
				timer.current = setTimeout(() => {
					const player = choice.current?.querySelector("audio");
					const source = player?.currentSrc || player?.src;
					if (!source) return;
					// A browser that wants a gesture on the player itself refuses this play; the release still opens the entry.
					new Audio(source).play().catch(() => undefined);
				}, 500);
			}}
			onPointerUp={stop}
			onPointerCancel={stop}
			onPointerLeave={stop}
		>
			{children}
			{audio !== "hidden" && audioLabel !== undefined && (
				<ProjectMediaAudio
					assetId={audioLabel}
					controls
					preload="none"
					aria-label={label}
					className="w-full max-w-72 h-9"
				/>
			)}
		</div>
	);
}
