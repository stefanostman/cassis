const { randomUUID } = require('node:crypto');
const { hashPassword } = require('./password');

const rolePermissions = {
  admin: ['read', 'case:create', 'record:create', 'case:update', 'record:update', 'case:delete', 'record:delete', 'relation:manage', 'user:create', 'value-list:manage'],
  Koordinator: ['read', 'case:create', 'record:create', 'case:update', 'record:update', 'case:delete', 'record:delete'],
  Handläggare: ['read', 'record:create', 'case:update', 'record:update'],
  Beslutsfattare: ['read', 'case:update', 'record:update'],
};

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function validateUsername(username) {
  if (typeof username !== 'string' || !username.trim() || [...username.trim()].length > 50) {
    invalid('Username must be between 1 and 50 characters');
  }
  return username.trim();
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) {
    invalid('Password must be between 8 and 1024 characters');
  }
}

function validateRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0 || roles.some((role) => typeof role !== 'string')
    || new Set(roles).size !== roles.length) {
    invalid('Select at least one role, without duplicates');
  }
  if (roles.some((role) => !Object.hasOwn(rolePermissions, role))) invalid('Unknown or unsupported role');
}

async function lockRoleIds(connection) {
  const [available] = await connection.execute(
    `SELECT e.objectId, e.value FROM cassis_valuelistelements e
     JOIN cassis_valuelists l ON l.objectId = e.listId
     WHERE BINARY l.listName = BINARY ? FOR UPDATE`,
    ['userRole'],
  );
  return new Map(available.map((row) => [row.value, row.objectId]));
}

function requireAvailableRoles(roles, roleIds) {
  if (roles.some((role) => !roleIds.has(role))) invalid('Selected role is not present in the userRole value list');
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  throw error;
}

async function withTransaction(pool, callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function requireUser(connection, userId) {
  const [users] = await connection.execute('SELECT id, username FROM cassis_users WHERE id = ? FOR UPDATE', [userId]);
  if (!users.length) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }
  return users[0];
}

async function protectLastAdmin(connection, userId, adminRoleId) {
  if (!adminRoleId) return;
  const [admins] = await connection.execute(
    'SELECT userId FROM cassis_user_roles WHERE roleId = ? FOR UPDATE', [adminRoleId],
  );
  if (admins.length === 1 && admins[0].userId === userId) conflict('The last administrator must retain the admin role');
}

async function requireCurrentAdmin(connection, actorId, adminRoleId) {
  const [rows] = await connection.execute(
    'SELECT userId FROM cassis_user_roles WHERE userId = ? AND roleId = ? FOR UPDATE', [actorId, adminRoleId || ''],
  );
  if (!rows.length) {
    const error = new Error('Permission denied');
    error.status = 403;
    throw error;
  }
}

async function writeUsername(connection, sql, params) {
  try {
    await connection.execute(sql, params);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      error.status = 409;
      error.message = 'Username already exists';
    }
    throw error;
  }
}

function permissionsFor(roles) {
  return [...new Set(roles.flatMap((role) => Object.hasOwn(rolePermissions, role) ? rolePermissions[role] : []))];
}

async function userRoles(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT e.value FROM cassis_user_roles ur
     JOIN cassis_valuelistelements e ON e.objectId = ur.roleId
     JOIN cassis_valuelists l ON l.objectId = e.listId
     WHERE ur.userId = ? AND BINARY l.listName = BINARY ? ORDER BY e.value`,
    [userId, 'userRole'],
  );
  return rows.map((row) => row.value);
}

async function createUser(pool, username, password, roles, actorId) {
  username = validateUsername(username);
  validatePassword(password);
  validateRoles(roles);
  const passwordHash = await hashPassword(password);
  return withTransaction(pool, async (connection) => {
    const roleIds = await lockRoleIds(connection);
    if (actorId) await requireCurrentAdmin(connection, actorId, roleIds.get('admin'));
    requireAvailableRoles(roles, roleIds);
    const userId = randomUUID();
    await writeUsername(connection, 'INSERT INTO cassis_users (id, username, password_hash) VALUES (?, ?, ?)',
      [userId, username, passwordHash]);
    for (const role of roles) {
      await connection.execute('INSERT INTO cassis_user_roles (userId, roleId) VALUES (?, ?)', [userId, roleIds.get(role)]);
    }
    return { id: userId, username, roles };
  });
}

async function listUsers(connection) {
  const [rows] = await connection.execute(
    `SELECT u.id, u.username, CASE WHEN BINARY l.listName = BINARY ? THEN e.value ELSE NULL END AS role FROM cassis_users u
     LEFT JOIN cassis_user_roles ur ON ur.userId = u.id
     LEFT JOIN cassis_valuelistelements e ON e.objectId = ur.roleId
     LEFT JOIN cassis_valuelists l ON l.objectId = e.listId
     ORDER BY u.username, e.value`, ['userRole'],
  );
  const users = new Map();
  for (const row of rows) {
    if (!users.has(row.id)) users.set(row.id, { id: row.id, username: row.username, roles: [] });
    if (row.role !== null) users.get(row.id).roles.push(row.role);
  }
  return [...users.values()];
}

async function updateUser(pool, userId, username, password, roles, currentTokenHash, actorId) {
  username = validateUsername(username);
  validateRoles(roles);
  if (password !== undefined) validatePassword(password);
  const passwordHash = password === undefined ? null : await hashPassword(password);
  return withTransaction(pool, async (connection) => {
    const roleIds = await lockRoleIds(connection);
    await requireCurrentAdmin(connection, actorId, roleIds.get('admin'));
    requireAvailableRoles(roles, roleIds);
    await requireUser(connection, userId);
    if (!roles.includes('admin')) await protectLastAdmin(connection, userId, roleIds.get('admin'));
    if (passwordHash) {
      await writeUsername(connection, 'UPDATE cassis_users SET username = ?, password_hash = ? WHERE id = ?',
        [username, passwordHash, userId]);
      await connection.execute('DELETE FROM cassis_sessions WHERE user_id = ? AND token_hash <> ?', [userId, currentTokenHash]);
    } else {
      await writeUsername(connection, 'UPDATE cassis_users SET username = ? WHERE id = ?', [username, userId]);
    }
    await connection.execute('DELETE FROM cassis_user_roles WHERE userId = ?', [userId]);
    for (const role of roles) {
      await connection.execute('INSERT INTO cassis_user_roles (userId, roleId) VALUES (?, ?)', [userId, roleIds.get(role)]);
    }
    return { id: userId, username, roles };
  });
}

async function deleteUser(pool, userId, actorId) {
  if (userId.toLowerCase() === actorId.toLowerCase()) conflict('You cannot delete your own account');
  await withTransaction(pool, async (connection) => {
    const roleIds = await lockRoleIds(connection);
    await requireCurrentAdmin(connection, actorId, roleIds.get('admin'));
    await requireUser(connection, userId);
    await protectLastAdmin(connection, userId, roleIds.get('admin'));
    await connection.execute('DELETE FROM cassis_users WHERE id = ?', [userId]);
  });
}

module.exports = { rolePermissions, permissionsFor, userRoles, createUser, listUsers, updateUser, deleteUser };
