import test from 'node:test';
import assert from 'node:assert/strict';

let catalogModule;
let userManagementModule;
try {
  catalogModule = await import('../demo/catalog.mjs');
} catch {
  catalogModule = undefined;
}
try {
  userManagementModule = await import('../demo/user-management.mjs');
} catch {
  userManagementModule = undefined;
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

test('privacy action always describes the next visibility state', () => {
  assert.equal(typeof catalogModule?.privacyAction, 'function');
  assert.equal(catalogModule.privacyAction(false), '设为私密');
  assert.equal(catalogModule.privacyAction(true), '设为公开');
});

test('a new series draft starts with one numbered season and one named episode draft', () => {
  assert.equal(typeof catalogModule?.createSeriesDraft, 'function');

  assert.deepEqual(catalogModule.createSeriesDraft(), {
    kind: 'series',
    status: 'draft',
    isPrivate: false,
    seasons: [
      {
        number: 1,
        episodes: [{ number: 1, name: '', duration: '', status: 'draft' }],
      },
    ],
  });
});

test('user search ignores username case and surrounding whitespace', () => {
  assert.equal(typeof userManagementModule?.filterUsers, 'function');

  const users = [
    { id: 1, username: 'linhai' },
    { id: 2, username: 'Summer' },
    { id: 3, username: 'zhouyu' },
  ];

  assert.deepEqual(userManagementModule.filterUsers(users, '  SUM  '), [
    { id: 2, username: 'Summer' },
  ]);
});

test('new ordinary usernames are unique without regard to case', () => {
  assert.equal(typeof userManagementModule?.validateUsername, 'function');

  const users = [
    { id: 1, username: 'linhai' },
    { id: 2, username: 'Summer' },
  ];

  assert.equal(userManagementModule.validateUsername(users, '  LINHAI  '), '用户名已存在');
});

test('username validation rejects blank values', () => {
  assert.equal(typeof userManagementModule?.validateUsername, 'function');
  assert.equal(userManagementModule.validateUsername([], '   '), '请输入用户名');
});

test('admin user actions keep usernames immutable', () => {
  assert.equal(typeof userManagementModule?.actionsForUser, 'function');
  assert.deepEqual(userManagementModule.actionsForUser(), ['修改密码', '删除']);
});
