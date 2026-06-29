import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import type { AudioTranscriptionResult } from './audio-utils';
import {
	QWEN_ASR_CACHE_KEY,
	QWEN_ASR_MODEL_ID,
	TRANSFORMERS_CACHE_KEY,
} from './constants';

type OrtModule = typeof import('onnxruntime-web/webgpu');
type OrtTensor = import('onnxruntime-web').Tensor;
type OrtSession = import('onnxruntime-web').InferenceSession;
type QwenTokenizer = {
	decode: (tokens: number[]) => string;
};

type CacheSummary = {
	allCached: boolean;
	filesCached: number;
	filesTotal: number;
	bytesCached: number;
	bytesTotal: number;
};

export type QwenAsrProgressInfo =
	| {
			status: 'initiate' | 'download' | 'progress' | 'done';
			file: string;
			progress: number;
	  }
	| {
			status: 'progress_total' | 'transcribe_progress';
			progress: number;
	  }
	| {
			status: 'chunk';
			chunk: number;
			total: number;
	  }
	| {
			status: 'ready';
	  };

export type QwenAsrProgressCallback = (info: QwenAsrProgressInfo) => void;

type ModelFile = {
	name: string;
	size: number;
};

type MelSpectrogram = {
	data: Float32Array;
	frames: number;
};

const SAMPLE_RATE = 16_000;
const CHUNK_SECONDS = 30;
const CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_SECONDS;
const N_FFT = 400;
const HOP_LENGTH = 160;
const N_MELS = 128;
const F_MIN = 0;
const F_MAX = 8000;
const MAX_DECODE_TOKENS = 256;
const VOCAB_SIZE = 151_936;
const HIDDEN_SIZE = 2048;
const EOS_TOKEN_IDS = new Set([151_643, 151_645]);
const AUDIO_PAD_TOKEN_ID = 151_676;
const NEWLINE_TOKEN_ID = 198;

const MODEL_FILES: ModelFile[] = [
	{ name: 'config.json', size: 1_000 },
	{ name: 'tokenizer.json', size: 11_429_377 },
	{ name: 'encoder.int4.onnx', size: 1_270_241_779 },
	{ name: 'decoder_init.int4.onnx', size: 356_165 },
	{ name: 'decoder_step.int4.onnx', size: 355_662 },
	{ name: 'decoder_weights.int4.data', size: 2_226_321_408 },
	{ name: 'embed_tokens.bin', size: 622_329_856 },
];

const TOTAL_MODEL_BYTES = MODEL_FILES.reduce(
	(total, file) => total + file.size,
	0,
);
const FREQ_BINS = N_FFT / 2 + 1;
const WINDOW = makeHannWindow();
const MEL_FILTERBANK = makeMelFilterbank();
const DFT_TABLE = makeDftTable();

let runnerPromise: Promise<QwenAsrRunner> | null = null;
let ortModulePromise: Promise<OrtModule> | null = null;

function getModelFileUrl(fileName: string) {
	return `https://huggingface.co/${QWEN_ASR_MODEL_ID}/resolve/main/${fileName}`;
}

function getModelFileRequest(fileName: string) {
	return new Request(getModelFileUrl(fileName));
}

function emitTotalProgress(
	loadedBytes: number,
	progress?: QwenAsrProgressCallback,
) {
	progress?.({
		status: 'progress_total',
		progress: Math.max(
			0,
			Math.min(100, (loadedBytes / TOTAL_MODEL_BYTES) * 100),
		),
	});
}

async function getQwenCache() {
	if (typeof caches === 'undefined') {
		throw new Error('Browser cache storage is not available.');
	}

	return caches.open(QWEN_ASR_CACHE_KEY);
}

async function readCachedModelData(fileName: string) {
	const cache = await getQwenCache();
	const cachedResponse = await cache.match(getModelFileRequest(fileName));

	return cachedResponse
		? new Uint8Array(await cachedResponse.arrayBuffer())
		: null;
}

