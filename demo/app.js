import { actionsForStatus, createSeriesDraft, filterCatalog } from './catalog.mjs';

const posterRoot = 'http://127.0.0.1:8000/movie_resources/posters/';
const items = [
  { id: 1, title: '沉默的羔羊', kind: 'movie', year: 1991, genres: ['剧情', '惊悚', '犯罪'], status: 'published', poster: `${posterRoot}沉默的羔羊.webp`, summary: '一名年轻探员向一位极具洞察力的囚犯寻求帮助，以追踪另一名危险罪犯。' },
  { id: 2, title: '阿凡达：火与烬', kind: 'movie', year: 2025, genres: ['科幻', '动作', '冒险'], status: 'draft', poster: `${posterRoot}阿凡达-火与烬.webp`, summary: '潘多拉星球上的新部族与新的冲突，让熟悉的世界显露另一面。' },
  { id: 3, title: '碟中谍 7：致命清算', kind: 'movie', year: 2023, genres: ['动作', '惊悚'], status: 'published', poster: `${posterRoot}碟中谍7-致命清算.webp`, summary: '一场围绕失控技术展开的全球追逐，迫使小队重新审视信任与选择。' },
  { id: 4, title: '碟中谍 8：最终清算', kind: 'movie', year: 2025, genres: ['动作', '冒险', '惊悚'], status: 'archived', poster: `${posterRoot}碟中谍8-最终清算.webp`, summary: '未竟的任务抵达终点，每一个决定都要付出代价。' },
  { id: 5, title: '哈利·波特与魔法石', kind: 'movie', year: 2001, genres: ['奇幻', '冒险', '家庭'], status: 'published', poster: `${posterRoot}哈利波特与魔法石.webp`, summary: '一个男孩在十一岁生日时发现自己的魔法身世，并踏入一所非凡的学校。' },
  { id: 6, title: '霍格沃茨纪事', kind: 'series', year: 2026, genres: ['奇幻', '剧情'], status: 'published', poster: `${posterRoot}哈利波特与密室.webp`, summary: '古老学院的新一代学生，在秘密与友谊之间寻找自己的道路。' },
  { id: 7, title: '凤凰社档案', kind: 'series', year: 2024, genres: ['悬疑', '奇幻', '剧情', '冒险'], status: 'draft', poster: `${posterRoot}哈利波特与凤凰社.webp`, summary: '一组尘封档案揭开魔法世界不为人知的往事。' },
  { id: 8, title: '混血王子的笔记', kind: 'series', year: 2022, genres: ['奇幻', '悬疑'], status: 'archived', poster: `${posterRoot}哈利波特与混血王子.webp`, summary: '一本写满批注的旧课本，将现在与过去意外连接。' },
];

