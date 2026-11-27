import { selectMovieCertification, selectTvContentRating } from './tmdb.service';

describe('TMDB content-rating selection', () => {
  it('prefers an Indian movie certification over a US certification', () => {
    expect(selectMovieCertification({
      results: [
        { iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] },
        { iso_3166_1: 'IN', release_dates: [{ certification: 'U/A 13+' }] },
      ],
    })).toBe('U/A 13+');
  });

  it('falls back to the US movie certification when India has none', () => {
    expect(selectMovieCertification({
      results: [
        { iso_3166_1: 'IN', release_dates: [{ certification: '' }] },
        { iso_3166_1: 'US', release_dates: [{ certification: 'R' }] },
      ],
    })).toBe('R');
  });

  it('prefers an Indian TV content rating and accepts a missing rating response', () => {
    expect(selectTvContentRating({
      results: [
        { iso_3166_1: 'US', rating: 'TV-14' },
        { iso_3166_1: 'IN', rating: 'U/A 16+' },
      ],
    })).toBe('U/A 16+');
    expect(selectTvContentRating({ results: [{ iso_3166_1: 'IN', rating: ' ' }] })).toBeUndefined();
    expect(selectTvContentRating(undefined)).toBeUndefined();
  });

  it('falls back to the US TV content rating when India has none', () => {
    expect(selectTvContentRating({
      results: [
        { iso_3166_1: 'IN', rating: '' },
        { iso_3166_1: 'US', rating: 'TV-MA' },
      ],
    })).toBe('TV-MA');
  });
});
