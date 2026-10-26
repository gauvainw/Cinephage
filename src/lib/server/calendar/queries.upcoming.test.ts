import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb } from '../../../test/db-helper.js';
import { episodes, movies, series } from '#lib/server/db/schema.js';
import type { DiscoverItem, DiscoverResponse } from '#lib/server/tmdb.js';

const testDb = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	}
}));

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getNowPlaying: vi.fn(),
		getUpcoming: vi.fn(),
		getOnTheAir: vi.fn()
	}
}));

import { tmdb } from '#lib/server/tmdb.js';
import { getUpcomingItems } from './queries.js';

function response(results: DiscoverItem[] = []): DiscoverResponse {
	return { results, page: 1, total_pages: 1, total_results: results.length };
}

function movie(
	id: number,
	releaseDate: string,
	overrides: Partial<DiscoverItem> = {}
): DiscoverItem {
	return {
		id,
		title: `Movie ${id}`,
		release_date: releaseDate,
		poster_path: null,
		backdrop_path: null,
		overview: '',
		genre_ids: [],
		vote_average: 7,
		vote_count: 10,
		popularity: 1,
		original_language: 'en',
		...overrides
	};
}

function addSeries(monitored = true) {
	testDb.db
		.insert(series)
		.values({ id: 'series-1', tmdbId: 2001, title: 'Series', path: 'Series', monitored })
		.run();
}

function addEpisode(number: number, airDate: string, monitored = true) {
	testDb.db
		.insert(episodes)
		.values({
			id: `episode-${number}`,
			seriesId: 'series-1',
			seasonNumber: 1,
			episodeNumber: number,
			airDate,
			monitored
		})
		.run();
}

function addLibraryMovie(id: number) {
	testDb.db
		.insert(movies)
		.values({ id: `movie-${id}`, tmdbId: id, title: `Movie ${id}`, path: `Movie ${id}` })
		.run();
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
	testDb.db.delete(episodes).run();
	testDb.db.delete(series).run();
	testDb.db.delete(movies).run();
	vi.mocked(tmdb.getNowPlaying).mockResolvedValue(response());
	vi.mocked(tmdb.getUpcoming).mockResolvedValue(response());
	vi.mocked(tmdb.getOnTheAir).mockResolvedValue(response());
});

afterEach(() => vi.useRealTimers());
afterAll(() => destroyTestDb(testDb));

describe('getUpcomingItems', () => {
	it('selects the earliest movie even when TMDB returns a later release first', async () => {
		vi.mocked(tmdb.getUpcoming).mockResolvedValue(
			response([movie(1, '2026-11-20'), movie(2, '2026-10-27')])
		);

		const items = await getUpcomingItems(1);

		expect(items.map((item) => item.tmdbId)).toEqual([2]);
	});

	it('merges earlier movies with episodes that already fill the default seven slots', async () => {
		addSeries();
		for (let number = 1; number <= 9; number++) {
			addEpisode(number, `2026-11-${String(number).padStart(2, '0')}`);
		}
		vi.mocked(tmdb.getUpcoming).mockResolvedValue(response([movie(1, '2026-10-27')]));

		const items = await getUpcomingItems();

		expect(items.map((item) => item.date)).toEqual([
			'2026-10-27',
			'2026-11-01',
			'2026-11-02',
			'2026-11-03',
			'2026-11-04',
			'2026-11-05',
			'2026-11-06'
		]);
		expect(items[0]).toMatchObject({ type: 'movie', tmdbId: 1 });
		expect(tmdb.getNowPlaying).toHaveBeenCalledExactlyOnceWith();
		expect(tmdb.getUpcoming).toHaveBeenCalledExactlyOnceWith();
		expect(tmdb.getOnTheAir).toHaveBeenCalledExactlyOnceWith();
	});

	it('includes a show airing today even when movies would fill the result limit', async () => {
		vi.mocked(tmdb.getUpcoming).mockResolvedValue(response([movie(1, '2026-10-27')]));
		vi.mocked(tmdb.getOnTheAir).mockResolvedValue(
			response([movie(2002, '', { title: undefined, name: 'Airing show' })])
		);

		const items = await getUpcomingItems(1);

		expect(items).toEqual([
			expect.objectContaining({ type: 'episode', tmdbId: 2002, date: '2026-10-26' })
		]);
	});

	it('keeps only library movies and monitored episodes when discovery is disabled', async () => {
		addSeries();
		addEpisode(1, '2026-10-28');
		addLibraryMovie(2);
		vi.mocked(tmdb.getUpcoming).mockResolvedValue(
			response([movie(1, '2026-10-26'), movie(2, '2026-10-27')])
		);
		vi.mocked(tmdb.getOnTheAir).mockResolvedValue(response([movie(2002, '')]));

		const items = await getUpcomingItems(7, false);

		expect(items).toEqual([
			expect.objectContaining({ type: 'movie', tmdbId: 2, movieId: 'movie-2' }),
			expect.objectContaining({ type: 'episode', episodeId: 'episode-1' })
		]);
	});

	it('preserves adult filtering for discoveries and the library movie exception', async () => {
		addLibraryMovie(2);
		vi.mocked(tmdb.getUpcoming).mockResolvedValue(
			response([
				movie(1, '2026-10-26', { adult: true }),
				movie(2, '2026-10-27', { adult: true }),
				movie(3, '2026-10-28', { adult: false })
			])
		);
		vi.mocked(tmdb.getOnTheAir).mockResolvedValue(response([movie(2002, '', { adult: true })]));

		const items = await getUpcomingItems(7, true, true);

		expect(items.map((item) => item.tmdbId)).toEqual([2, 3]);
	});

	it('excludes past movies, undated movies and unmonitored episodes', async () => {
		addSeries();
		addEpisode(1, '2026-10-25');
		addEpisode(2, '2026-10-26', false);
		addEpisode(3, '2026-10-28');
		vi.mocked(tmdb.getUpcoming).mockResolvedValue(
			response([movie(1, '2026-10-25'), movie(2, ''), movie(3, '2026-10-27')])
		);

		const items = await getUpcomingItems(7);

		expect(items).toEqual([
			expect.objectContaining({ type: 'movie', tmdbId: 3 }),
			expect.objectContaining({ type: 'episode', episodeId: 'episode-3' })
		]);
	});

	it('does not duplicate movies appearing in both TMDB feeds or discover an existing series', async () => {
		addSeries();
		vi.mocked(tmdb.getNowPlaying).mockResolvedValue(response([movie(1, '2026-10-27')]));
		vi.mocked(tmdb.getUpcoming).mockResolvedValue(response([movie(1, '2026-10-27')]));
		vi.mocked(tmdb.getOnTheAir).mockResolvedValue(response([movie(2001, '')]));

		const items = await getUpcomingItems(7);

		expect(items.map((item) => item.tmdbId)).toEqual([1]);
	});

	it('still returns monitored episodes when TMDB is unavailable', async () => {
		addSeries();
		addEpisode(1, '2026-10-27');
		vi.mocked(tmdb.getUpcoming).mockRejectedValue(new Error('TMDB unavailable'));
		vi.mocked(tmdb.getOnTheAir).mockRejectedValue(new Error('TMDB unavailable'));

		const items = await getUpcomingItems(7);

		expect(items).toEqual([expect.objectContaining({ episodeId: 'episode-1' })]);
	});
});
