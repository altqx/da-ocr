import '@tanstack/react-start/server-only';
import LensCore, { type Segment as LensSegment } from 'chrome-lens-ocr/src/core.js';
import type { LensDetectedBox, LensOcrResult } from './lens-ocr';

let lensClient: LensCore | null = null;

function getLensClient() {
	if (!lensClient) {
		lensClient = new LensCore();
	}

	return lensClient;
}

function toDetectedBox(text: string, box: {
	pixelCoords: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
}): LensDetectedBox {
	const x0 = Math.max(0, Math.round(box.pixelCoords.x));
	const y0 = Math.max(0, Math.round(box.pixelCoords.y));
	const x1 = Math.max(x0, Math.round(box.pixelCoords.x + box.pixelCoords.width));
	const y1 = Math.max(y0, Math.round(box.pixelCoords.y + box.pixelCoords.height));

	return {
		text,
		bbox: {
			x0,
			y0,
			x1,
			y1,
		},
	};
}

export async function scanImageWithLens(input: {
	bytes: Uint8Array;
	mime: string;
	dimensions: [number, number];
}): Promise<LensOcrResult> {
	const result = await getLensClient().scanByData(
		input.bytes,
		input.mime as never,
		input.dimensions,
	);

	const boxes = result.segments
		.map((segment: LensSegment) => {
			const text = segment.text.trim();

			if (!text) {
				return null;
			}

			return toDetectedBox(text, segment.boundingBox);
		})
		.filter((segment: LensDetectedBox | null): segment is LensDetectedBox =>
			Boolean(segment),
		);

	return {
		text: boxes.map((segment: LensDetectedBox) => segment.text).join('\n').trim(),
		boxes,
		detectedLanguage: result.language || null,
	};
}