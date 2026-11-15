require('dotenv').config({ quiet: true });

const express = require('express');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const pool = require('./db');
const { verifyPassword } = require('./password');
const { PARENT_RELATION_TYPE, createParentRelation } = require('./parent-relations');
const { getValueListBindings, validateValueLists, valueListConstraints, valueListElement, listValueListDefinitions } = require('./value-lists');
const { rolePermissions, permissionsFor, userRoles, createUser, listUsers, updateUser, deleteUser } = require('./roles');

const app = express();
const port = Number(process.env.PORT || 3000);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.use(express.json({ limit: '100kb' }));

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function text(value, name, maxLength) {
  if (typeof value !== 'string' || [...value].length > maxLength) {
    fail(400, `${name} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function id(value, name = 'objectId') {
  if (typeof value !== 'string' || !uuidPattern.test(value)) fail(400, `Invalid ${name}`);
  return value;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function transaction(callback) {
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

async function requireObject(connection, objectId, objectType, lock = false) {
  const [rows] = await connection.execute(
    `SELECT objectId FROM cassis_objects WHERE objectId = ? AND objectType = ?${lock ? ' FOR UPDATE' : ''}`,
    [objectId, objectType],
  );
  if (!rows.length) fail(404, `${objectType} not found`);
}

function caseInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Expected a JSON object');
  if (!Array.isArray(body.extraclass)) {
    fail(400, 'extraclass must be an array of strings');
  }
  return {
    diaryNumber: text(body.diaryNumber, 'diaryNumber', 20),
    classification: text(body.classification, 'classification', 8),
    caseSentence: text(body.caseSentence, 'caseSentence', 100),
    extraclass: body.extraclass.map((value) => text(value, 'extraclass value', 50)),
  };
}

function recordInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Expected a JSON object');
  return {
    caseId: id(body.caseId, 'caseId'),
    name: text(body.name, 'name', 50),
    description: text(body.description, 'description', 100),
    recordType: text(body.recordType, 'recordType', 100),
  };
}

async function insertObject(connection, objectId, objectType, username) {
  await connection.execute(
    'INSERT INTO cassis_objects VALUES (?, ?, UTC_TIMESTAMP(3), ?, UTC_TIMESTAMP(3), ?)',
    [objectId, objectType, username, username],
  );
}

async function updateAudit(connection, objectId, username) {
  await connection.execute('UPDATE cassis_objects SET lastUpdated = UTC_TIMESTAMP(3), lastUpdatedBy = ? WHERE objectId = ?',
    [username, objectId]);
}

async function saveExtraClass(connection, objectId, values) {
  await connection.execute('DELETE FROM case_extraclass WHERE caseId = ?', [objectId]);
  for (const [position, value] of values.entries()) {
    await connection.execute('INSERT INTO case_extraclass (caseId, position, value) VALUES (?, ?, ?)',
      [objectId, position, value]);
  }
}

async function cases(objectId) {
  const [rows] = await pool.execute(
    `SELECT o.*, c.diaryNumber, c.classification, c.classification_ValueList, c.extraclass_ValueList, c.caseSentence
     FROM base_case c JOIN cassis_objects o ON o.objectId = c.objectId
     ${objectId ? 'WHERE c.objectId = ?' : ''} ORDER BY o.created DESC, o.objectId`,
    objectId ? [objectId] : [],
  );
  if (!rows.length) return rows;
  const [values] = await pool.execute(
    `SELECT caseId, value FROM case_extraclass ${objectId ? 'WHERE caseId = ?' : ''} ORDER BY caseId, position`,
    objectId ? [objectId] : [],
  );
  const byId = new Map(rows.map((row) => [row.objectId, { ...row, extraclass: [] }]));
  for (const value of values) byId.get(value.caseId)?.extraclass.push(value.value);
  return [...byId.values()];
}

async function records(objectId) {
  const [rows] = await pool.execute(
    `SELECT o.*, p.sourceId AS caseId, r.name, r.description, r.recordType, r.recordType_ValueList
     FROM base_record r JOIN cassis_objects o ON o.objectId = r.objectId
     LEFT JOIN cassis_relations p ON p.id = r.objectId AND p.targetId = r.objectId AND p.relationType = ?
     ${objectId ? 'WHERE r.objectId = ?' : ''} ORDER BY o.created DESC, o.objectId`,
    objectId ? [PARENT_RELATION_TYPE, objectId] : [PARENT_RELATION_TYPE],
  );
  if (rows.some((row) => !row.caseId)) throw new Error('A record is missing its parent-child relation');
  return rows;
}

app.get('/api/health', async (_request, response) => {
  try {
    await pool.query('SELECT 1');
    response.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('Database health check failed:', error);
    response.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.get('/api/test-messages', async (_request, response) => {
  try {
    const [rows] = await pool.query('SELECT id, message FROM test_messages ORDER BY id');
    response.json(rows);
  } catch (error) {
    console.error('Could not read test messages:', error);
    response.status(500).json({ error: 'Could not read test messages' });
  }
});

app.post('/api/auth/login', async (request, response) => {
  const { username, password } = request.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 50 || password.length > 1024) {
    fail(400, 'Invalid username or password');
  }
  const [users] = await pool.execute('SELECT id, username, password_hash FROM cassis_users WHERE username = ?', [username]);
  if (!users.length || !await verifyPassword(password, users[0].password_hash)) {
    fail(401, 'Invalid username or password');
  }
  const roles = await userRoles(pool, users[0].id);
  if (!roles.length || !permissionsFor(roles).includes('read')) fail(403, 'User has no supported role');
  const token = randomBytes(32).toString('hex');
  await pool.execute('INSERT INTO cassis_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR))',
    [tokenHash(token), users[0].id]);
  response.json({ token, username: users[0].username, expiresIn: 28800 });
});

app.use('/api', async (request, _response, next) => {
  const match = /^Bearer ([0-9a-f]{64})$/i.exec(request.get('authorization') || '');
  if (!match) fail(401, 'Authentication required');
  const [users] = await pool.execute(
    `SELECT u.id, u.username FROM cassis_sessions s JOIN cassis_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()`, [tokenHash(match[1])],
  );
  if (!users.length) fail(401, 'Session expired or invalid');
  const roles = await userRoles(pool, users[0].id);
  const permissions = permissionsFor(roles);
  if (!roles.length || !permissions.includes('read')) fail(403, 'User has no supported role');
  request.username = users[0].username;
  request.userId = users[0].id;
  request.roles = roles;
  request.permissions = permissions;
  request.token = match[1];
  next();
});

function authorize(permission) {
  return (request, _response, next) => {
    if (!request.permissions.includes(permission)) fail(403, 'Permission denied');
    next();
  };
}

app.get('/api/me', (request, response) => {
  response.json({ username: request.username, roles: request.roles, permissions: request.permissions, supportedUserRoles: Object.keys(rolePermissions) });
});

app.post('/api/auth/logout', async (request, response) => {
  await pool.execute('DELETE FROM cassis_sessions WHERE token_hash = ?', [tokenHash(request.token)]);
  response.sendStatus(204);
});

app.post('/api/users', authorize('user:create'), async (request, response) => {
  const user = await createUser(pool, request.body?.username, request.body?.password, request.body?.roles, request.userId);
  response.status(201).json(user);
});

app.get('/api/users', authorize('user:create'), async (_request, response) => {
  response.json(await listUsers(pool));
});

app.put('/api/users/:id', authorize('user:create'), async (request, response) => {
  const user = await updateUser(pool, id(request.params.id, 'user id'), request.body?.username,
    request.body?.password, request.body?.roles, tokenHash(request.token), request.userId);
  response.json(user);
});

app.delete('/api/users/:id', authorize('user:create'), async (request, response) => {
  await deleteUser(pool, id(request.params.id, 'user id'), request.userId);
  response.sendStatus(204);
});

app.get('/api/value-lists', async (_request, response) => {
  const [rows] = await pool.execute(
    `SELECT l.listName, e.value FROM cassis_valuelists l
     JOIN cassis_valuelistelements e ON e.listId = l.objectId`,
  );
  rows.sort((a, b) => a.listName.localeCompare(b.listName) || a.value.localeCompare(b.value, 'sv'));
  response.json(rows);
});

app.get('/api/value-list-definitions', authorize('value-list:manage'), async (_request, response) => {
  response.json(await listValueListDefinitions(pool));
});

app.post('/api/value-list-definitions', authorize('value-list:manage'), async (request, response) => {
  const listName = text(request.body?.listName, 'listName', 100).trim();
  if (!listName) fail(400, 'listName must not be empty');
  const listDescription = text(request.body?.listDescription, 'listDescription', 255);
  const objectId = randomUUID();
  let constraints;
  try {
    constraints = await transaction(async (connection) => {
      const bindings = await getValueListBindings(connection);
      await insertObject(connection, objectId, 'cassis_valuelist', request.username);
      await connection.execute(
        'INSERT INTO cassis_valuelists (objectId, listName, listDescription) VALUES (?, ?, ?)',
        [objectId, listName, listDescription],
      );
      return valueListConstraints(listName, bindings);
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') fail(409, 'Value list name already exists');
    throw error;
  }
  response.status(201).json({ objectId, listName, listDescription, ...constraints, values: [] });
});

app.put('/api/value-list-definitions/:id', authorize('value-list:manage'), async (request, response) => {
  const objectId = id(request.params.id, 'value list id');
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).some((key) => key !== 'listDescription')) {
    fail(400, 'Only listDescription can be changed');
  }
  const listDescription = text(request.body.listDescription, 'listDescription', 255);
  await transaction(async (connection) => {
    const [lists] = await connection.execute('SELECT objectId FROM cassis_valuelists WHERE objectId = ? FOR UPDATE', [objectId]);
    if (!lists.length) fail(404, 'Value list not found');
    await connection.execute('UPDATE cassis_valuelists SET listDescription = ? WHERE objectId = ?', [listDescription, objectId]);
    await updateAudit(connection, objectId, request.username);
  });
  response.json({ objectId, listDescription });
});

app.post('/api/value-list-definitions/:id/values', authorize('value-list:manage'), async (request, response) => {
  const listId = id(request.params.id, 'value list id');
  const value = text(request.body?.value, 'value', 255);
  if (!value.trim()) fail(400, 'value must not be empty');
  const objectId = randomUUID();
  let listName;
  try {
    listName = await transaction(async (connection) => {
      const [lists] = await connection.execute('SELECT listName FROM cassis_valuelists WHERE objectId = ? FOR UPDATE', [listId]);
      if (!lists.length) fail(404, 'Value list not found');
      const bindings = await getValueListBindings(connection);
      const { maxValueLength } = valueListConstraints(lists[0].listName, bindings);
      if ([...value].length > maxValueLength) fail(400, `value must be at most ${maxValueLength} characters for this list`);
      await insertObject(connection, objectId, 'cassis_valuelistelement', request.username);
      await connection.execute('INSERT INTO cassis_valuelistelements (objectId, listId, value) VALUES (?, ?, ?)',
        [objectId, listId, value]);
      return lists[0].listName;
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') fail(409, 'Value already exists in this list');
    throw error;
  }
  response.status(201).json(valueListElement(objectId, value, listName));
});

app.get('/api/value-list-bindings', async (_request, response) => {
  response.json(await getValueListBindings(pool));
});

app.get('/api/cases', async (_request, response) => response.json(await cases()));
app.get('/api/cases/:id', async (request, response) => {
  const [row] = await cases(id(request.params.id));
  if (!row) fail(404, 'base_case not found');
  response.json(row);
});

app.post('/api/cases', authorize('case:create'), async (request, response) => {
  const data = caseInput(request.body);
  const objectId = randomUUID();
  await transaction(async (connection) => {
    await validateValueLists(connection, data, (await getValueListBindings(connection)).base_case);
    await insertObject(connection, objectId, 'base_case', request.username);
    await connection.execute('INSERT INTO base_case (objectId, diaryNumber, classification, caseSentence) VALUES (?, ?, ?, ?)',
      [objectId, data.diaryNumber, data.classification, data.caseSentence]);
    await saveExtraClass(connection, objectId, data.extraclass);
  });
  response.status(201).json((await cases(objectId))[0]);
});

app.put('/api/cases/:id', authorize('case:update'), async (request, response) => {
  const objectId = id(request.params.id);
  const data = caseInput(request.body);
  await transaction(async (connection) => {
    await requireObject(connection, objectId, 'base_case', true);
    await validateValueLists(connection, data, (await getValueListBindings(connection)).base_case);
    await connection.execute('UPDATE base_case SET diaryNumber = ?, classification = ?, caseSentence = ? WHERE objectId = ?',
      [data.diaryNumber, data.classification, data.caseSentence, objectId]);
    await saveExtraClass(connection, objectId, data.extraclass);
    await updateAudit(connection, objectId, request.username);
  });
  response.json((await cases(objectId))[0]);
});

app.delete('/api/cases/:id', authorize('case:delete'), async (request, response) => {
  const objectId = id(request.params.id);
  await transaction(async (connection) => {
    await requireObject(connection, objectId, 'base_case', true);
    const [children] = await connection.execute(
      `SELECT b.objectId FROM base_record b
       JOIN cassis_relations p ON p.id = b.objectId AND p.targetId = b.objectId
       WHERE p.sourceId = ? AND p.relationType = ? FOR UPDATE`,
      [objectId, PARENT_RELATION_TYPE],
    );
    for (const child of children) {
      await connection.execute('DELETE FROM cassis_objects WHERE objectId = ?', [child.objectId]);
    }
    await connection.execute('DELETE FROM cassis_objects WHERE objectId = ?', [objectId]);
  });
  response.sendStatus(204);
});

app.get('/api/records', async (_request, response) => response.json(await records()));
app.get('/api/records/:id', async (request, response) => {
  const [row] = await records(id(request.params.id));
  if (!row) fail(404, 'base_record not found');
  response.json(row);
});

app.post('/api/records', authorize('record:create'), async (request, response) => {
  const data = recordInput(request.body);
  const objectId = randomUUID();
  await transaction(async (connection) => {
    await requireObject(connection, data.caseId, 'base_case', true);
    await validateValueLists(connection, data, (await getValueListBindings(connection)).base_record);
    await insertObject(connection, objectId, 'base_record', request.username);
    await connection.execute('INSERT INTO base_record (objectId, name, description, recordType) VALUES (?, ?, ?, ?)',
      [objectId, data.name, data.description, data.recordType]);
    await createParentRelation(connection, data.caseId, objectId);
  });
  response.status(201).json((await records(objectId))[0]);
});

app.put('/api/records/:id', authorize('record:update'), async (request, response) => {
  const objectId = id(request.params.id);
  const data = recordInput(request.body);
  await transaction(async (connection) => {
    await requireObject(connection, data.caseId, 'base_case', true);
    await requireObject(connection, objectId, 'base_record', true);
    await validateValueLists(connection, data, (await getValueListBindings(connection)).base_record);
    const [existing] = await connection.execute(
      'SELECT sourceId FROM cassis_relations WHERE id = ? AND targetId = ? AND relationType = ? FOR UPDATE',
      [objectId, objectId, PARENT_RELATION_TYPE],
    );
    if (!existing.length) throw new Error(`Missing parent-child relation for record ${objectId}`);
    if (existing[0].sourceId.toLowerCase() !== data.caseId.toLowerCase()) {
      const [relation] = await connection.execute(
        'UPDATE cassis_relations SET sourceId = ? WHERE id = ? AND sourceId = ? AND targetId = ? AND relationType = ?',
        [data.caseId, objectId, existing[0].sourceId, objectId, PARENT_RELATION_TYPE],
      );
      if (!relation.affectedRows) throw new Error(`Missing parent-child relation for record ${objectId}`);
    }
    await connection.execute('UPDATE base_record SET name = ?, description = ?, recordType = ? WHERE objectId = ?',
      [data.name, data.description, data.recordType, objectId]);
    await updateAudit(connection, objectId, request.username);
  });
  response.json((await records(objectId))[0]);
});

app.delete('/api/records/:id', authorize('record:delete'), async (request, response) => {
  const objectId = id(request.params.id);
  await transaction(async (connection) => {
    await requireObject(connection, objectId, 'base_record', true);
    await connection.execute('DELETE FROM cassis_objects WHERE objectId = ?', [objectId]);
  });
  response.sendStatus(204);
});

app.get('/api/relations', async (_request, response) => {
  const [rows] = await pool.execute(
    'SELECT id, sourceId, targetId, objectTypes, relationType, (id = targetId AND relationType = ?) AS automatic FROM cassis_relations ORDER BY id',
    [PARENT_RELATION_TYPE],
  );
  response.json(rows.map((row) => ({ ...row, automatic: Boolean(row.automatic) })));
});

function relationInput(body) {
  const sourceId = id(body?.sourceId, 'sourceId');
  const targetId = id(body?.targetId, 'targetId');
  const relationType = text(body?.relationType ?? '', 'relationType', 100);
  if (relationType.trim().toLowerCase() === PARENT_RELATION_TYPE) {
    fail(400, 'parent-child is reserved for automatic case-record relations');
  }
  return { sourceId, targetId, relationType };
}

async function relationObjectTypes(connection, sourceId, targetId) {
  const [objects] = await connection.execute(
    'SELECT objectId, objectType FROM cassis_objects WHERE objectId IN (?, ?) ORDER BY objectId FOR UPDATE',
    [sourceId, targetId],
  );
  const byId = new Map(objects.map((object) => [object.objectId.toLowerCase(), object.objectType]));
  const source = byId.get(sourceId.toLowerCase());
  const target = byId.get(targetId.toLowerCase());
  if (!source || !target) fail(404, 'Source or target object not found');
  return `${source}-${target}`;
}

app.post('/api/relations', authorize('relation:manage'), async (request, response) => {
  const { sourceId, targetId, relationType } = relationInput(request.body);
  const relationId = randomUUID();
  let objectTypes;
  try {
    objectTypes = await transaction(async (connection) => {
      const types = await relationObjectTypes(connection, sourceId, targetId);
      await connection.execute('INSERT INTO cassis_relations (id, sourceId, targetId, objectTypes, relationType) VALUES (?, ?, ?, ?, ?)',
        [relationId, sourceId, targetId, types, relationType]);
      return types;
    });
  } catch (error) {
    if (error.code === 'ER_NO_REFERENCED_ROW_2') fail(404, 'Source or target object not found');
    if (error.code === 'ER_DUP_ENTRY') fail(409, 'Relation already exists');
    throw error;
  }
  response.status(201).json({ id: relationId, sourceId, targetId, objectTypes, relationType, automatic: false });
});

app.put('/api/relations/:id', authorize('relation:manage'), async (request, response) => {
  const relationId = id(request.params.id, 'relation id');
  const { sourceId, targetId, relationType } = relationInput(request.body);
  let objectTypes;
  try {
    objectTypes = await transaction(async (connection) => {
      const types = await relationObjectTypes(connection, sourceId, targetId);
      const [rows] = await connection.execute(
        'SELECT (id = targetId AND relationType = ?) AS automatic FROM cassis_relations WHERE id = ? FOR UPDATE',
        [PARENT_RELATION_TYPE, relationId],
      );
      if (!rows.length) fail(404, 'Relation not found');
      if (rows[0].automatic) {
        fail(409, 'Automatic parent-child relations are managed through the record');
      }
      await connection.execute(
        'UPDATE cassis_relations SET sourceId = ?, targetId = ?, objectTypes = ?, relationType = ? WHERE id = ?',
        [sourceId, targetId, types, relationType, relationId],
      );
      return types;
    });
  } catch (error) {
    if (error.code === 'ER_NO_REFERENCED_ROW_2') fail(404, 'Source or target object not found');
    if (error.code === 'ER_DUP_ENTRY') fail(409, 'Relation already exists');
    throw error;
  }
  response.json({ id: relationId, sourceId, targetId, objectTypes, relationType, automatic: false });
});

app.delete('/api/relations/:id', authorize('relation:manage'), async (request, response) => {
  const relationId = id(request.params.id, 'relation id');
  const [result] = await pool.execute(
    'DELETE FROM cassis_relations WHERE id = ? AND NOT (id = targetId AND relationType = ?)',
    [relationId, PARENT_RELATION_TYPE],
  );
  if (!result.affectedRows) {
    const [rows] = await pool.execute('SELECT id FROM cassis_relations WHERE id = ?', [relationId]);
    if (rows.length) fail(409, 'Automatic parent-child relations are managed through the record');
    fail(404, 'Relation not found');
  }
  response.sendStatus(204);
});

app.get('/api/search', async (request, response) => {
  const query = request.query.q;
  if (typeof query !== 'string' || !query.trim() || query.length > 255) fail(400, 'q must be between 1 and 255 characters');
  const [rows] = await pool.execute(
    `SELECT o.objectId, o.objectType, o.created, o.createdBy, COALESCE(c.diaryNumber, r.name) AS label,
       c.diaryNumber, c.caseSentence, r.name, r.recordType
     FROM cassis_objects o
     LEFT JOIN base_case c ON c.objectId = o.objectId
     LEFT JOIN base_record r ON r.objectId = o.objectId
     LEFT JOIN cassis_relations p ON p.id = r.objectId AND p.targetId = r.objectId AND p.relationType = ?
     WHERE o.objectType IN ('base_case', 'base_record') AND (LOCATE(?, CONCAT_WS(' ', o.objectId, o.objectType, o.created, o.createdBy, o.lastUpdated,
       o.lastUpdatedBy, c.diaryNumber, c.classification, c.caseSentence,
       p.sourceId, r.name, r.description, r.recordType)) > 0
       OR EXISTS (SELECT 1 FROM case_extraclass e WHERE e.caseId = o.objectId AND LOCATE(?, e.value) > 0))
     ORDER BY o.created DESC, o.objectId`, [PARENT_RELATION_TYPE, query.trim(), query.trim()],
  );
  response.json(rows);
});

app.use((error, _request, response, _next) => {
  if (!error.status || error.status >= 500) console.error('API error:', error);
  response.status(error.status || 500).json({ error: error.status && error.status < 500 ? error.message : 'Internal server error' });
});

async function start() {
  try {
    await pool.query('SELECT 1');
    app.listen(port, () => console.log(`Backend listening on http://localhost:${port}`));
  } catch (error) {
    console.error('Could not connect to the MySQL database:', error);
    process.exitCode = 1;
  }
}

if (require.main === module) start();
module.exports = app;