function concatenateChunks(chunks: Uint8Array[], byteLength: number) {
	const output = new Uint8Array(byteLength);
	let offset = 0;

	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return output;
}

async function downloadModelData(
	file: ModelFile,
	loadedBeforeFile: number,
	progress?: QwenAsrProgressCallback,
) {
	const cachedData = await readCachedModelData(file.name);

	if (cachedData) {
		progress?.({ status: 'done', file: file.name, progress: 100 });
		emitTotalProgress(loadedBeforeFile + file.size, progress);
		return cachedData;
	}

	progress?.({ status: 'initiate', file: file.name, progress: 0 });
	let response: Response;

	try {
		response = await fetch(getModelFileUrl(file.name));
	} catch (cause) {
		throw new Error(
			`Failed to fetch ${file.name} from Hugging Face. Check the network connection and retry model loading.`,
			{ cause },
		);
	}

	if (!response.ok) {
		throw new Error(`Failed to download ${file.name}: ${response.status}`);
	}

	progress?.({ status: 'download', file: file.name, progress: 0 });
	const contentLength =
		Number(response.headers.get('content-length')) || file.size;
	let modelData: Uint8Array;

	try {
		if (response.body) {
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let loaded = 0;

			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					break;
				}

				if (value) {
					chunks.push(value.slice());
					loaded += value.byteLength;
					const fileProgress = Math.min(100, (loaded / contentLength) * 100);
					progress?.({
						status: 'progress',
						file: file.name,
						progress: fileProgress,
					});
					emitTotalProgress(
						loadedBeforeFile + Math.min(loaded, file.size),
						progress,
					);
				}
			}

			modelData = concatenateChunks(chunks, loaded);
		} else {
			modelData = new Uint8Array(await response.arrayBuffer());
		}
	} catch (cause) {
		throw new Error(
			`Failed while downloading ${file.name} from Hugging Face. The browser reported a network read failure during the download.`,
			{ cause },
		);
	}

	const cache = await getQwenCache();
	await cache.put(
		getModelFileRequest(file.name),
		new Response(modelData.slice(), {
			headers: {
				'content-type':
					response.headers.get('content-type') ?? 'application/octet-stream',
				'x-da-ocr-model-file': file.name,
			},
		}),
	);

	progress?.({ status: 'done', file: file.name, progress: 100 });
	emitTotalProgress(loadedBeforeFile + file.size, progress);
	return modelData;
}

async function getModelData(progress?: QwenAsrProgressCallback) {
	const entries: [string, Uint8Array][] = [];
	let loadedBeforeFile = 0;

	for (const file of MODEL_FILES) {
		const modelData = await downloadModelData(file, loadedBeforeFile, progress);
		entries.push([file.name, modelData]);
		loadedBeforeFile += file.size;
	}

	return Object.fromEntries(entries);
}

async function getOrt() {
	if (!ortModulePromise) {
		ortModulePromise = import('onnxruntime-web/webgpu')
			.then((ort) => {
				ort.env.wasm.proxy = false;
				ort.env.wasm.wasmPaths = {
					wasm: ortWasmUrl,
				};
				ort.env.wasm.numThreads = Math.min(
					4,
					globalThis.crossOriginIsolated
						? Math.max(1, navigator.hardwareConcurrency || 1)
						: 1,
				);
				return ort;
			})
			.catch((cause) => {
				ortModulePromise = null;
				throw new Error(
					'Failed to initialize ONNX Runtime WebGPU. The browser could not load the local ONNX runtime assets.',
					{ cause },
				);
			});
	}

	return ortModulePromise;
}

async function createSessionFromData(
	ort: OrtModule,
	modelData: Uint8Array,
	options?: import('onnxruntime-web').InferenceSession.SessionOptions,
) {
	try {
		return await ort.InferenceSession.create(modelData, options);
	} catch (cause) {
		throw new Error(
			'Failed to create an ONNX Runtime WebGPU inference session. The browser could not initialize the local runtime for this model file.',
			{ cause },
		);
	}
}

