import type { ProgressCallback } from '@huggingface/transformers';
import type { AudioTranscriptionResult } from './audio-utils';
import { QWEN_ASR_MODEL_ID, TRANSFORMERS_CACHE_KEY } from './constants';

const TRANSCRIPTION_OPTIONS = {
	return_timestamps: true,
	chunk_length_s: 30,
	stride_length_s: 5,
} as const;

type CacheSummary = {
	allCached: boolean;
	filesCached: number;
	filesTotal: number;
};

type QwenAsrPipeline = (
	audioUrl: string,
	options: typeof TRANSCRIPTION_OPTIONS,
) => Promise<AudioTranscriptionResult | AudioTranscriptionResult[]>;

let pipelinePromise: Promise<QwenAsrPipeline> | null = null;

async function createQwenAsrPipeline(
	progressCallback?: ProgressCallback,
): Promise<QwenAsrPipeline> {
	const { LogLevel, env, pipeline } = await import('@huggingface/transformers');

	env.allowLocalModels = false;
	env.allowRemoteModels = true;
	env.useBrowserCache = true;
	env.logLevel = LogLevel.WARNING;

	return pipeline('automatic-speech-recognition', QWEN_ASR_MODEL_ID, {
		device: 'webgpu',
		dtype: 'fp16',
		progress_callback: progressCallback,
	}) as Promise<QwenAsrPipeline>;
}

export async function loadQwenAsrPipeline(progressCallback?: ProgressCallback) {
	if (!pipelinePromise) {
		pipelinePromise = createQwenAsrPipeline(progressCallback).catch((cause) => {
			pipelinePromise = null;
			throw cause;
		});
	}

	return pipelinePromise;
}

export function resetQwenAsrPipeline() {
	pipelinePromise = null;
}

export async function transcribeWithQwenAsr(
	audioUrl: string,
	progressCallback?: ProgressCallback,
): Promise<AudioTranscriptionResult> {
	const transcriber = await loadQwenAsrPipeline(progressCallback);
	const result = await transcriber(audioUrl, TRANSCRIPTION_OPTIONS);

	return Array.isArray(result) ? (result[0] ?? { text: '' }) : result;
}

export async function getQwenAsrCacheSummary(): Promise<CacheSummary> {
	try {
		const { ModelRegistry } = await import('@huggingface/transformers');
		const result = await ModelRegistry.is_pipeline_cached_files(
			'automatic-speech-recognition',
			QWEN_ASR_MODEL_ID,
			{
				device: 'webgpu',
				dtype: 'fp16',
			},
		);

		return {
			allCached: result.allCached,
			filesCached: result.files.filter((file) => file.cached).length,
			filesTotal: result.files.length,
		};
	} catch {
		return {
			allCached: false,
			filesCached: 0,
			filesTotal: 0,
		};
	}
}

async function clearBrowserCacheEntriesForModel(modelId: string) {
	if (typeof caches === 'undefined') {
		return 0;
	}

	const cache = await caches.open(TRANSFORMERS_CACHE_KEY);
	const requests = await cache.keys();
	const modelPath = modelId;
	const encodedModelPath = encodeURIComponent(modelId);
	let deleted = 0;

	for (const request of requests) {
		if (
			request.url.includes(modelPath) ||
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
	let filesDeleted = 0;
	let filesCached = 0;

	try {
		const { ModelRegistry } = await import('@huggingface/transformers');
		const result = await ModelRegistry.clear_pipeline_cache(
			'automatic-speech-recognition',
			QWEN_ASR_MODEL_ID,
			{
				device: 'webgpu',
				dtype: 'fp16',
			},
		);

		filesDeleted += result.filesDeleted;
		filesCached += result.filesCached;
	} catch {
		// The official Qwen checkpoint is not yet a native Transformers.js ASR
		// architecture, so fall through to direct Cache API cleanup.
	}

	filesDeleted += await clearBrowserCacheEntriesForModel(QWEN_ASR_MODEL_ID);

	return {
		filesDeleted,
		filesCached: Math.max(filesCached, filesDeleted),
	};
}
