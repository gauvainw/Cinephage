// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import NamingSettingsPage from '../../../routes/settings/library/naming/+page.svelte';
import {
	buildConfigFromSetup,
	NAMING_DETAIL_PRESETS,
	NAMING_SERVER_PRESETS,
	NAMING_STYLE_PRESETS
} from '#lib/naming/setup-presets.js';
import { updateNamingConfig } from '#lib/api/settings.js';

vi.mock('$app/navigation', () => ({ refreshAll: vi.fn() }));
vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/settings/library/naming') }
}));
vi.mock('#lib/utils/routing.js', () => ({ resolvePath: (path: string) => path }));
vi.mock('#lib/api/settings.js', () => ({
	getNamingPresets: vi.fn().mockResolvedValue({ presets: [] }),
	getNamingPreset: vi.fn(),
	createNamingPreset: vi.fn(),
	deleteNamingPreset: vi.fn(),
	previewNaming: vi.fn().mockResolvedValue({ previews: {} }),
	validateNamingFormats: vi.fn().mockResolvedValue({ results: {} }),
	updateNamingConfig: vi.fn(async (config, presetSelection) => ({ config, presetSelection })),
	resetNamingConfig: vi.fn()
}));

const initialSetup = { serverId: 'jellyfin', styleId: 'recommended', detailId: 'balanced' };
const formatFields = [
	'movieFolderFormat',
	'movieFileFormat',
	'seriesFolderFormat',
	'seasonFolderFormat',
	'episodeFileFormat',
	'dailyEpisodeFormat',
	'animeEpisodeFormat'
] as const;

function renderPage() {
	const config = buildConfigFromSetup(initialSetup);
	return render(NamingSettingsPage, {
		props: {
			data: {
				config,
				defaults: config,
				presetSelection: {
					selectedServerPresetId: initialSetup.serverId,
					selectedStylePresetId: initialSetup.styleId,
					selectedDetailPresetId: initialSetup.detailId
				},
				setupPresets: {
					servers: NAMING_SERVER_PRESETS,
					styles: NAMING_STYLE_PRESETS,
					details: NAMING_DETAIL_PRESETS
				},
				tokens: {}
			} as ComponentProps<typeof NamingSettingsPage>['data']
		}
	});
}

function select(id: string) {
	return document.getElementById(id) as HTMLSelectElement;
}

function formats() {
	return Object.fromEntries(
		formatFields.map((id) => [
			id,
			(document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value
		])
	);
}

function expectFormats(setup: typeof initialSetup) {
	const expected = buildConfigFromSetup(setup);
	expect(formats()).toEqual(Object.fromEntries(formatFields.map((id) => [id, expected[id]])));
}

const cases = [
	{ label: 'server', id: 'setupServerPreset', key: 'serverId', first: 'plex', next: 'kodi' },
	{ label: 'style', id: 'setupStylePreset', key: 'styleId', first: 'compact', next: 'scene' },
	{ label: 'detail', id: 'setupDetailPreset', key: 'detailId', first: 'minimal', next: 'balanced' }
] as const;

describe('naming setup preset confirmation', () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => cleanup());

	it.each(cases)('applies the requested $label and its formats after Confirm', async (test) => {
		renderPage();
		await fireEvent.change(select(test.id), { target: { value: test.first } });
		expect(select(test.id).value).toBe(test.first);
		expect(screen.queryByRole('dialog')).toBeNull();
		expectFormats({ ...initialSetup, [test.key]: test.first });

		await fireEvent.change(select(test.id), { target: { value: test.next } });
		expect(screen.getByRole('dialog')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(select(test.id).value).toBe(test.next);
		expectFormats({ ...initialSetup, [test.key]: test.next });
		expect(updateNamingConfig).not.toHaveBeenCalled();
	});

	it.each(cases)(
		'preserves the $label draft after Cancel and accepts a later choice',
		async (test) => {
			renderPage();
			await fireEvent.change(select(test.id), { target: { value: test.first } });
			const previousFormats = formats();
			await fireEvent.change(select(test.id), { target: { value: test.next } });
			await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(select(test.id).value).toBe(test.first);
			expect(formats()).toEqual(previousFormats);
			await fireEvent.change(select(test.id), { target: { value: test.next } });
			await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
			expect(select(test.id).value).toBe(test.next);
			expectFormats({ ...initialSetup, [test.key]: test.next });
		}
	);

	it('preserves a manually edited draft on Cancel and applies the requested style on Confirm', async () => {
		renderPage();
		const input = document.getElementById('movieFileFormat') as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: '{Title} - manual draft' } });
		await fireEvent.change(select('setupStylePreset'), { target: { value: 'compact' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(input.value).toBe('{Title} - manual draft');
		expect(select('setupStylePreset').value).toBe('recommended');

		await fireEvent.change(select('setupStylePreset'), { target: { value: 'compact' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		expect(select('setupStylePreset').value).toBe('compact');
		expectFormats({ ...initialSetup, styleId: 'compact' });
	});

	it('keeps confirmed choices across selectors and saves the matching config and selection together', async () => {
		renderPage();
		await fireEvent.change(select('setupStylePreset'), { target: { value: 'compact' } });
		await fireEvent.change(select('setupServerPreset'), { target: { value: 'kodi' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		await fireEvent.change(select('setupDetailPreset'), { target: { value: 'minimal' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		expect(select('setupStylePreset').value).toBe('compact');
		expect(select('setupServerPreset').value).toBe('kodi');
		expect(select('setupDetailPreset').value).toBe('minimal');
		const expected = buildConfigFromSetup({
			serverId: 'kodi',
			styleId: 'compact',
			detailId: 'minimal'
		});
		expect(updateNamingConfig).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
		await waitFor(() =>
			expect(updateNamingConfig).toHaveBeenCalledExactlyOnceWith(expected, {
				selectedServerPresetId: 'kodi',
				selectedStylePresetId: 'compact',
				selectedDetailPresetId: 'minimal',
				selectedCustomPresetId: undefined
			})
		);
	});
});
