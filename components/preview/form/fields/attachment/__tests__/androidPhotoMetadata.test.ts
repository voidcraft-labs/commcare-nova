// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
	originalPhotoMetadata,
	resizedPhotoWithMetadata,
} from "../androidPhotoMetadata";

const cameraTags = {
	IFD0: {
		Orientation: "6",
		ImageDescription: "Visit photo",
		Make: "Example camera",
	},
	IFD2: { DateTimeOriginal: "2024:07:06 05:04:03" },
};

describe.each(["jpeg", "png"] as const)(
	"Android %s photo metadata",
	(format) => {
		it("keeps the raw pixel orientation and sends only the camera tags the device retains", async () => {
			const source = await sharp("proof/core/captures/proof-image.jpg")
				.withExif(cameraTags)
				.withMetadata({ orientation: 6 })
				.toFormat(format)
				.toBuffer();
			const type = `image/${format}`;
			expect((await sharp(source).metadata()).orientation).toBe(6);
			const file = new File([new Uint8Array(source)], `photo.${format}`, {
				type,
			});
			const { pixels, tiff } = await originalPhotoMetadata(file);
			expect(tiff).toBeDefined();
			const sensorImage = sharp(Buffer.from(await pixels.arrayBuffer()));
			expect((await sensorImage.metadata()).orientation).toBeUndefined();
			const encoded = await sensorImage
				.resize(15, 11, { fit: "fill" })
				.toFormat(format)
				.toBuffer();
			const sent = resizedPhotoWithMetadata(
				new Blob([new Uint8Array(encoded)], { type }),
				tiff,
				15,
				11,
			);
			const metadata = await sharp(
				Buffer.from(await sent.arrayBuffer()),
			).metadata();
			expect(metadata).toMatchObject({
				format,
				width: 15,
				height: 11,
				orientation: 6,
			});
			expect(metadata.exif?.includes(Buffer.from("Visit photo"))).toBe(true);
			expect(metadata.exif?.includes(Buffer.from("Example camera"))).toBe(
				false,
			);
			expect(metadata.exif?.includes(Buffer.from("2024:07:06 05:04:03"))).toBe(
				true,
			);
		});
	},
);
