import { createFileRoute } from '@tanstack/react-router';
import { m } from '../i18n';

export const Route = createFileRoute('/about')({
	component: About,
	head: () => ({
		meta: [
			{
				title: m.about_meta_title(),
			},
			{
				name: 'description',
				content: m.about_meta_description(),
			},
		],
	}),
});

function About() {
	return (
		<main className="flex-1 p-6">
			<section className="border-3 border-[var(--border)] p-6">
				<p className="eyebrow mb-2">{m.about_kicker()}</p>
				<h1 className="mb-3 text-2xl font-bold text-[var(--ink)]">
					{m.about_title()}
				</h1>
				<p className="m-0 max-w-3xl text-sm leading-7 text-[var(--ink-soft)]">
					{m.about_body()}
				</p>
			</section>
		</main>
	);
}
