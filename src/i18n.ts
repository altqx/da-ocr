import * as generatedMessages from './paraglide/messages.js';

export * from './paraglide/messages.js';

export const m = generatedMessages.m as Record<
	string,
	(...args: unknown[]) => string
>;
