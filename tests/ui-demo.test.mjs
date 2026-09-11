import test from 'node:test';
import assert from 'node:assert/strict';

let catalogModule;
try {
  catalogModule = await import('../demo/catalog.mjs');
} catch {
  catalogModule = undefined;
}

test('catalog filtering combines content kind and a case-insensitive title query', () => {
  assert.equal(typeof catalogModule?.filterCatalog, 'function');

  const items = [
    { title: '星际回声', kind: 'movie' },
    { title: '雾港来信', kind: 'series' },
    { title: 'Echo Chamber', kind: 'movie' },
  ];

  assert.deepEqual(catalogModule.filterCatalog(items, 'movie', 'ECHO'), [
    { title: 'Echo Chamber', kind: 'movie' },
  ]);
});

test('catalog filtering returns every kind when all is selected', () => {
  assert.equal(typeof catalogModule?.filterCatalog, 'function');

  const items = [
    { title: '星际回声', kind: 'movie' },
    { title: '雾港来信', kind: 'series' },
  ];

  assert.deepEqual(catalogModule.filterCatalog(items, 'all', ''), items);
});

test('content actions are constrained by lifecycle status', () => {
  assert.equal(typeof catalogModule?.actionsForStatus, 'function');

  assert.deepEqual(catalogModule.actionsForStatus('draft'), ['编辑', '发布', '删除']);
  assert.deepEqual(catalogModule.actionsForStatus('published'), ['查看', '归档']);
  assert.deepEqual(catalogModule.actionsForStatus('archived'), ['查看', '发布', '转草稿', '删除']);
});

test('a new series draft starts with one numbered season and one named episode draft', () => {
  assert.equal(typeof catalogModule?.createSeriesDraft, 'function');

  assert.deepEqual(catalogModule.createSeriesDraft(), {
    kind: 'series',
    status: 'draft',
    seasons: [
      {
        number: 1,
        episodes: [{ number: 1, name: '', duration: '', status: 'draft' }],
      },
    ],
  });
});