const kindNames = { movie: '电影', series: '剧集' };
const statusNames = { draft: '草稿', published: '已发布', archived: '已归档' };
let selectedKind = 'all';
let toastTimer;
const seriesDraft = createSeriesDraft();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escaped(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function genreMarkup(genres) {
  const visible = genres.slice(0, 3);
  if (genres.length > 3) visible[2] = `+${genres.length - 2}`;
  return visible.map((genre) => `<span class="genre">${escaped(genre)}</span>`).join('');
}

function safePoster(url, alt, className = '') {
  return `<img class="${className}" src="${encodeURI(url)}" alt="${escaped(alt)}" loading="lazy" onerror="this.style.display='none'">`;
}

function renderCatalog() {
  const query = $('#public-search').value;
  const visible = filterCatalog(items.filter((item) => item.status === 'published'), selectedKind, query);
  $('#catalog-title').textContent = selectedKind === 'movie' ? '电影' : selectedKind === 'series' ? '剧集' : '全部影片';
  $('#catalog-count').textContent = `${visible.length} 部内容`;
  $('#catalog-empty').hidden = visible.length > 0;
  $('#catalog-grid').innerHTML = visible.map((item) => `
    <button class="media-card" type="button" data-item-id="${item.id}" aria-label="查看${escaped(item.title)}详情">
      <div class="poster-frame">${safePoster(item.poster, `${item.title}海报`)}</div>
      <div class="card-copy">
        <h2 class="card-title">${escaped(item.title)}</h2>
        <p class="card-meta">${kindNames[item.kind]} · ${item.year}</p>
        <div class="genre-list">${genreMarkup(item.genres)}</div>
      </div>
    </button>`).join('');
}

function renderAdminRows() {
  const kind = $('#admin-kind').value;
  const status = $('#admin-status').value;
  const query = $('#admin-query').value.trim().toLocaleLowerCase();
  const visible = items.filter((item) => (kind === 'all' || item.kind === kind) && (status === 'all' || item.status === status) && item.title.toLocaleLowerCase().includes(query));

  $('#admin-rows').innerHTML = visible.map((item) => `
    <div class="content-table table-row" role="row">
      ${safePoster(item.poster, `${item.title}海报`, 'table-poster')}
      <span class="table-title">${escaped(item.title)}</span>
      <span>${kindNames[item.kind]}</span>
      <span class="status ${item.status}">${statusNames[item.status]}</span>
      <div class="row-actions">${actionsForStatus(item.status).map((action) => `<button class="action-button ${action === '删除' ? 'danger' : ''}" type="button" data-row-action="${action}" data-item-id="${item.id}">${action}</button>`).join('')}</div>
    </div>`).join('') || '<div class="empty-state">没有匹配的内容</div>';
}

function renderSeriesBuilder() {
  $('#season-builder').innerHTML = seriesDraft.seasons.map((season, seasonIndex) => `
    <article class="season-card" data-season-index="${seasonIndex}">
      <div class="season-header">
        <span class="season-name">第 ${season.number} 季</span>
        <label><span>季序号</span><input class="season-number" type="number" min="1" value="${season.number}" /></label>
        <button class="action-button danger remove-season" type="button">删除本季</button>
      </div>
      <div class="episodes">
        ${season.episodes.map((episode, episodeIndex) => `
          <div class="episode-row" data-episode-index="${episodeIndex}">
            <label class="episode-field"><span>集序号</span><input class="episode-number" type="number" min="1" value="${episode.number}" /></label>
            <label class="episode-field"><span>单集名称</span><input class="episode-name" required placeholder="请输入名称" value="${escaped(episode.name)}" /></label>
            <label class="episode-field"><span>时长（分）</span><input class="episode-duration" type="number" min="1" placeholder="45" value="${escaped(episode.duration)}" /></label>
            <label class="episode-field"><span>视频</span><button class="episode-upload" type="button">选择视频文件</button></label>
            <button class="icon-button remove-episode" type="button" aria-label="删除这一集">×</button>
          </div>`).join('')}
      </div>
      <button class="button secondary add-episode" type="button">＋ 添加一集</button>
    </article>`).join('');
}

function showToast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('is-visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('is-visible'), 2300);
}

function setView(view, updateUrl = true) {
  const normalized = ['admin', 'series-editor'].includes(view) ? view : 'home';
  $('#public-view').hidden = normalized !== 'home';
  $('#admin-view').hidden = normalized !== 'admin';
  $('#series-editor-view').hidden = normalized !== 'series-editor';
  $$('[data-demo-view]').forEach((link) => link.classList.toggle('is-active', link.dataset.demoView === normalized));
  if (updateUrl) history.pushState({ view: normalized }, '', `?view=${normalized}`);
  if (normalized === 'home') renderCatalog();
  if (normalized === 'admin') renderAdminRows();
  if (normalized === 'series-editor') renderSeriesBuilder();
}

function openDetails(item) {
  $('#detail-content').innerHTML = `
    <div class="detail-layout">
      ${safePoster(item.poster, `${item.title}海报`)}
      <div class="detail-copy">
        <p class="eyebrow">${item.kind === 'movie' ? 'MOVIE' : 'SERIES'}</p>
        <h2>${escaped(item.title)}</h2>
        <p class="card-meta">${kindNames[item.kind]} · ${item.year}</p>
        <div class="genre-list">${genreMarkup(item.genres)}</div>
        <p>${escaped(item.summary)}</p>
        <button class="play-button" type="button" data-toast="播放页将在正式版连接视频资源">▶ 播放</button>
      </div>
    </div>`;
  $('#detail-dialog').showModal();
}

function showEditor(item) {
  $('#content-panel').hidden = true;
  $('#placeholder-panel').hidden = true;
  $('#editor-panel').hidden = false;
  $('#editor-title').textContent = item ? `编辑草稿 · ${item.title}` : '新建电影草稿';
  const preview = $('#poster-preview');
  if (item) {
    preview.src = encodeURI(item.poster);
    preview.style.display = 'block';
    $('.poster-placeholder').hidden = true;
  } else {
    preview.removeAttribute('src');
    preview.style.display = 'none';
    $('.poster-placeholder').hidden = false;
  }
}

$$('[data-demo-view]').forEach((link) => link.addEventListener('click', (event) => {
  event.preventDefault();
  setView(link.dataset.demoView);
}));

$$('[data-kind]').forEach((button) => button.addEventListener('click', () => {
  selectedKind = button.dataset.kind;
  $$('[data-kind]').forEach((candidate) => candidate.classList.toggle('is-active', candidate === button));
  renderCatalog();
}));

$('#public-search').addEventListener('input', renderCatalog);
$('#catalog-grid').addEventListener('click', (event) => {
  const card = event.target.closest('[data-item-id]');
  if (card) openDetails(items.find((item) => item.id === Number(card.dataset.itemId)));
});
$('.dialog-close').addEventListener('click', () => $('#detail-dialog').close());
$('#detail-dialog').addEventListener('click', (event) => {
  if (event.target === $('#detail-dialog')) $('#detail-dialog').close();
});

$('#account-button').addEventListener('click', () => {
  const menu = $('#account-menu');
  menu.hidden = !menu.hidden;
  $('#account-button').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.account-wrap')) {
    $('#account-menu').hidden = true;
    $('#account-button').setAttribute('aria-expanded', 'false');
  }
});