async function createQwenAsrRunner(progress?: QwenAsrProgressCallback) {
	const [ort, modelData] = await Promise.all([
		getOrt(),
		getModelData(progress),
	]);
	const tokenizer = createQwenTokenizer(modelData['tokenizer.json']);
	const sessionOptions = {
		executionProviders: ['webgpu', 'wasm'],
		graphOptimizationLevel: 'all',
	} satisfies import('onnxruntime-web').InferenceSession.SessionOptions;
	const decoderSessionOptions = {
		...sessionOptions,
		externalData: [
			{
				path: 'decoder_weights.int4.data',
				data: modelData['decoder_weights.int4.data'],
			},
		],
	} satisfies import('onnxruntime-web').InferenceSession.SessionOptions;

	const encoder = await createSessionFromData(
		ort,
		modelData['encoder.int4.onnx'],
		sessionOptions,
	);
	const decoderInit = await createSessionFromData(
		ort,
		modelData['decoder_init.int4.onnx'],
		decoderSessionOptions,
	);
	const decoderStep = await createSessionFromData(
		ort,
		modelData['decoder_step.int4.onnx'],
		decoderSessionOptions,
	);
	const embedTokenData = modelData['embed_tokens.bin'];
	const embedTokens = new Uint16Array(
		embedTokenData.buffer,
		embedTokenData.byteOffset,
		embedTokenData.byteLength / Uint16Array.BYTES_PER_ELEMENT,
	);

	progress?.({ status: 'ready' });

	return new QwenAsrRunner(
		ort,
		encoder,
		decoderInit,
		decoderStep,
		embedTokens,
		tokenizer,
	);
}

export async function loadQwenAsrPipeline(progress?: QwenAsrProgressCallback) {
	if (!runnerPromise) {
		runnerPromise = createQwenAsrRunner(progress).catch((cause) => {
			runnerPromise = null;
			throw cause;
		});
	}

	return runnerPromise;
}

export function resetQwenAsrPipeline() {
	runnerPromise = null;
}

export async function transcribeWithQwenAsr(
	samples: Float32Array,
	progress?: QwenAsrProgressCallback,
): Promise<AudioTranscriptionResult> {
	const runner = await loadQwenAsrPipeline(progress);

	return runner.transcribe(samples, progress);
}

export async function getQwenAsrCacheSummary(): Promise<CacheSummary> {
	try {
		const cache = await getQwenCache();
		let filesCached = 0;
		let bytesCached = 0;

		for (const file of MODEL_FILES) {
			const cachedResponse = await cache.match(getModelFileRequest(file.name));

			if (cachedResponse) {
				filesCached += 1;
				bytesCached += file.size;
			}
		}

		return {
			allCached: filesCached === MODEL_FILES.length,
			filesCached,
			filesTotal: MODEL_FILES.length,
			bytesCached,
			bytesTotal: TOTAL_MODEL_BYTES,
		};
	} catch {
		return {
			allCached: false,
			filesCached: 0,
			filesTotal: MODEL_FILES.length,
			bytesCached: 0,
			bytesTotal: TOTAL_MODEL_BYTES,
		};
	}
}

async function clearCacheEntries(cacheName: string, modelId: string) {
	if (typeof caches === 'undefined') {
		return 0;
	}

	const cache = await caches.open(cacheName);
	const requests = await cache.keys();
	const encodedModelPath = encodeURIComponent(modelId);
	let deleted = 0;

	for (const request of requests) {
		if (
			request.url.includes(modelId) ||
			request.url.includes(encodedModelPath)
		) {
			const didDelete = await cache.delete(request);

			if (didDelete) {
				deleted += 1;
			}
		}
	}

	return deleted;
}

