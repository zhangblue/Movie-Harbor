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

// 验证目录筛选组合内容类型和不区分大小写的标题查询。
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

// 验证目录选择全部类型时返回各种内容。
test('catalog filtering returns every kind when all is selected', () => {
  assert.equal(typeof catalogModule?.filterCatalog, 'function');

  const items = [
    { title: '星际回声', kind: 'movie' },
    { title: '雾港来信', kind: 'series' },
  ];

  assert.deepEqual(catalogModule.filterCatalog(items, 'all', ''), items);
});

// 验证内容操作受生命周期状态约束。
test('content actions are constrained by lifecycle status', () => {
  assert.equal(typeof catalogModule?.actionsForStatus, 'function');

  assert.deepEqual(catalogModule.actionsForStatus('draft'), ['编辑', '发布', '删除']);
  assert.deepEqual(catalogModule.actionsForStatus('published'), ['查看', '归档']);
  assert.deepEqual(catalogModule.actionsForStatus('archived'), ['查看', '发布', '转草稿', '删除']);
});

// 验证隐私操作文案始终描述下一可见性状态。
test('privacy action always describes the next visibility state', () => {
  assert.equal(typeof catalogModule?.privacyAction, 'function');
  assert.equal(catalogModule.privacyAction(false), '设为私密');
  assert.equal(catalogModule.privacyAction(true), '设为公开');
});

// 验证新剧集草稿包含一个有序号的季和一个具名单集草稿。
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

// 验证用户搜索忽略用户名大小写及首尾空格。
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

// 验证普通用户名按不区分大小写规则保持唯一。
test('new ordinary usernames are unique without regard to case', () => {
  assert.equal(typeof userManagementModule?.validateUsername, 'function');

  const users = [
    { id: 1, username: 'linhai' },
    { id: 2, username: 'Summer' },
  ];

  assert.equal(userManagementModule.validateUsername(users, '  LINHAI  '), '用户名已存在');
});

// 验证用户名校验拒绝空白值。
test('username validation rejects blank values', () => {
  assert.equal(typeof userManagementModule?.validateUsername, 'function');
  assert.equal(userManagementModule.validateUsername([], '   '), '请输入用户名');
});

// 验证管理员用户操作保持用户名不可修改。
test('admin user actions keep usernames immutable', () => {
  assert.equal(typeof userManagementModule?.actionsForUser, 'function');
  assert.deepEqual(userManagementModule.actionsForUser(), ['修改密码', '删除']);
});