$('#admin-search-button').addEventListener('click', renderAdminRows);
$('#admin-query').addEventListener('keydown', (event) => { if (event.key === 'Enter') renderAdminRows(); });
$('#admin-rows').addEventListener('click', (event) => {
  const action = event.target.closest('[data-row-action]');
  if (!action) return;
  const item = items.find((candidate) => candidate.id === Number(action.dataset.itemId));
  if (action.dataset.rowAction === '编辑') showEditor(item);
  else showToast(`${item.title}：${action.dataset.rowAction}（Demo）`);
});
$('#create-content').addEventListener('click', () => showEditor());
$('#back-to-list').addEventListener('click', () => {
  $('#editor-panel').hidden = true;
  $('#content-panel').hidden = false;
});

$$('[data-admin-section]').forEach((button) => button.addEventListener('click', () => {
  $$('[data-admin-section]').forEach((candidate) => candidate.classList.toggle('is-active', candidate === button));
  $('#editor-panel').hidden = true;
  if (button.dataset.adminSection === 'content') {
    $('#content-panel').hidden = false;
    $('#placeholder-panel').hidden = true;
  } else {
    $('#content-panel').hidden = true;
    $('#placeholder-panel').hidden = false;
    $('#placeholder-title').textContent = button.dataset.adminSection === 'genres' ? '题材配置' : '系统设置';
  }
}));

