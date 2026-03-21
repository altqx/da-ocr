import { createFileRoute } from '@tanstack/react-router';
import OcrStudio from '../components/OcrStudio';
import { m } from '../i18n';

export const Route = createFileRoute('/')({
	component: App,
	head: () => ({
		meta: [
			{
				title: m.home_meta_title(),
			},
			{
				name: 'description',
				content: m.home_meta_description(),
			},
		],
	}),
});

function App() {
	return <OcrStudio />;
}
