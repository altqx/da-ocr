export const ASR_SAMPLE_RATE = 16_000;
export const ASR_CHUNK_SECONDS = 30;

const BOUNDARY_SEARCH_SECONDS = 5;
const ENERGY_WINDOW_SECONDS = 0.12;
const MIN_CHUNK_SECONDS = 0.5;
const RUNAWAY_CHAR_REPEAT_LIMIT = 18;
const RUNAWAY_PATTERN_REPEAT_LIMIT = 8;
const MAX_REPEAT_PATTERN_LENGTH = 32;
const RUNAWAY_CHAR_REPEAT_PATTERN = new RegExp(
	`(.)\\1{${RUNAWAY_CHAR_REPEAT_LIMIT},}`,
	'gu',
);

export type TranscriptionAudioChunk = {
	samples: Float32Array;
	startSample: number;
	endSample: number;
	start: number;
	end: number;
};

type AudioChunkOptions = {
	sampleRate?: number;
	maxChunkSeconds?: number;
	searchSeconds?: number;
	energyWindowSeconds?: number;
	minChunkSeconds?: number;
};

export function normalizeAsrSamples(samples: Float32Array) {
	const normalized = new Float32Array(samples.length);
	let peak = 0;

	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index] ?? 0;
		const finiteSample = Number.isFinite(sample) ? sample : 0;
		normalized[index] = finiteSample;
		peak = Math.max(peak, Math.abs(finiteSample));
	}

	if (peak > 1) {
		for (let index = 0; index < normalized.length; index += 1) {
			normalized[index] /= peak;
		}
	}

	for (let index = 0; index < normalized.length; index += 1) {
		normalized[index] = Math.max(-1, Math.min(1, normalized[index] ?? 0));
	}

	return normalized;
}

export function getTranscriptionAudioChunks(
	samples: Float32Array,
	options: AudioChunkOptions = {},
): TranscriptionAudioChunk[] {
	const sampleRate = options.sampleRate ?? ASR_SAMPLE_RATE;
	const maxChunkSamples = secondsToSamples(
		options.maxChunkSeconds ?? ASR_CHUNK_SECONDS,
		sampleRate,
	);
	const searchSamples = secondsToSamples(
		options.searchSeconds ?? BOUNDARY_SEARCH_SECONDS,
		sampleRate,
	);
	const energyWindowSamples = secondsToSamples(
		options.energyWindowSeconds ?? ENERGY_WINDOW_SECONDS,
		sampleRate,
	);
	const minChunkSamples = secondsToSamples(
		options.minChunkSeconds ?? MIN_CHUNK_SECONDS,
		sampleRate,
	);
	const normalizedSamples = normalizeAsrSamples(samples);
	const chunks: TranscriptionAudioChunk[] = [];

	if (!normalizedSamples.length) {
		return [
			makeAudioChunk(normalizedSamples, 0, 0, sampleRate, minChunkSamples),
		];
	}

	let startSample = 0;

	while (startSample < normalizedSamples.length) {
		const remainingSamples = normalizedSamples.length - startSample;

		if (remainingSamples <= maxChunkSamples) {
			chunks.push(
				makeAudioChunk(
					normalizedSamples,
					startSample,
					normalizedSamples.length,
					sampleRate,
					minChunkSamples,
				),
			);
			break;
		}

		const targetEndSample = startSample + maxChunkSamples;
		const boundarySample = findLowestEnergyBoundary(
			normalizedSamples,
			targetEndSample,
			searchSamples,
			energyWindowSamples,
			startSample + minChunkSamples,
			normalizedSamples.length - 1,
		);

		chunks.push(
			makeAudioChunk(
				normalizedSamples,
				startSample,
				boundarySample,
				sampleRate,
				minChunkSamples,
			),
		);
		startSample = boundarySample;
	}

	return chunks;
}

