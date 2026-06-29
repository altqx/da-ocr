import { cloudflare } from '@cloudflare/vite-plugin';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const isVitest = process.env.VITEST === 'true';

const config = defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	plugins: [
		devtools(),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/paraglide',
			strategy: ['url', 'baseLocale'],
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
		...(isVitest
			? []
			: [
					cloudflare({
						viteEnvironment: {
							name: 'ssr',
						},
					}),
				]),
	],
});

export default config;