export async function clearQwenAsrCache() {
	resetQwenAsrPipeline();

	if (typeof caches === 'undefined') {
		return {
			filesDeleted: 0,
			filesCached: 0,
		};
	}

	const cache = await getQwenCache();
	const requests = await cache.keys();
	let filesDeleted = 0;

	for (const request of requests) {
		const didDelete = await cache.delete(request);

		if (didDelete) {
			filesDeleted += 1;
		}
	}

	filesDeleted += await clearCacheEntries(
		TRANSFORMERS_CACHE_KEY,
		QWEN_ASR_MODEL_ID,
	);

	return {
		filesDeleted,
		filesCached: filesDeleted,
	};
}

class QwenAsrRunner {
	constructor(
		private readonly ort: OrtModule,
		private readonly encoder: OrtSession,
		private readonly decoderInit: OrtSession,
		private readonly decoderStep: OrtSession,
		private readonly embedTokens: Uint16Array,
		private readonly tokenizer: QwenTokenizer,
	) {}

	async transcribe(
		samples: Float32Array,
		progress?: QwenAsrProgressCallback,
	): Promise<AudioTranscriptionResult> {
		const totalChunks = Math.max(1, Math.ceil(samples.length / CHUNK_SAMPLES));
		const chunks: NonNullable<AudioTranscriptionResult['chunks']> = [];

		for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
			progress?.({
				status: 'chunk',
				chunk: chunkIndex + 1,
				total: totalChunks,
			});

			const startSample = chunkIndex * CHUNK_SAMPLES;
			const endSample = Math.min(samples.length, startSample + CHUNK_SAMPLES);
			const chunkSamples = samples.slice(startSample, endSample);
			const text = await this.transcribeChunk(chunkSamples);
			const start = startSample / SAMPLE_RATE;
			const end = Math.max(start + 0.1, endSample / SAMPLE_RATE);

			if (text.trim()) {
				chunks.push({
					text,
					timestamp: [start, end],
				});
			}

			progress?.({
				status: 'transcribe_progress',
				progress: ((chunkIndex + 1) / totalChunks) * 100,
			});
		}

