"use client";

import { useState } from "react";
import { MediaDisplay } from "@/components/builder/media/MediaDisplay";
import type { SelectOption } from "@/lib/domain";
import { focusChosenChoice, retainChoiceFocus } from "./choiceLabelActivation";

type Option = {
	key: string;
	value: string;
	label: string;
	media?: SelectOption["media"];
};

/** Android's GridWidget and GridMultiWidget draw ImageViews. Fixed grids
 * keep each image's width and leave unused columns empty. In automatic
 * grids the largest image decides how many fit. An enormous declared count
 * never needs more real tracks than the number of choices. */
export function AndroidChoiceGrid({
	options,
	columns,
	multiple,
	labelledBy,
	path,
	value,
	editMode,
	onChoose,
	onBlur,
}: {
	options: readonly Option[];
	columns?: number;
	multiple?: boolean;
	labelledBy?: string;
	path: string;
	value: string;
	editMode: boolean;
	onChoose: (choice: string) => void;
	onBlur: () => void;
}) {
	const [imageWidth, setImageWidth] = useState(0);
	const count = Math.min(
		columns ?? (multiple ? 2 : 1),
		Math.max(options.length, 1),
	);
	const width = imageWidth ? `min(${imageWidth}px, 100%)` : "2rem";
	const tracks =
		columns || !imageWidth
			? `repeat(${count}, ${width})`
			: `repeat(auto-fill, ${width})`;
	return (
		<fieldset
			aria-labelledby={labelledBy}
			onBlur={onBlur}
			className="m-0 border-none p-0"
		>
			<div
				className="grid gap-0.5"
				style={{ gridTemplateColumns: tracks }}
				onLoadCapture={(event) => {
					if (event.target instanceof HTMLImageElement) {
						const visible = Array.from(
							event.currentTarget.querySelectorAll("img"),
							(image) => image.naturalWidth,
						);
						setImageWidth(
							visible.reduce(
								(largest, current) => Math.max(largest, current),
								0,
							),
						);
					}
				}}
			>
				{options.map((option) => {
					const checked =
						option.value !== "" &&
						(multiple
							? value.split(" ").includes(option.value)
							: value === option.value);
					return (
						<label
							key={option.key}
							className={`flex min-h-8 cursor-pointer items-center justify-center rounded border focus-within:ring-2 focus-within:ring-pv-accent ${checked ? "border-pv-accent bg-pv-accent/20" : "border-pv-input-border bg-pv-input-bg"}`}
							onMouseDown={editMode ? undefined : retainChoiceFocus}
							onClickCapture={editMode ? undefined : focusChosenChoice}
						>
							<input
								type={multiple ? "checkbox" : "radio"}
								className="sr-only"
								name={path}
								checked={checked}
								value={option.value}
								aria-label={option.label}
								onChange={() => onChoose(option.value)}
							/>
							{option.media?.image && (
								<MediaDisplay
									media={{ image: option.media.image }}
									interactive={!editMode}
									imageClassName="max-w-full object-contain"
								/>
							)}
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}
