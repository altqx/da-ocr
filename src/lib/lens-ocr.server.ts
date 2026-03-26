import '@tanstack/react-start/server-only';
import type { LensDetectedBox, LensOcrResult } from './lens-ocr';

// From chrome-lens-ocr constants
const LENS_PROTO_ENDPOINT = 'https://lensfrontend-pa.googleapis.com/v1/crupload';
const LENS_API_KEY = 'AIzaSyDr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY';
const DEFAULT_TARGET_LANGUAGE = 'en';
const DEFAULT_REGION = 'US';
const DEFAULT_TIME_ZONE = 'America/New_York';
const DEFAULT_MAJOR_CHROME_VERSION = '124';
const DEFAULT_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${DEFAULT_MAJOR_CHROME_VERSION}.0.0.0 Safari/537.36`;

type ProtoConstructor<T = unknown> = new (...args: never[]) => T;

type ProtoModule = {
	LensOverlayServerRequest: ProtoConstructor<{
		setObjectsRequest(value: unknown): void;
		serializeBinary(): Uint8Array;
	}>;
	LensOverlayObjectsRequest: ProtoConstructor<{
		setRequestContext(value: unknown): void;
		setImageData(value: unknown): void;
	}>;
	LensOverlayRequestContext: ProtoConstructor<{
		setRequestId(value: unknown): void;
		setClientContext(value: unknown): void;
	}>;
	LensOverlayServerResponse: {
		deserializeBinary(bytes: Uint8Array): ProtoServerResponse;
	};
	LensOverlayClientContext: ProtoConstructor<{
		setPlatform(value: unknown): void;
		setSurface(value: unknown): void;
		setLocaleContext(value: unknown): void;
		setClientFilters(value: unknown): void;
	}>;
	LocaleContext: ProtoConstructor<{
		setLanguage(value: string): void;
		setRegion(value: string): void;
		setTimeZone(value: string): void;
	}>;
	ImageData: ProtoConstructor<{
		setPayload(value: unknown): void;
		setImageMetadata(value: unknown): void;
	}>;
	ImagePayload: ProtoConstructor<{
		setImageBytes(value: Uint8Array): void;
	}>;
	ImageMetadata: ProtoConstructor<{
		setWidth(value: number): void;
		setHeight(value: number): void;
	}>;
	LensOverlayRequestId: ProtoConstructor<{
		setUuid(value: string): void;
		setSequenceId(value: number): void;
		setImageSequenceId(value: number): void;
	}>;
	AppliedFilter: ProtoConstructor<{
		setFilterType(value: unknown): void;
	}>;
	AppliedFilters: ProtoConstructor<{
		addFilter(value: unknown): void;
	}>;
	LensOverlayFilterType: {
		AUTO_FILTER: unknown;
	};
	Platform: {
		WEB: unknown;
	};
	Surface: {
		CHROMIUM: unknown;
	};
	CoordinateType: {
		NORMALIZED: unknown;
	};
};

type ProtoBoundingBox = {
	getCoordinateType(): unknown;
	getCenterX(): number;
	getCenterY(): number;
	getWidth(): number;
	getHeight(): number;
};

type ProtoGeometry = {
	hasBoundingBox(): boolean;
	getBoundingBox(): ProtoBoundingBox;
};

type ProtoWord = {
	getPlainText(): string;
	hasTextSeparator(): boolean;
	getTextSeparator(): string;
};

type ProtoLine = {
	getWordsList(): ProtoWord[];
	hasGeometry(): boolean;
	getGeometry(): ProtoGeometry;
};

type ProtoParagraph = {
	getLinesList(): ProtoLine[];
	hasGeometry(): boolean;
	getGeometry(): ProtoGeometry;
	getContentLanguage(): string;
};

type ProtoTextLayout = {
	getParagraphsList(): ProtoParagraph[];
};

type ProtoText = {
	hasTextLayout(): boolean;
	getTextLayout(): ProtoTextLayout;
	getContentLanguage(): string;
};

type ProtoObjectsResponse = {
	hasText(): boolean;
	getText(): ProtoText;
};

type ProtoServerResponse = {
	hasError(): boolean;
	hasObjectsResponse(): boolean;
	getObjectsResponse(): ProtoObjectsResponse;
};

let protoModulePromise: Promise<ProtoModule> | null = null;

async function loadProtoModule(): Promise<ProtoModule> {
	if (!protoModulePromise) {
		(globalThis as Record<string, unknown>).proto ??= { lens: {} };
		protoModulePromise = import('chrome-lens-ocr/src/utils/proto_generated/lens_overlay_server_pb.cjs').then(
			(module) => module.default as ProtoModule,
		);
	}

	return protoModulePromise;
}

function createLensRequest(protoModule: ProtoModule, input: {
	bytes: Uint8Array;
	width: number;
	height: number;
	targetLanguage?: string;
}) {
	const requestId = new protoModule.LensOverlayRequestId();
	requestId.setUuid(`${Date.now()}${Math.floor(Math.random() * 1_000_000)}`);
	requestId.setSequenceId(1);
	requestId.setImageSequenceId(1);

	const localeContext = new protoModule.LocaleContext();
	localeContext.setLanguage(input.targetLanguage ?? DEFAULT_TARGET_LANGUAGE);
	localeContext.setRegion(DEFAULT_REGION);
	localeContext.setTimeZone(DEFAULT_TIME_ZONE);

	const appliedFilter = new protoModule.AppliedFilter();
	appliedFilter.setFilterType(protoModule.LensOverlayFilterType.AUTO_FILTER);

	const clientFilters = new protoModule.AppliedFilters();
	clientFilters.addFilter(appliedFilter);

	const clientContext = new protoModule.LensOverlayClientContext();
	clientContext.setPlatform(protoModule.Platform.WEB);
	clientContext.setSurface(protoModule.Surface.CHROMIUM);
	clientContext.setLocaleContext(localeContext);
	clientContext.setClientFilters(clientFilters);

	const requestContext = new protoModule.LensOverlayRequestContext();
	requestContext.setRequestId(requestId);
	requestContext.setClientContext(clientContext);

	const imageMetadata = new protoModule.ImageMetadata();
	imageMetadata.setWidth(input.width);
	imageMetadata.setHeight(input.height);

	const imagePayload = new protoModule.ImagePayload();
	imagePayload.setImageBytes(input.bytes);

	const imageData = new protoModule.ImageData();
	imageData.setPayload(imagePayload);
	imageData.setImageMetadata(imageMetadata);

	const objectsRequest = new protoModule.LensOverlayObjectsRequest();
	objectsRequest.setRequestContext(requestContext);
	objectsRequest.setImageData(imageData);

	const serverRequest = new protoModule.LensOverlayServerRequest();
	serverRequest.setObjectsRequest(objectsRequest);

	return serverRequest.serializeBinary();
}

async function sendLensRequest(serializedRequest: Uint8Array) {
	const requestBytes = Uint8Array.from(serializedRequest);
	const requestBody = new Blob([requestBytes.buffer], {
		type: 'application/x-protobuf',
	});

	const response = await fetch(LENS_PROTO_ENDPOINT, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-protobuf',
			'X-Goog-Api-Key': LENS_API_KEY,
			Accept: '*/*',
			'Accept-Encoding': 'gzip, deflate, br',
			'Accept-Language': `${DEFAULT_TARGET_LANGUAGE},en;q=0.9`,
			'User-Agent': DEFAULT_USER_AGENT,
		},
		body: requestBody,
		redirect: 'follow',
	});

	if (!response.ok) {
		const errorBody = await response.text().catch(() => 'Could not read error body.');
		throw new Error(`Lens OCR request failed with status ${response.status}: ${errorBody}`);
	}

	return new Uint8Array(await response.arrayBuffer());
}

function createPixelBox(box: [number, number, number, number], imageDimensions: [number, number]) {
	const [centerPerX, centerPerY, perWidth, perHeight] = box;
	const [imageWidth, imageHeight] = imageDimensions;

	const width = perWidth * imageWidth;
	const height = perHeight * imageHeight;
	const x = (centerPerX * imageWidth) - (width / 2);
	const y = (centerPerY * imageHeight) - (height / 2);

	return {
		pixelCoords: {
			x: Math.round(x),
			y: Math.round(y),
			width: Math.round(width),
			height: Math.round(height),
		},
	};
}

function getBoundingBoxFromGeometry(
	geometry: ProtoGeometry | null,
	coordinateType: unknown,
	imageDimensions: [number, number],
) {
	if (!geometry || !geometry.hasBoundingBox()) {
		return null;
	}

	const protoBox = geometry.getBoundingBox();

	if (protoBox.getCoordinateType() !== coordinateType) {
		return null;
	}

	return createPixelBox(
		[
			protoBox.getCenterX(),
			protoBox.getCenterY(),
			protoBox.getWidth(),
			protoBox.getHeight(),
		],
		imageDimensions,
	);
}

function parseLensResponse(
	protoModule: ProtoModule,
	responseBytes: Uint8Array,
	imageDimensions: [number, number],
) {
	const serverResponse = protoModule.LensOverlayServerResponse.deserializeBinary(responseBytes);

	if (serverResponse.hasError() || !serverResponse.hasObjectsResponse()) {
		return {
			language: '',
			segments: [] as Array<{ text: string; boundingBox: ReturnType<typeof createPixelBox> }>,
		};
	}

	const objectsResponse = serverResponse.getObjectsResponse();

	if (!objectsResponse.hasText()) {
		return {
			language: '',
			segments: [] as Array<{ text: string; boundingBox: ReturnType<typeof createPixelBox> }>,
		};
	}

	const text = objectsResponse.getText();

	if (!text.hasTextLayout()) {
		return {
			language: text.getContentLanguage() || '',
			segments: [] as Array<{ text: string; boundingBox: ReturnType<typeof createPixelBox> }>,
		};
	}

	const textLayout = text.getTextLayout();
	const paragraphs = textLayout.getParagraphsList();
	const detectedLanguage = text.getContentLanguage() || paragraphs[0]?.getContentLanguage() || '';
	const segments: Array<{ text: string; boundingBox: ReturnType<typeof createPixelBox> }> = [];

	for (const paragraph of paragraphs) {
		for (const line of paragraph.getLinesList()) {
			const words = line.getWordsList();
			let lineText = '';

			for (const [index, word] of words.entries()) {
				lineText += word.getPlainText();

				if (word.hasTextSeparator()) {
					lineText += word.getTextSeparator();
				} else if (index < words.length - 1) {
					lineText += ' ';
				}
			}

			lineText = lineText.replace(/\s+/g, ' ').trim();

			if (!lineText) {
				continue;
			}

			const boundingBox =
				getBoundingBoxFromGeometry(line.hasGeometry() ? line.getGeometry() : null, protoModule.CoordinateType.NORMALIZED, imageDimensions) ??
				getBoundingBoxFromGeometry(paragraph.hasGeometry() ? paragraph.getGeometry() : null, protoModule.CoordinateType.NORMALIZED, imageDimensions) ??
				createPixelBox([0.5, 0.5, 1, 1], imageDimensions);

			segments.push({ text: lineText, boundingBox });
		}
	}

	return {
		language: detectedLanguage,
		segments,
	};
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
	const protoModule = await loadProtoModule();
	const serializedRequest = createLensRequest(protoModule, {
		bytes: input.bytes,
		width: input.dimensions[0],
		height: input.dimensions[1],
	});
	const responseBytes = await sendLensRequest(serializedRequest);
	const result = parseLensResponse(protoModule, responseBytes, input.dimensions);

	const boxes = result.segments
		.map((segment) => {
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