		return {
			text: chunks
				.map((chunk) => chunk.text)
				.join('\n')
				.trim(),
			chunks,
		};
	}

	private async transcribeChunk(samples: Float32Array) {
		const mel = computeLogMelSpectrogram(samples);
		const melTensor = new this.ort.Tensor('float32', mel.data, [
			1,
			N_MELS,
			mel.frames,
		]);
		const encoderOutput = await this.encoder.run({ mel: melTensor }, [
			'audio_features',
		]);
		const audioFeatures = encoderOutput.audio_features as OrtTensor;
		const audioTokenCount = audioFeatures.dims[1] ?? 0;

		if (!audioTokenCount) {
			return '';
		}

		const promptIds = buildPromptIds(audioTokenCount);
		const outputTokens = await this.greedyDecode(audioFeatures, promptIds);
		const text = this.tokenizer.decode(outputTokens);

		disposeTensor(audioFeatures);
		disposeTensor(melTensor);
		return text.trim();
	}

	private async greedyDecode(audioFeatures: OrtTensor, promptIds: number[]) {
		const positionIds = makeInt64Tensor(
			this.ort,
			promptIds.map((_, index) => index),
			[1, promptIds.length],
		);
		const inputIds = makeInt64Tensor(this.ort, promptIds, [
			1,
			promptIds.length,
		]);
		const audioOffset = makeInt64Tensor(
			this.ort,
			[getAudioPadStart(promptIds)],
			[1],
		);
		const initOutput = await this.decoderInit.run(
			{
				input_ids: inputIds,
				position_ids: positionIds,
				audio_features: audioFeatures,
				audio_offset: audioOffset,
			},
			['logits', 'present_keys', 'present_values'],
		);
		let presentKeys = initOutput.present_keys as OrtTensor;
		let presentValues = initOutput.present_values as OrtTensor;
		let nextToken = await getNextToken(initOutput.logits as OrtTensor);
		const outputTokens = [nextToken];

		disposeTensor(initOutput.logits as OrtTensor);
		disposeTensor(positionIds);
		disposeTensor(inputIds);
		disposeTensor(audioOffset);

		if (EOS_TOKEN_IDS.has(nextToken)) {
			disposeTensor(presentKeys);
			disposeTensor(presentValues);
			return outputTokens;
		}

		let position = promptIds.length;

		for (let step = 1; step < MAX_DECODE_TOKENS; step += 1) {
			const inputEmbeds = new this.ort.Tensor(
				'float32',
				this.getEmbedding(nextToken),
				[1, 1, HIDDEN_SIZE],
			);
			const stepPositionIds = makeInt64Tensor(this.ort, [position], [1, 1]);
			const stepOutput = await this.decoderStep.run(
				{
					input_embeds: inputEmbeds,
					position_ids: stepPositionIds,
					past_keys: presentKeys,
					past_values: presentValues,
				},
				['logits', 'present_keys', 'present_values'],
			);
			const oldKeys = presentKeys;
			const oldValues = presentValues;

			presentKeys = stepOutput.present_keys as OrtTensor;
			presentValues = stepOutput.present_values as OrtTensor;
			nextToken = await getNextToken(stepOutput.logits as OrtTensor);
			outputTokens.push(nextToken);
			position += 1;

			disposeTensor(stepOutput.logits as OrtTensor);
			disposeTensor(inputEmbeds);
			disposeTensor(stepPositionIds);
			disposeTensor(oldKeys);
			disposeTensor(oldValues);

			if (EOS_TOKEN_IDS.has(nextToken)) {
				break;
			}
		}

		disposeTensor(presentKeys);
		disposeTensor(presentValues);
		return outputTokens;
	}

	private getEmbedding(tokenId: number) {
		const start = tokenId * HIDDEN_SIZE;
		const output = new Float32Array(HIDDEN_SIZE);

		if (tokenId < 0 || tokenId >= VOCAB_SIZE) {
			return output;
		}

		for (let index = 0; index < HIDDEN_SIZE; index += 1) {
			output[index] = float16ToFloat32(this.embedTokens[start + index] ?? 0);
		}

		return output;
	}
}

function makeInt64Tensor(ort: OrtModule, values: number[], dims: number[]) {
	return new ort.Tensor(
		'int64',
		BigInt64Array.from(values, (value) => BigInt(value)),
		dims,
	);
}

async function getTensorData(tensor: OrtTensor) {
	if (typeof tensor.getData === 'function') {
		return tensor.getData(true);
	}

	return tensor.data;
}

async function getNextToken(logits: OrtTensor) {
	const data = (await getTensorData(logits)) as Float32Array;
	const vocabSize = logits.dims.at(-1) ?? VOCAB_SIZE;
	const offset = Math.max(0, data.length - vocabSize);
	let bestToken = 0;
	let bestScore = Number.NEGATIVE_INFINITY;

	for (let index = 0; index < vocabSize; index += 1) {
		const score = data[offset + index] ?? Number.NEGATIVE_INFINITY;

		if (score > bestScore) {
			bestScore = score;
			bestToken = index;
		}
	}

	return bestToken;
}

function disposeTensor(tensor: OrtTensor) {
	if (typeof tensor.dispose === 'function') {
		tensor.dispose();
	}
}

function buildPromptIds(audioTokenCount: number) {
	const ids = [
		151_644,
		9125,
		NEWLINE_TOKEN_ID,
		151_645,
		NEWLINE_TOKEN_ID,
		151_644,
		882,
		NEWLINE_TOKEN_ID,
		151_669,
	];

	ids.push(
		...Array.from({ length: audioTokenCount }, () => AUDIO_PAD_TOKEN_ID),
	);
	ids.push(
		151_670,
		151_645,
		NEWLINE_TOKEN_ID,
		151_644,
		77_091,
		NEWLINE_TOKEN_ID,
	);

	return ids;
}

function getAudioPadStart(promptIds: number[]) {
	const index = promptIds.indexOf(AUDIO_PAD_TOKEN_ID);

	if (index === -1) {
		throw new Error('Qwen ASR prompt is missing audio pad tokens.');
	}

	return index;
}

