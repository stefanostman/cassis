const { test } = require('node:test');
const assert = require('node:assert/strict');
const { updateUser, deleteUser } = require('../src/roles');

function fakePool(admins) {
  const statements = [];
  const connection = {
    async beginTransaction() {},
    async commit() { statements.push('commit'); },
    async rollback() { statements.push('rollback'); },
    release() {},
    async execute(sql) {
      statements.push(sql);
      if (sql.includes('SELECT e.objectId, e.value')) {
        return [[{ objectId: 'admin-role', value: 'admin' }, { objectId: 'handler-role', value: 'Handläggare' }]];
      }
      if (sql.startsWith('SELECT id, username')) return [[{ id: 'target', username: 'admin' }]];
      if (sql.includes('WHERE userId = ? AND roleId = ?')) return [[{ userId: 'other' }]];
      if (sql.startsWith('SELECT userId FROM cassis_user_roles')) return [admins.map((userId) => ({ userId }))];
      return [[]];
    },
  };
  return { statements, async getConnection() { return connection; } };
}

test('prevents removing the last administrator even when changing roles', async () => {
  const pool = fakePool(['target']);
  await assert.rejects(updateUser(pool, 'target', 'admin', undefined, ['Handläggare'], 'token', 'other'),
    (error) => error.status === 409);
  assert.ok(pool.statements.includes('rollback'));
  assert.equal(pool.statements.some((sql) => sql.startsWith('UPDATE cassis_users')), false);
});

test('prevents deleting the last administrator and deleting oneself', async () => {
  const pool = fakePool(['target']);
  await assert.rejects(deleteUser(pool, 'target', 'other'), (error) => error.status === 409);
  assert.equal(pool.statements.some((sql) => sql.startsWith('DELETE FROM cassis_users')), false);
  await assert.rejects(deleteUser(pool, 'target', 'target'), (error) => error.status === 409);
});
