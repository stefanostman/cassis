require('dotenv').config({ quiet: true });

const { randomUUID } = require('node:crypto');
const pool = require('./db');
const { rolePermissions } = require('./roles');
const { insertAudit, seedValueLists } = require('./seed-value-lists');

async function migrate(connection) {
  const [columns] = await connection.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cassis_valuelists'`,
  );
  if (!columns.length) throw new Error('cassis_valuelists is missing; run setup for a new database');
  if (columns.some((row) => row.COLUMN_NAME === 'objectId')) {
    const [missingRoles] = await connection.query(
      'SELECT u.id FROM cassis_users u LEFT JOIN cassis_user_roles ur ON ur.userId = u.id WHERE ur.userId IS NULL LIMIT 1',
    );
    if (missingRoles.length) throw new Error('An existing user has no role; migration stopped');
    await connection.beginTransaction();
    try {
      await seedValueLists(connection);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log('Value lists already use the object-backed schema.');
    return;
  }
  if (!columns.some((row) => row.COLUMN_NAME === 'listName') || !columns.some((row) => row.COLUMN_NAME === 'value')) {
    throw new Error('The existing cassis_valuelists table has an unexpected schema');
  }
  const [users] = await connection.query('SELECT id, username FROM cassis_users');
  if (users.some((user) => user.username !== 'cassis_admin')) {
    throw new Error('Existing users other than cassis_admin require explicit role assignments before migration');
  }
  const [conflicts] = await connection.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME IN ('cassis_valuelists_legacy', 'cassis_valuelists_migrating',
       'cassis_valuelistelements_migrating', 'cassis_user_roles_migrating',
       'cassis_valuelistelements', 'cassis_user_roles')`,
  );
  if (conflicts.length) throw new Error('Migration or backup tables already exist; inspect them before proceeding');

  const createdTables = [];
  let committed = false;
  try {
    await connection.query(`CREATE TABLE cassis_valuelists_migrating (
      objectId CHAR(36) PRIMARY KEY,
      listName VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      listDescription VARCHAR(255) NOT NULL DEFAULT '',
      UNIQUE (listName),
      FOREIGN KEY (objectId) REFERENCES cassis_objects(objectId) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    createdTables.push('cassis_valuelists_migrating');
    await connection.query(`CREATE TABLE cassis_valuelistelements_migrating (
      objectId CHAR(36) PRIMARY KEY,
      listId CHAR(36) NOT NULL,
      value VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      UNIQUE (listId, value),
      CHECK (CHAR_LENGTH(value) > 0),
      FOREIGN KEY (objectId) REFERENCES cassis_objects(objectId) ON DELETE CASCADE,
      FOREIGN KEY (listId) REFERENCES cassis_valuelists_migrating(objectId)
    ) ENGINE=InnoDB`);
    createdTables.push('cassis_valuelistelements_migrating');
    await connection.query(`CREATE TABLE cassis_user_roles_migrating (
      userId CHAR(36) NOT NULL,
      roleId CHAR(36) NOT NULL,
      PRIMARY KEY (userId, roleId),
      FOREIGN KEY (userId) REFERENCES cassis_users(id) ON DELETE CASCADE,
      FOREIGN KEY (roleId) REFERENCES cassis_valuelistelements_migrating(objectId)
    ) ENGINE=InnoDB`);
    createdTables.push('cassis_user_roles_migrating');

    await connection.beginTransaction();
    const [oldValues] = await connection.query('SELECT listName, value FROM cassis_valuelists FOR UPDATE');
    const listNames = new Set(['classification', 'extraClass', 'recordType', 'userRole']);
    for (const row of oldValues) listNames.add(row.listName);
    const listIds = new Map();
    for (const name of listNames) {
      const objectId = randomUUID();
      listIds.set(name, objectId);
      await insertAudit(connection, objectId, 'cassis_valuelist');
      await connection.execute(
        'INSERT INTO cassis_valuelists_migrating (objectId, listName, listDescription) VALUES (?, ?, ?)',
        [objectId, name, name === 'userRole' ? 'Användarroller' : ''],
      );
    }
    const roles = new Map();
    for (const { listName, value } of oldValues) {
      const objectId = randomUUID();
      await insertAudit(connection, objectId, 'cassis_valuelistelement');
      await connection.execute('INSERT INTO cassis_valuelistelements_migrating (objectId, listId, value) VALUES (?, ?, ?)',
        [objectId, listIds.get(listName), value]);
      if (listName === 'userRole') roles.set(value, objectId);
    }
    for (const role of Object.keys(rolePermissions)) {
      if (!roles.has(role)) {
        const objectId = randomUUID();
        await insertAudit(connection, objectId, 'cassis_valuelistelement');
        await connection.execute('INSERT INTO cassis_valuelistelements_migrating (objectId, listId, value) VALUES (?, ?, ?)',
          [objectId, listIds.get('userRole'), role]);
        roles.set(role, objectId);
      }
    }
    for (const user of users) {
      await connection.execute('INSERT INTO cassis_user_roles_migrating (userId, roleId) VALUES (?, ?)',
        [user.id, roles.get('admin')]);
    }
    await connection.commit();
    committed = true;
    await connection.query(`RENAME TABLE
      cassis_valuelists TO cassis_valuelists_legacy,
      cassis_valuelists_migrating TO cassis_valuelists,
      cassis_valuelistelements_migrating TO cassis_valuelistelements,
      cassis_user_roles_migrating TO cassis_user_roles`);
    console.log('Existing value lists migrated; cassis_valuelists_legacy is retained as a backup.');
  } catch (error) {
    if (!committed) {
      await connection.rollback();
      for (const table of createdTables.reverse()) await connection.query(`DROP TABLE \`${table}\``);
    }
    throw error;
  }
}

if (require.main === module) {
  (async () => {
    const connection = await pool.getConnection();
    try {
      await migrate(connection);
    } finally {
      connection.release();
    }
  })().catch((error) => {
    console.error('Value-list migration failed:', error.message);
    process.exitCode = 1;
  }).finally(() => pool.end());
}

module.exports = { migrate };