function createQwenTokenizer(tokenizerData: Uint8Array): QwenTokenizer {
	type TokenizerJson = {
		model?: {
			vocab?: Record<string, number>;
		};
		added_tokens?: Array<{
			id: number;
			content: string;
			special?: boolean;
		}>;
	};

	const tokenizerJson = JSON.parse(
		new TextDecoder().decode(tokenizerData),
	) as TokenizerJson;
	const idToToken: string[] = [];
	const specialTokenIds = new Set<number>();

	for (const [token, id] of Object.entries(tokenizerJson.model?.vocab ?? {})) {
		idToToken[id] = token;
	}

	for (const token of tokenizerJson.added_tokens ?? []) {
		idToToken[token.id] = token.content;

		if (token.special) {
			specialTokenIds.add(token.id);
		}
	}

	return {
		decode(tokens: number[]) {
			const bytes: number[] = [];

			for (const tokenId of tokens) {
				if (specialTokenIds.has(tokenId)) {
					continue;
				}

				const token = idToToken[tokenId];

				if (!token) {
					continue;
				}

				for (const char of token) {
					bytes.push(byteLevelCharToByte(char));
				}
			}

			return new TextDecoder('utf-8', { fatal: false }).decode(
				Uint8Array.from(bytes),
			);
		},
	};
}

function byteLevelCharToByte(char: string) {
	const codePoint = char.codePointAt(0) ?? 0;
	const visibleByteRanges = [
		[33, 126],
		[161, 172],
		[174, 255],
	] as const;

	if (
		visibleByteRanges.some(
			([start, end]) => codePoint >= start && codePoint <= end,
		)
	) {
		return codePoint;
	}

	let unicodeOffset = 256;

	for (let byte = 0; byte < 256; byte += 1) {
		const isVisibleByte = visibleByteRanges.some(
			([start, end]) => byte >= start && byte <= end,
		);

		if (!isVisibleByte) {
			if (codePoint === unicodeOffset) {
				return byte;
			}

			unicodeOffset += 1;
		}
	}

	return 0xef;
}

function computeLogMelSpectrogram(samples: Float32Array): MelSpectrogram {
	const frames = Math.max(1, Math.floor(samples.length / HOP_LENGTH));
	const data = new Float32Array(N_MELS * frames);
	const powerSpectrum = new Float32Array(FREQ_BINS);
	let maxLog = Number.NEGATIVE_INFINITY;

	for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
		fillPowerSpectrum(samples, frameIndex, powerSpectrum);

		for (let melIndex = 0; melIndex < N_MELS; melIndex += 1) {
			const weights = MEL_FILTERBANK[melIndex];
			let energy = 0;

			for (const [binIndex, weight] of weights) {
				energy += powerSpectrum[binIndex] * weight;
			}

			const logEnergy = Math.log10(Math.max(energy, 1e-10));
			data[melIndex * frames + frameIndex] = logEnergy;
			maxLog = Math.max(maxLog, logEnergy);
		}
	}

	const floor = maxLog - 8;

	for (let index = 0; index < data.length; index += 1) {
		data[index] = (Math.max(data[index] ?? floor, floor) + 4) / 4;
	}

	return { data, frames };
}

function fillPowerSpectrum(
	samples: Float32Array,
	frameIndex: number,
	powerSpectrum: Float32Array,
) {
	const frameStart = frameIndex * HOP_LENGTH - N_FFT / 2;

	for (let binIndex = 0; binIndex < FREQ_BINS; binIndex += 1) {
		const tableOffset = binIndex * N_FFT;
		let real = 0;
		let imaginary = 0;

		for (let sampleIndex = 0; sampleIndex < N_FFT; sampleIndex += 1) {
			const sourceIndex = frameStart + sampleIndex;
			const sample =
				sourceIndex >= 0 && sourceIndex < samples.length
					? (samples[sourceIndex] ?? 0)
					: 0;
			const windowedSample = sample * WINDOW[sampleIndex];

			real += windowedSample * DFT_TABLE.cos[tableOffset + sampleIndex];
			imaginary -= windowedSample * DFT_TABLE.sin[tableOffset + sampleIndex];
		}

		powerSpectrum[binIndex] = real * real + imaginary * imaginary;
	}
}

