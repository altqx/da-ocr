import { createServerFn } from '@tanstack/react-start';

export type LensDetectedBox = {
	text: string;
	bbox: {
		x0: number;
		y0: number;
		x1: number;
		y1: number;
	};
};

export type LensOcrResult = {
	text: string;
	boxes: LensDetectedBox[];
	detectedLanguage: string | null;
};

export const runLensOcr = createServerFn({ method: 'POST' })
	.inputValidator((data: FormData) => {
		if (!(data instanceof FormData)) {
			throw new Error('Expected FormData.');
		}

		return data;
	})
	.handler(async ({ data }) => {
		const image = data.get('image');
		const width = Number(data.get('width'));
		const height = Number(data.get('height'));

		if (!(image instanceof File)) {
			throw new Error('Expected an image file.');
		}

		if (!Number.isFinite(width) || !Number.isFinite(height)) {
			throw new Error('Expected processed image dimensions.');
		}

		const { scanImageWithLens } = await import('./lens-ocr.server');

		return scanImageWithLens({
			bytes: new Uint8Array(await image.arrayBuffer()),
			mime: image.type || 'image/png',
			dimensions: [width, height],
		});
	});