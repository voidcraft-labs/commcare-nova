"use client";

import { useId } from "react";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	ANDROID_APP_NAMES,
	REQUIRED_ANDROID_APPS,
} from "@/lib/domain/requiredAndroidApps";

export function RequiredAndroidAppsSection() {
	const id = useId();
	const { requiredAndroidApps = [] } = useAppSettings();
	const { setAppSettings } = useBlueprintMutations();
	const choices = [
		...requiredAndroidApps,
		...REQUIRED_ANDROID_APPS.filter(
			(app) => !requiredAndroidApps.includes(app),
		),
	];
	return (
		<details className="border-t border-white/[0.06] pt-3">
			<summary className="cursor-pointer text-xs font-medium text-nova-text-secondary">
				Required Android apps
			</summary>
			<p className="my-2 text-xs text-nova-text-muted">
				Which apps do workers need on their phone before they can open this app?
			</p>
			{choices.map((app, index) => {
				const selected = requiredAndroidApps.includes(app);
				const name = ANDROID_APP_NAMES[app];
				return (
					<div key={app} className="flex min-h-8 items-center gap-2">
						<label
							htmlFor={`${id}-${app}`}
							className="flex flex-1 cursor-pointer items-center gap-2 text-xs"
						>
							<Checkbox
								id={`${id}-${app}`}
								checked={selected}
								onCheckedChange={(checked) =>
									setAppSettings({
										requiredAndroidApps: checked
											? [...requiredAndroidApps, app]
											: requiredAndroidApps.filter((other) => other !== app),
									})
								}
							/>
							{name}
						</label>
						{selected && index > 0 && (
							<Button
								variant="ghost"
								aria-label={`Move ${name} up`}
								onClick={() => {
									const reordered = [...requiredAndroidApps];
									reordered.splice(index, 1);
									reordered.splice(index - 1, 0, app);
									setAppSettings({ requiredAndroidApps: reordered });
								}}
							>
								Move up
							</Button>
						)}
					</div>
				);
			})}
		</details>
	);
}