export function cleanAsrTranscript(text: string) {
	return collapseRunawayPatternRepeats(
		text.replace(RUNAWAY_CHAR_REPEAT_PATTERN, '$1'),
	)
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

function secondsToSamples(seconds: number, sampleRate: number) {
	return Math.max(1, Math.round(seconds * sampleRate));
}

function makeAudioChunk(
	samples: Float32Array,
	startSample: number,
	endSample: number,
	sampleRate: number,
	minChunkSamples: number,
): TranscriptionAudioChunk {
	const sourceLength = Math.max(0, endSample - startSample);
	const chunkSamples =
		sourceLength >= minChunkSamples
			? samples.slice(startSample, endSample)
			: new Float32Array(minChunkSamples);

	if (sourceLength > 0 && sourceLength < minChunkSamples) {
		chunkSamples.set(samples.slice(startSample, endSample));
	}

	const start = startSample / sampleRate;
	const end = Math.max(start + 0.1, endSample / sampleRate);

	return {
		samples: chunkSamples,
		startSample,
		endSample,
		start,
		end,
	};
}

function findLowestEnergyBoundary(
	samples: Float32Array,
	targetSample: number,
	searchSamples: number,
	energyWindowSamples: number,
	minBoundarySample: number,
	maxBoundarySample: number,
) {
	const searchStart = clamp(
		targetSample - searchSamples,
		minBoundarySample,
		maxBoundarySample,
	);
	const searchEnd = clamp(
		targetSample + searchSamples,
		minBoundarySample,
		maxBoundarySample,
	);

	if (searchEnd <= searchStart) {
		return clamp(targetSample, minBoundarySample, maxBoundarySample);
	}

	const radius = Math.max(1, Math.floor(energyWindowSamples / 2));
	let windowStart = Math.max(0, searchStart - radius);
	let windowEnd = Math.min(samples.length, searchStart + radius);
	let energy = getAbsoluteEnergy(samples, windowStart, windowEnd);
	let bestScore = getAverageEnergyScore(energy, windowStart, windowEnd);
	let bestSample = searchStart;

	for (
		let sampleIndex = searchStart + 1;
		sampleIndex <= searchEnd;
		sampleIndex += 1
	) {
		const nextWindowStart = Math.max(0, sampleIndex - radius);
		const nextWindowEnd = Math.min(samples.length, sampleIndex + radius);

		while (windowStart < nextWindowStart) {
			energy -= Math.abs(samples[windowStart] ?? 0);
			windowStart += 1;
		}

		while (windowEnd < nextWindowEnd) {
			energy += Math.abs(samples[windowEnd] ?? 0);
			windowEnd += 1;
		}

		const score = getAverageEnergyScore(energy, windowStart, windowEnd);

		if (
			score < bestScore ||
			(score === bestScore &&
				Math.abs(sampleIndex - targetSample) <
					Math.abs(bestSample - targetSample))
		) {
			bestScore = score;
			bestSample = sampleIndex;
		}
	}

	return findQuietestSample(
		samples,
		Math.max(searchStart, bestSample - radius),
		Math.min(searchEnd, bestSample + radius),
		targetSample,
	);
}

function getAbsoluteEnergy(
	samples: Float32Array,
	startSample: number,
	endSample: number,
) {
	let energy = 0;

	for (
		let sampleIndex = startSample;
		sampleIndex < endSample;
		sampleIndex += 1
	) {
		energy += Math.abs(samples[sampleIndex] ?? 0);
	}

	return energy;
}

function getAverageEnergyScore(
	energy: number,
	startSample: number,
	endSample: number,
) {
	return energy / Math.max(1, endSample - startSample);
}

function findQuietestSample(
	samples: Float32Array,
	startSample: number,
	endSample: number,
	targetSample: number,
) {
	let bestSample = startSample;
	let bestMagnitude = Math.abs(samples[startSample] ?? 0);

	for (
		let sampleIndex = startSample + 1;
		sampleIndex <= endSample;
		sampleIndex += 1
	) {
		const magnitude = Math.abs(samples[sampleIndex] ?? 0);

		if (
			magnitude < bestMagnitude ||
			(magnitude === bestMagnitude &&
				Math.abs(sampleIndex - targetSample) <
					Math.abs(bestSample - targetSample))
		) {
			bestMagnitude = magnitude;
			bestSample = sampleIndex;
		}
	}

	return bestSample;
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

function collapseRunawayPatternRepeats(text: string) {
	let output = text;

	for (
		let patternLength = 2;
		patternLength <= MAX_REPEAT_PATTERN_LENGTH;
		patternLength += 1
	) {
		output = collapsePatternRepeats(output, patternLength);
	}

	return output;
}

function collapsePatternRepeats(text: string, patternLength: number) {
	let result = '';
	let index = 0;

	while (index < text.length) {
		const pattern = text.slice(index, index + patternLength);

		if (pattern.length < patternLength || !pattern.trim()) {
			result += text[index] ?? '';
			index += 1;
			continue;
		}

		let repeats = 1;

		while (
			text.slice(
				index + repeats * patternLength,
				index + (repeats + 1) * patternLength,
			) === pattern
		) {
			repeats += 1;
		}

		if (repeats >= RUNAWAY_PATTERN_REPEAT_LIMIT) {
			result += pattern;
			index += repeats * patternLength;
			continue;
		}

		result += text[index] ?? '';
		index += 1;
	}

	return result;
}
