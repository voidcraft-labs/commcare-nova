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
					: platform === "android"
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

/** A spoken label is a separate action so playing it never opens the entry. */
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
	const held = useRef(false);
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
				held.current = false;
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
					if (!player) return;
					held.current = true;
					// The native controls stay available when the browser requires a gesture directly on the player.
					player.play().catch(() => player.focus());
				}, 500);
			}}
			onPointerUp={stop}
			onPointerCancel={stop}
			onPointerLeave={stop}
			onClickCapture={(event) => {
				if (!held.current || event.detail === 0) return;
				held.current = false;
				event.preventDefault();
				event.stopPropagation();
			}}
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
