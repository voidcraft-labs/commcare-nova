/**
 * Shared icon data for question types — used by AppTree and QuestionTypePicker.
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
import tablerLock from "@iconify-icons/tabler/lock";
import tablerMapPin from "@iconify-icons/tabler/map-pin";
import tablerMicrophone from "@iconify-icons/tabler/microphone";
import tablerPhoto from "@iconify-icons/tabler/photo";
import tablerRepeat from "@iconify-icons/tabler/repeat";
import tablerSquareCheck from "@iconify-icons/tabler/square-check";
import tablerTag from "@iconify-icons/tabler/tag";
import tablerTypography from "@iconify-icons/tabler/typography";

export const questionTypeIcons: Record<string, IconifyIcon> = {
	text: tablerTypography,
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
	secret: "Secret",
};

export const formTypeIcons: Record<string, IconifyIcon> = {
	registration: tablerFilePlus,
	followup: tablerFilePencil,
	survey: tablerFile,
};
