import { ImportRequestError } from "./client.mjs";

function fatal(message) {
  return new ImportRequestError(message, { fatal: true, category: "content" });
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
    if (progress.state.genres[name] !== matching.id) {
      progress.state.genres[name] = matching.id;
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
  Object.assign(progress.state.movies[name], changes);
  return progress.save();
}

async function importMovie({ movie, client, progress, genreIds }) {
  const name = movie.name;
  let state = progress.state.movies[name];
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
    progress.state.movies[name] = state;
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
    const uploaded = await client.upload(`/api/admin/media/movies/${encodeURIComponent(state.id)}/poster?version=${state.version}`, movie.poster);
    await saveMovieStep(progress, name, { version: uploaded.version, posterUploaded: true });
  }
  if (movie.video && !state.videoUploaded) {
    const uploaded = await client.upload(`/api/admin/media/movies/${encodeURIComponent(state.id)}/video?version=${state.version}`, movie.video);
    await saveMovieStep(progress, name, { version: uploaded.version, videoUploaded: true });
  }
  await saveMovieStep(progress, name, { completed: true });
  return resumed ? "resumed" : "completed";
}

export async function importContent({ source, client, progress, logger }) {
  const genreIds = await syncGenres({ source, client, progress, logger });
  const conflicts = await loadConflictIndex(client);
  const result = { completed: [], resumed: [], skipped: [], failed: [] };
  for (const movie of source.movies) {
    const identity = { kind: "movie", name: movie.name };
    const existing = progress.state.movies[movie.name];
    if (!existing && conflicts.movie.has(movie.name)) {
      result.skipped.push(identity);
      logger?.warn?.(`SKIP movie ${movie.name}: same-kind target already exists`);
      continue;
    }
    try {
      const outcome = await importMovie({ movie, client, progress, genreIds });
      if (outcome === "already") continue;
      result[outcome].push(identity);
      logger?.info?.(`${outcome === "resumed" ? "RESUMED" : "COMPLETED"} movie ${movie.name}`);
    } catch (error) {
      if (!(error instanceof ImportRequestError) || error.fatal) throw error;
      result.failed.push({ ...identity, error: error.message });
      logger?.error?.(`FAILED movie ${movie.name}: ${error.message}`);
    }
  }
  return result;
}