function makeHannWindow() {
	return Float32Array.from({ length: N_FFT }, (_, index) => {
		return 0.5 * (1 - Math.cos((2 * Math.PI * index) / N_FFT));
	});
}

function makeDftTable() {
	const cos = new Float32Array(FREQ_BINS * N_FFT);
	const sin = new Float32Array(FREQ_BINS * N_FFT);

	for (let binIndex = 0; binIndex < FREQ_BINS; binIndex += 1) {
		for (let sampleIndex = 0; sampleIndex < N_FFT; sampleIndex += 1) {
			const angle = (2 * Math.PI * binIndex * sampleIndex) / N_FFT;
			const offset = binIndex * N_FFT + sampleIndex;
			cos[offset] = Math.cos(angle);
			sin[offset] = Math.sin(angle);
		}
	}

	return { cos, sin };
}

function makeMelFilterbank() {
	const melMin = hzToMel(F_MIN);
	const melMax = hzToMel(F_MAX);
	const melPoints = Array.from({ length: N_MELS + 2 }, (_, index) => {
		return melMin + ((melMax - melMin) * index) / (N_MELS + 1);
	});
	const hzPoints = melPoints.map(melToHz);
	const fftFrequencies = Array.from({ length: FREQ_BINS }, (_, index) => {
		return (SAMPLE_RATE / 2) * (index / (FREQ_BINS - 1));
	});
	const weights: [number, number][][] = [];

	for (let melIndex = 0; melIndex < N_MELS; melIndex += 1) {
		const left = hzPoints[melIndex] ?? 0;
		const center = hzPoints[melIndex + 1] ?? 0;
		const right = hzPoints[melIndex + 2] ?? 0;
		const norm = 2 / Math.max(right - left, Number.EPSILON);
		const melWeights: [number, number][] = [];

		for (let binIndex = 0; binIndex < FREQ_BINS; binIndex += 1) {
			const frequency = fftFrequencies[binIndex] ?? 0;
			let weight = 0;

			if (frequency >= left && frequency <= center) {
				weight = (frequency - left) / Math.max(center - left, Number.EPSILON);
			} else if (frequency > center && frequency <= right) {
				weight = (right - frequency) / Math.max(right - center, Number.EPSILON);
			}

			if (weight > 0) {
				melWeights.push([binIndex, weight * norm]);
			}
		}

		weights.push(melWeights);
	}

	return weights;
}

function hzToMel(hz: number) {
	const fSp = 200 / 3;
	const minLogHz = 1000;
	const minLogMel = minLogHz / fSp;
	const logStep = Math.log(6.4) / 27;

	if (hz < minLogHz) {
		return hz / fSp;
	}

	return minLogMel + Math.log(hz / minLogHz) / logStep;
}

function melToHz(mel: number) {
	const fSp = 200 / 3;
	const minLogHz = 1000;
	const minLogMel = minLogHz / fSp;
	const logStep = Math.log(6.4) / 27;

	if (mel < minLogMel) {
		return mel * fSp;
	}

	return minLogHz * Math.exp(logStep * (mel - minLogMel));
}

function float16ToFloat32(value: number) {
	const sign = value & 0x8000 ? -1 : 1;
	const exponent = (value >> 10) & 0x1f;
	const fraction = value & 0x03ff;

	if (exponent === 0) {
		return sign * 2 ** -14 * (fraction / 2 ** 10);
	}

	if (exponent === 0x1f) {
		return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
	}

	return sign * 2 ** (exponent - 15) * (1 + fraction / 2 ** 10);
}
