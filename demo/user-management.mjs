export function filterUsers(users, query = '') {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return users.filter((user) => user.username.toLocaleLowerCase().includes(normalizedQuery));
}

export function validateUsername(users, username) {
  const normalizedUsername = username.trim().toLocaleLowerCase();
  if (!normalizedUsername) return '请输入用户名';

  const duplicate = users.some((user) => (
    user.username.toLocaleLowerCase() === normalizedUsername
  ));
  return duplicate ? '用户名已存在' : '';
}

export function actionsForUser() {
  return ['修改密码', '删除'];
}
