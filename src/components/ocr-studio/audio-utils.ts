import type { AudioAsset, AudioTimelineCue, SubtitleCue } from './types';
import { isVideoFile, sanitizeSubtitleText } from './video-utils';

const TRANSCRIPTION_SAMPLE_RATE = 16_000;

type TimestampChunk = {
	text: string;
	timestamp?: [number | null, number | null];
};

export type AudioTranscriptionResult = {
	text: string;
	chunks?: TimestampChunk[];
};

export function isAudioFile(file: File) {
	return (
		file.type.startsWith('audio/') ||
		/\.(aac|aif|aiff|flac|m4a|mp3|ogg|opus|wav|weba)$/i.test(file.name)
	);
}

export function isAudioSourceFile(file: File) {
	return isAudioFile(file) || isVideoFile(file);
}

async function waitForAudioEvent(audio: HTMLAudioElement, eventName: string) {
	await new Promise<void>((resolve, reject) => {
		const handleEvent = () => {
			cleanup();
			resolve();
		};
		const handleError = () => {
			cleanup();
			reject(new Error('Failed to decode the audio file.'));
		};
		const cleanup = () => {
			audio.removeEventListener(eventName, handleEvent);
			audio.removeEventListener('error', handleError);
		};

		audio.addEventListener(eventName, handleEvent, { once: true });
		audio.addEventListener('error', handleError, { once: true });
	});
}

export async function readAudioAsset(file: File) {
	const url = URL.createObjectURL(file);

	try {
		const audio = document.createElement('audio');
		audio.preload = 'metadata';
		audio.src = url;

		await waitForAudioEvent(audio, 'loadedmetadata');
		const asset = {
			name: file.name,
			size: file.size,
			type: file.type || 'audio',
			url,
			duration: Number.isFinite(audio.duration) ? audio.duration : 0,
			sourceKind: 'audio',
			originalName: file.name,
			originalSize: file.size,
			originalType: file.type || 'audio',
		} satisfies AudioAsset;

		audio.removeAttribute('src');
		audio.load();
		return asset;
	} catch (cause) {
		URL.revokeObjectURL(url);
		throw cause;
	}
}

function writeAscii(view: DataView, offset: number, value: string) {
	for (let index = 0; index < value.length; index += 1) {
		view.setUint8(offset + index, value.charCodeAt(index));
	}
}

function audioBufferToWavBlob(audioBuffer: AudioBuffer) {
	const samples = audioBuffer.getChannelData(0);
	const bytesPerSample = 2;
	const wavHeaderBytes = 44;
	const dataBytes = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(wavHeaderBytes + dataBytes);
	const view = new DataView(buffer);

	writeAscii(view, 0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(view, 8, 'WAVE');
	writeAscii(view, 12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, audioBuffer.sampleRate, true);
	view.setUint32(28, audioBuffer.sampleRate * bytesPerSample, true);
	view.setUint16(32, bytesPerSample, true);
	view.setUint16(34, 8 * bytesPerSample, true);
	writeAscii(view, 36, 'data');
	view.setUint32(40, dataBytes, true);

	let offset = wavHeaderBytes;

	for (const sample of samples) {
		const clampedSample = Math.max(-1, Math.min(1, sample));
		view.setInt16(
			offset,
			clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7fff,
			true,
		);
		offset += bytesPerSample;
	}

	return new Blob([buffer], { type: 'audio/wav' });
}

async function decodeMediaFile(file: File) {
	const AudioContextConstructor =
		window.AudioContext ??
		(window as typeof window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;

	if (!AudioContextConstructor) {
		throw new Error('Audio decoding is not available in this browser.');
	}

	const context = new AudioContextConstructor();

	try {
		return await context.decodeAudioData(await file.arrayBuffer());
	} finally {
		await context.close().catch(() => undefined);
	}
}

async function resampleToMono(audioBuffer: AudioBuffer) {
	const frameCount = Math.max(
		1,
		Math.ceil(audioBuffer.duration * TRANSCRIPTION_SAMPLE_RATE),
	);
	const offlineContext = new OfflineAudioContext(
		1,
		frameCount,
		TRANSCRIPTION_SAMPLE_RATE,
	);
	const source = offlineContext.createBufferSource();
	source.buffer = audioBuffer;
	source.connect(offlineContext.destination);
	source.start();

	return offlineContext.startRendering();
}

export async function extractAudioAssetFromVideo(file: File) {
	const decodedAudio = await decodeMediaFile(file);
	const monoAudio = await resampleToMono(decodedAudio);
	const audioBlob = audioBufferToWavBlob(monoAudio);
	const url = URL.createObjectURL(audioBlob);

	return {
		name: file.name,
		size: audioBlob.size,
		type: audioBlob.type,
		url,
		duration: monoAudio.duration,
		sourceKind: 'video',
		originalName: file.name,
		originalSize: file.size,
		originalType: file.type || 'video',
	} satisfies AudioAsset;
}

export async function readAudioSourceAsset(file: File) {
	if (isAudioFile(file)) {
		return readAudioAsset(file);
	}

	if (isVideoFile(file)) {
		return extractAudioAssetFromVideo(file);
	}

	throw new Error('Only audio or video files can be processed.');
}

export function getAudioTimelineCues(
	result: AudioTranscriptionResult,
	duration: number,
): AudioTimelineCue[] {
	const chunks = result.chunks ?? [];
	const cues = chunks
		.map((chunk, index) => {
			const start = Math.max(0, chunk.timestamp?.[0] ?? 0);
			const fallbackEnd =
				chunks[index + 1]?.timestamp?.[0] ??
				(Number.isFinite(duration) && duration > 0 ? duration : start + 0.1);
			const end = Math.max(start + 0.1, chunk.timestamp?.[1] ?? fallbackEnd);
			const text = sanitizeSubtitleText(chunk.text);

			return text
				? {
						id: `audio-cue-${index}-${start.toFixed(2)}`,
						start,
						end,
						text,
					}
				: null;
		})
		.filter((cue): cue is AudioTimelineCue => Boolean(cue));

	if (cues.length) {
		return cues;
	}

	const text = sanitizeSubtitleText(result.text);

	if (!text) {
		return [];
	}

	return [
		{
			id: 'audio-cue-full',
			start: 0,
			end: Number.isFinite(duration) && duration > 0 ? duration : 0.1,
			text,
		},
	];
}

export function getAudioWordCount(cues: SubtitleCue[]) {
	return cues.reduce((count, cue) => {
		const text = cue.text.trim();
		return count + (text ? text.split(/\s+/).length : 0);
	}, 0);
}
