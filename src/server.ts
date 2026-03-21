import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { paraglideMiddleware } from './paraglide/server';

export default createServerEntry({
	async fetch(request) {
		return paraglideMiddleware(request, () => handler.fetch(request));
	},
});
