import { ImportRequestError } from "./client.mjs";

function fatal(message) {
  return new ImportRequestError(message, { fatal: true, category: "content" });
}

function ownEntry(record, name) {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

function setOwnEntry(record, name, value) {
  Object.defineProperty(record, name, { value, writable: true, enumerable: true, configurable: true });
}

function collectGenreNames(source) {
  const names = new Set();
  for (const content of [...source.movies, ...source.series]) {
    for (const name of content.genres) {
      if (name.trim() === "") throw fatal("blank genre name in source");
      names.add(name);
    }
  }
  return names;
}

export async function syncGenres({ source, client, progress, logger }) {
  const requiredNames = collectGenreNames(source);
  const genreIds = new Map();
  let available = await client.json("GET", "/api/admin/genres");
  for (const name of requiredNames) {
    let matching = available.find((genre) => genre.name === name);
    if (matching && !matching.enabled) throw fatal(`genre is disabled: ${name}`);
    if (!matching) {
      try {
        matching = await client.json("POST", "/api/admin/genres", { name });
        available = [...available, matching];
        logger?.info?.(`CREATED genre ${name}`);
      } catch (error) {
        if (!(error instanceof ImportRequestError) || error.status !== 409) throw error;
        available = await client.json("GET", "/api/admin/genres");
        matching = available.find((genre) => genre.name === name);
        if (!matching || !matching.enabled) throw fatal(`genre creation conflict has no enabled exact match: ${name}`);
      }
    }
    if (!matching.enabled) throw fatal(`genre is disabled: ${name}`);
    genreIds.set(name, matching.id);
    if (ownEntry(progress.state.genres, name) !== matching.id) {
      setOwnEntry(progress.state.genres, name, matching.id);
      await progress.save();
    }
  }
  return genreIds;
}

export async function loadConflictIndex(client) {
  const conflicts = { movie: new Set(), series: new Set() };
  for (const kind of ["movie", "series"]) {
    let page = 1;
    let seen = 0;
    let total;
    do {
      const response = await client.json("GET", `/api/admin/contents?kind=${kind}&page=${page}`);
      if (!Array.isArray(response?.items) || !Number.isSafeInteger(response.total) || response.total < 0 ||
          (response.items.length === 0 && seen < response.total)) {
        throw fatal(`invalid ${kind} content page`);
      }
      for (const item of response.items) conflicts[kind].add(item.name);
      seen += response.items.length;
      total = response.total;
      page += 1;
    } while (seen < total);
  }
  return conflicts;
}

function saveMovieStep(progress, name, changes) {
  Object.assign(ownEntry(progress.state.movies, name), changes);
  return progress.save();
}

async function importMovie({ movie, client, progress, genreIds, logger }) {
  const name = movie.name;
  let state = ownEntry(progress.state.movies, name);
  const resumed = !!state;
  if (state) {
    let target;
    try {
      target = await client.json("GET", `/api/admin/movies/${encodeURIComponent(state.id)}`);
    } catch (error) {
      if (error instanceof ImportRequestError && error.status === 404) {
        throw new ImportRequestError(`resume target is missing: ${name}`, { status: 404 });
      }
      throw error;
    }
    if (target.status !== "draft" || target.version !== state.version || target.name !== name) {
      throw new ImportRequestError(`resume target changed: ${name}`, { status: 409 });
    }
    if (state.completed) return "already";
  } else {
    const created = await client.json("POST", "/api/admin/movies", { name });
    state = { id: created.id, version: created.version };
    setOwnEntry(progress.state.movies, name, state);
    await progress.save();
  }

  if (!state.metadataUpdated) {
    const updated = await client.json("PATCH", `/api/admin/movies/${encodeURIComponent(state.id)}`, {
      version: state.version,
      name,
      synopsis: movie.synopsis,
      year: movie.year,
      duration_seconds: movie.durationSeconds,
      genre_ids: movie.genres.map((genre) => genreIds.get(genre)),
    });
    await saveMovieStep(progress, name, { version: updated.version, metadataUpdated: true });
  }
  if (movie.poster && !state.posterUploaded) {
    logger?.info?.(`UPLOAD movie ${name} poster`);
    const uploaded = await client.upload(`/api/admin/media/movies/${encodeURIComponent(state.id)}/poster?version=${state.version}`, movie.poster);
    await saveMovieStep(progress, name, { version: uploaded.version, posterUploaded: true });
  }
  if (movie.video && !state.videoUploaded) {
    logger?.info?.(`UPLOAD movie ${name} video`);
    const uploaded = await client.upload(`/api/admin/media/movies/${encodeURIComponent(state.id)}/video?version=${state.version}`, movie.video);
    await saveMovieStep(progress, name, { version: uploaded.version, videoUploaded: true });
  }
  await saveMovieStep(progress, name, { completed: true });
  return resumed ? "resumed" : "completed";
}

function saveSeriesStep(progress, name, changes) {
  Object.assign(ownEntry(progress.state.series, name), changes);
  return progress.save();
}

function saveEpisodeStep(progress, seriesName, seasonNumber, episodeNumber, seriesVersion, changes) {
  const state = ownEntry(progress.state.series, seriesName);
  const season = ownEntry(state.seasons, String(seasonNumber));
  Object.assign(ownEntry(season.episodes, String(episodeNumber)), changes);
  state.version = seriesVersion;
  return progress.save();
}

function validateSeriesResume(target, state, name) {
  if (target.id !== state.id || target.status !== "draft" || target.version !== state.version || target.name !== name) {
    throw new ImportRequestError(`resume target changed: ${name}`, { status: 409 });
  }
  for (const [seasonNumber, savedSeason] of Object.entries(state.seasons ?? {})) {
    const targetSeason = target.seasons?.find((season) => season.number === Number(seasonNumber));
    if (!targetSeason || targetSeason.id !== savedSeason.id) {
      throw new ImportRequestError(`resume season changed: ${name} season ${seasonNumber}`, { status: 409 });
    }
    for (const [episodeNumber, savedEpisode] of Object.entries(savedSeason.episodes ?? {})) {
      const targetEpisode = targetSeason.episodes?.find((episode) => episode.number === Number(episodeNumber));
      if (!targetEpisode || targetEpisode.id !== savedEpisode.id || targetEpisode.season_id !== savedSeason.id ||
          targetEpisode.status !== "draft" || targetEpisode.version !== savedEpisode.version) {
        throw new ImportRequestError(`resume episode changed: ${name} ${seasonNumber}x${episodeNumber}`, { status: 409 });
      }
    }
  }
}

async function importSeries({ series, client, progress, genreIds, logger }) {
  const name = series.name;
  let state = ownEntry(progress.state.series, name);
  const resumed = !!state;
  if (state) {
    let target;
    try {
      target = await client.json("GET", `/api/admin/series/${encodeURIComponent(state.id)}`);
    } catch (error) {
      if (error instanceof ImportRequestError && error.status === 404) {
        throw new ImportRequestError(`resume target is missing: ${name}`, { status: 404 });
      }
      throw error;
    }
    validateSeriesResume(target, state, name);
    if (state.completed) return "already";
  } else {
    const created = await client.json("POST", "/api/admin/series", { name });
    state = { id: created.id, version: created.version };
    setOwnEntry(progress.state.series, name, state);
    await progress.save();
  }

  const seriesPath = `/api/admin/series/${encodeURIComponent(state.id)}`;
  if (!state.metadataUpdated) {
    const updated = await client.json("PATCH", seriesPath, {
      version: state.version,
      name,
      synopsis: series.synopsis,
      year: series.year,
      genre_ids: series.genres.map((genre) => genreIds.get(genre)),
    });
    await saveSeriesStep(progress, name, { version: updated.version, metadataUpdated: true });
  }
  if (series.poster && !state.posterUploaded) {
    logger?.info?.(`UPLOAD series ${name} poster`);
    const uploaded = await client.upload(`/api/admin/media/series/${encodeURIComponent(state.id)}/poster?version=${state.version}`, series.poster);
    await saveSeriesStep(progress, name, { version: uploaded.version, posterUploaded: true });
  }

  const episodes = [...series.episodes].sort((left, right) =>
    left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber);
  for (const episode of episodes) {
    const seasonKey = String(episode.seasonNumber);
    let savedSeason = ownEntry(state.seasons ?? {}, seasonKey);
    if (!savedSeason) {
      const updated = await client.json("POST", `${seriesPath}/seasons`, { version: state.version, number: episode.seasonNumber });
      const createdSeason = updated.seasons?.find((season) => season.number === episode.seasonNumber);
      if (!createdSeason) throw fatal(`created season missing from response: ${name} season ${seasonKey}`);
      state.seasons ??= {};
      savedSeason = { id: createdSeason.id, episodes: {} };
      setOwnEntry(state.seasons, seasonKey, savedSeason);
      await saveSeriesStep(progress, name, { version: updated.version });
    }
    const episodeKey = String(episode.episodeNumber);
    let savedEpisode = ownEntry(savedSeason.episodes ?? {}, episodeKey);
    if (!savedEpisode) {
      const updated = await client.json("POST", `${seriesPath}/seasons/${encodeURIComponent(savedSeason.id)}/episodes`, {
        version: state.version, number: episode.episodeNumber, name: episode.name,
      });
      const createdEpisode = updated.seasons?.find((season) => season.id === savedSeason.id)?.episodes
        ?.find((item) => item.number === episode.episodeNumber);
      if (!createdEpisode) throw fatal(`created episode missing from response: ${name} ${seasonKey}x${episodeKey}`);
      savedSeason.episodes ??= {};
      savedEpisode = { id: createdEpisode.id, version: createdEpisode.version };
      setOwnEntry(savedSeason.episodes, episodeKey, savedEpisode);
      await saveSeriesStep(progress, name, { version: updated.version });
    }
    if (!savedEpisode.metadataUpdated) {
      const updated = await client.json("PATCH", `${seriesPath}/seasons/${encodeURIComponent(savedSeason.id)}/episodes/${encodeURIComponent(savedEpisode.id)}`, {
        version: savedEpisode.version, duration_seconds: episode.durationSeconds,
      });
      await saveEpisodeStep(progress, name, seasonKey, episodeKey, updated.series_version,
        { version: updated.episode.version, metadataUpdated: true });
    }
    if (episode.video && !savedEpisode.videoUploaded) {
      logger?.info?.(`UPLOAD episode ${name} ${seasonKey}x${episodeKey} video`);
      const uploaded = await client.upload(`/api/admin/media/episodes/${encodeURIComponent(savedEpisode.id)}/video?version=${savedEpisode.version}`, episode.video);
      await saveEpisodeStep(progress, name, seasonKey, episodeKey, uploaded.series_version,
        { version: uploaded.version, videoUploaded: true });
    }
    if (!savedEpisode.completed) {
      await saveEpisodeStep(progress, name, seasonKey, episodeKey, state.version, { completed: true });
    }
  }
  await saveSeriesStep(progress, name, { completed: true });
  return resumed ? "resumed" : "completed";
}

export async function importContent({ source, client, progress, logger }) {
  const genreIds = await syncGenres({ source, client, progress, logger });
  const conflicts = await loadConflictIndex(client);
  const result = { completed: [], resumed: [], skipped: [], failed: [] };
  for (const movie of source.movies) {
    const identity = { kind: "movie", name: movie.name };
    const existing = ownEntry(progress.state.movies, movie.name);
    if (!existing && conflicts.movie.has(movie.name)) {
      result.skipped.push(identity);
      logger?.warn?.(`SKIP movie ${movie.name}: same-kind target already exists`);
      continue;
    }
    try {
      logger?.info?.(`IMPORT movie ${movie.name}`);
      const outcome = await importMovie({ movie, client, progress, genreIds, logger });
      if (outcome === "already") continue;
      result[outcome].push(identity);
      logger?.info?.(`${outcome === "resumed" ? "RESUMED" : "COMPLETED"} movie ${movie.name}`);
    } catch (error) {
      if (!(error instanceof ImportRequestError) || error.fatal) throw error;
      result.failed.push({ ...identity, error: error.message });
      logger?.error?.(`FAILED movie ${movie.name}: ${error.message}`);
    }
  }
  for (const series of source.series) {
    const identity = { kind: "series", name: series.name };
    const existing = ownEntry(progress.state.series, series.name);
    if (!existing && conflicts.series.has(series.name)) {
      result.skipped.push(identity);
      logger?.warn?.(`SKIP series ${series.name}: same-kind target already exists`);
      continue;
    }
    try {
      logger?.info?.(`IMPORT series ${series.name}`);
      const outcome = await importSeries({ series, client, progress, genreIds, logger });
      if (outcome === "already") continue;
      result[outcome].push(identity);
      logger?.info?.(`${outcome === "resumed" ? "RESUMED" : "COMPLETED"} series ${series.name}`);
    } catch (error) {
      if (!(error instanceof ImportRequestError) || error.fatal) throw error;
      result.failed.push({ ...identity, error: error.message });
      logger?.error?.(`FAILED series ${series.name}: ${error.message}`);
    }
  }
  return result;
}
