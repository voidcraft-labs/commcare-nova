/**
 * Shared icon data and categorisation for question types — used by AppTree,
 * QuestionTypePickerPopup, and ContextualEditorFooter.
 * Raw icon data objects (not JSX) so consumers can render at any size.
 */

import type { IconifyIcon } from "@iconify/react/offline";
import tabler123 from "@iconify-icons/tabler/123";
import tablerBarcode from "@iconify-icons/tabler/barcode";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerCircleDot from "@iconify-icons/tabler/circle-dot";
import tablerClock from "@iconify-icons/tabler/clock";
import tablerDecimal from "@iconify-icons/tabler/decimal";
import tablerDeviceTv from "@iconify-icons/tabler/device-tv";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import tablerFile from "@iconify-icons/tabler/file";
import tablerFilePencil from "@iconify-icons/tabler/file-pencil";
import tablerFilePlus from "@iconify-icons/tabler/file-plus";
import tablerFolder from "@iconify-icons/tabler/folder";
import tablerForms from "@iconify-icons/tabler/forms";
import tablerLock from "@iconify-icons/tabler/lock";
import tablerMapPin from "@iconify-icons/tabler/map-pin";
import tablerMicrophone from "@iconify-icons/tabler/microphone";
import tablerPhoto from "@iconify-icons/tabler/photo";
import tablerRepeat from "@iconify-icons/tabler/repeat";
import tablerSignature from "@iconify-icons/tabler/signature";
import tablerSquareCheck from "@iconify-icons/tabler/square-check";
import tablerTag from "@iconify-icons/tabler/tag";
import type { Question } from "@/lib/schemas/blueprint";

export const questionTypeIcons: Record<string, IconifyIcon> = {
	text: tablerForms,
	int: tabler123,
	decimal: tablerDecimal,
	date: tablerCalendar,
	single_select: tablerCircleDot,
	multi_select: tablerSquareCheck,
	group: tablerFolder,
	repeat: tablerRepeat,
	hidden: tablerEyeOff,
	geopoint: tablerMapPin,
	image: tablerPhoto,
	barcode: tablerBarcode,
	label: tablerTag,
	time: tablerClock,
	datetime: tablerClock,
	audio: tablerMicrophone,
	video: tablerDeviceTv,
	signature: tablerSignature,
	secret: tablerLock,
};

export const questionTypeLabels: Record<string, string> = {
	text: "Text",
	int: "Number",
	decimal: "Decimal",
	date: "Date",
	single_select: "Single Select",
	multi_select: "Multi Select",
	group: "Group",
	repeat: "Repeat",
	geopoint: "Location",
	image: "Image",
	barcode: "Barcode",
	label: "Label",
	time: "Time",
	datetime: "Date/Time",
	hidden: "Hidden",
	audio: "Audio",
	video: "Video",
	signature: "Signature",
	secret: "Secret",
};

export const formTypeIcons: Record<string, IconifyIcon> = {
	registration: tablerFilePlus,
	followup: tablerFilePencil,
	survey: tablerFile,
};

/* ── Insertion menu categories ─────────────────────────────────────────────
 * Defines how question types are grouped in the insertion menu.
 * Categories with 2+ types render as submenus; top-level items render as
 * direct Menu.Items (e.g. Hidden — single-purpose types that don't belong
 * in a family). */

type QuestionType = Question["type"];

export interface InsertionCategory {
	/** Human label shown on the submenu trigger. */
	label: string;
	/** Representative icon for the category trigger row. */
	icon: IconifyIcon;
	/** Types surfaced inside the submenu. */
	types: readonly QuestionType[];
}

/** Grouped families — each becomes a submenu in the insertion menu. */
export const INSERTION_CATEGORIES: readonly InsertionCategory[] = [
	{
		label: "Input",
		icon: tablerForms,
		types: ["text", "int", "decimal", "secret"],
	},
	{
		label: "Date & Time",
		icon: tablerCalendar,
		types: ["date", "time", "datetime"],
	},
	{
		label: "Choice",
		icon: tablerCircleDot,
		types: ["single_select", "multi_select"],
	},
	{
		label: "Media",
		icon: tablerPhoto,
		types: ["image", "audio", "video", "barcode", "signature"],
	},
	{ label: "Structure", icon: tablerFolder, types: ["group", "repeat"] },
];

/** Standalone types rendered as level-1 items (no submenu needed). */
export const INSERTION_TOP_LEVEL: readonly QuestionType[] = [
	"geopoint",
	"label",
	"hidden",
];