$('#poster-button').addEventListener('click', () => $('#poster-input').click());
$('#poster-input').addEventListener('change', () => {
  const [file] = $('#poster-input').files;
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    $('#poster-preview').src = reader.result;
    $('#poster-preview').style.display = 'block';
    $('.poster-placeholder').hidden = true;
    showToast('海报预览已更新');
  });
  reader.readAsDataURL(file);
});

$('#draft-form').addEventListener('submit', (event) => {
  event.preventDefault();
  showToast('发布校验通过（Demo）');
});

$('#series-poster-button').addEventListener('click', () => $('#series-poster-input').click());
$('#series-poster-input').addEventListener('change', () => {
  const [file] = $('#series-poster-input').files;
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    $('#series-poster-preview').src = reader.result;
    $('#series-poster-preview').style.display = 'block';
    $('.series-poster-placeholder').hidden = true;
    showToast('剧集海报预览已更新');
  });
  reader.readAsDataURL(file);
});

$('#add-season').addEventListener('click', () => {
  const nextNumber = Math.max(...seriesDraft.seasons.map((season) => Number(season.number)), 0) + 1;
  seriesDraft.seasons.push({ number: nextNumber, episodes: [{ number: 1, name: '', duration: '', status: 'draft' }] });
  renderSeriesBuilder();
});

$('#season-builder').addEventListener('click', (event) => {
  const seasonCard = event.target.closest('[data-season-index]');
  if (!seasonCard) return;
  const seasonIndex = Number(seasonCard.dataset.seasonIndex);
  const episodeRow = event.target.closest('[data-episode-index]');

  if (event.target.closest('.add-episode')) {
    const episodes = seriesDraft.seasons[seasonIndex].episodes;
    episodes.push({ number: episodes.length + 1, name: '', duration: '', status: 'draft' });
    renderSeriesBuilder();
  }

  if (event.target.closest('.remove-episode') && episodeRow) {
    const episodes = seriesDraft.seasons[seasonIndex].episodes;
    if (episodes.length === 1) {
      showToast('每一季至少保留一集草稿');
      return;
    }
    episodes.splice(Number(episodeRow.dataset.episodeIndex), 1);
    renderSeriesBuilder();
  }

  if (event.target.closest('.remove-season')) {
    if (seriesDraft.seasons.length === 1) {
      showToast('新剧集至少保留一季');
      return;
    }
    seriesDraft.seasons.splice(seasonIndex, 1);
    renderSeriesBuilder();
  }

  if (event.target.closest('.episode-upload')) showToast('视频文件已选择（Demo）');
});

$('#season-builder').addEventListener('input', (event) => {
  const seasonCard = event.target.closest('[data-season-index]');
  if (!seasonCard) return;
  const seasonIndex = Number(seasonCard.dataset.seasonIndex);
  const episodeRow = event.target.closest('[data-episode-index]');
  const season = seriesDraft.seasons[seasonIndex];

  if (event.target.matches('.season-number')) {
    season.number = Number(event.target.value) || 1;
    seasonCard.querySelector('.season-name').textContent = `第 ${season.number} 季`;
  }
  if (episodeRow) {
    const episode = season.episodes[Number(episodeRow.dataset.episodeIndex)];
    if (event.target.matches('.episode-number')) episode.number = Number(event.target.value) || 1;
    if (event.target.matches('.episode-name')) episode.name = event.target.value;
    if (event.target.matches('.episode-duration')) episode.duration = event.target.value;
  }
});

$('#series-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const hasUnnamedEpisode = seriesDraft.seasons.some((season) => season.episodes.some((episode) => !episode.name.trim()));
  showToast(hasUnnamedEpisode ? '请先填写每一集的名称' : '剧集发布校验通过（Demo）');
});
document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-toast]');
  if (trigger) showToast(trigger.dataset.toast);
});
window.addEventListener('popstate', () => setView(new URLSearchParams(location.search).get('view'), false));

setView(new URLSearchParams(location.search).get('view'), false);
