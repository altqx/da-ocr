import { describe, expect, it } from 'vitest';
import {
	cleanAsrTranscript,
	getTranscriptionAudioChunks,
	normalizeAsrSamples,
} from './audio-transcription-quality';

function makeSamples(length: number, value: number) {
	const samples = new Float32Array(length);
	samples.fill(value);
	return samples;
}

describe('audio transcription quality helpers', () => {
	it('moves chunk boundaries to nearby quiet audio', () => {
		const sampleRate = 1000;
		const samples = makeSamples(7000, 0.8);

		for (let index = 2700; index < 2850; index += 1) {
			samples[index] = 0;
		}

		const chunks = getTranscriptionAudioChunks(samples, {
			sampleRate,
			maxChunkSeconds: 3,
			searchSeconds: 0.5,
			energyWindowSeconds: 0.1,
		});

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]?.endSample).toBeGreaterThanOrEqual(2700);
		expect(chunks[0]?.endSample).toBeLessThan(2850);
		expect(chunks[1]?.startSample).toBe(chunks[0]?.endSample);
	});

	it('keeps the target boundary when nearby energy is flat', () => {
		const chunks = getTranscriptionAudioChunks(makeSamples(6100, 0.5), {
			sampleRate: 1000,
			maxChunkSeconds: 3,
			searchSeconds: 0.5,
			energyWindowSeconds: 0.1,
		});

		expect(chunks[0]?.endSample).toBe(3000);
		expect(chunks[1]?.startSample).toBe(3000);
	});

	it('pads very short tail chunks without extending their timestamps', () => {
		const chunks = getTranscriptionAudioChunks(makeSamples(3100, 0.5), {
			sampleRate: 1000,
			maxChunkSeconds: 3,
			minChunkSeconds: 0.5,
		});

		expect(chunks).toHaveLength(2);
		expect(chunks[1]?.samples).toHaveLength(500);
		expect(chunks[1]?.startSample).toBe(3000);
		expect(chunks[1]?.endSample).toBe(3100);
		expect(chunks[1]?.end).toBeCloseTo(3.1);
	});

	it('sanitizes non-finite samples and normalizes oversized peaks', () => {
		const normalized = normalizeAsrSamples(
			Float32Array.from([0, 2, -4, Number.NaN, Number.POSITIVE_INFINITY]),
		);

		expect(Array.from(normalized)).toEqual([0, 0.5, -1, 0, 0]);
	});

	it('removes runaway decoder repetitions', () => {
		expect(cleanAsrTranscript(`hello ${'na '.repeat(10)}done`)).toBe(
			'hello na done',
		);
		expect(cleanAsrTranscript(`go${'o'.repeat(25)}`)).toBe('go');
		expect(cleanAsrTranscript('too good')).toBe('too good');
	});
});
