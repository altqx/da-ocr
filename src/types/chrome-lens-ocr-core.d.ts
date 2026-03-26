declare module 'chrome-lens-ocr/src/core.js' {
	export class BoundingBox {
		centerPerX: number;
		centerPerY: number;
		perWidth: number;
		perHeight: number;
		pixelCoords: {
			x: number;
			y: number;
			width: number;
			height: number;
		};
	}

	export class Segment {
		text: string;
		boundingBox: BoundingBox;
	}

	export class LensResult {
		language: string;
		segments: Segment[];
	}

	export default class LensCore {
		constructor(config?: Record<string, unknown>, fetch?: typeof globalThis.fetch);
		scanByData(
			uint8Array: Uint8Array,
			mime: string,
			originalDimensions: [number, number],
		): Promise<LensResult>;
	}
}

declare module 'chrome-lens-ocr/src/utils/proto_generated/lens_overlay_server_pb.cjs' {
	const protoModule: {
		default: Record<string, unknown>;
	};

	export default protoModule['default'];
}