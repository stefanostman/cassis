const { randomUUID } = require('node:crypto');
const { rolePermissions } = require('./roles');

async function insertAudit(connection, objectId, type) {
  await connection.execute(
    'INSERT INTO cassis_objects VALUES (?, ?, UTC_TIMESTAMP(3), ?, UTC_TIMESTAMP(3), ?)',
    [objectId, type, 'system', 'system'],
  );
}

async function seedValueLists(connection) {
  for (const name of ['classification', 'extraClass', 'recordType', 'documentType', 'userRole']) {
    const [existing] = await connection.execute('SELECT objectId FROM cassis_valuelists WHERE BINARY listName = BINARY ?', [name]);
    let listId;
    if (existing.length) {
      listId = existing[0].objectId;
    } else {
      listId = randomUUID();
      await insertAudit(connection, listId, 'cassis_valuelist');
      await connection.execute('INSERT INTO cassis_valuelists (objectId, listName, listDescription) VALUES (?, ?, ?)',
        [listId, name, name === 'userRole' ? 'Användarroller' : '']);
    }
    if (name === 'userRole') {
      for (const value of Object.keys(rolePermissions)) {
        const [values] = await connection.execute(
          'SELECT objectId FROM cassis_valuelistelements WHERE listId = ? AND BINARY value = BINARY ?', [listId, value],
        );
        if (!values.length) {
          const elementId = randomUUID();
          await insertAudit(connection, elementId, 'cassis_valuelistelement');
          await connection.execute('INSERT INTO cassis_valuelistelements (objectId, listId, value) VALUES (?, ?, ?)',
            [elementId, listId, value]);
        }
      }
    }
  }
}

module.exports = { insertAudit, seedValueLists };
