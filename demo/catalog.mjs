export function filterCatalog(items, kind = 'all', query = '') {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return items.filter((item) => {
    const matchesKind = kind === 'all' || item.kind === kind;
    const matchesQuery = item.title.toLocaleLowerCase().includes(normalizedQuery);
    return matchesKind && matchesQuery;
  });
}

export function actionsForStatus(status) {
  const actions = {
    draft: ['编辑', '发布', '删除'],
    published: ['查看', '归档'],
    archived: ['查看', '发布', '转草稿', '删除'],
  };

  return actions[status] ? [...actions[status]] : [];
}

export function createSeriesDraft() {
  return {
    kind: 'series',
    status: 'draft',
    seasons: [
      {
        number: 1,
        episodes: [{ number: 1, name: '', duration: '', status: 'draft' }],
      },
    ],
  };
}
