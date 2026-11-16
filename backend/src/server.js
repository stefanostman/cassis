require('dotenv').config({ quiet: true });

const express = require('express');
const multer = require('multer');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const pool = require('./db');
const { verifyPassword } = require('./password');
const { PARENT_RELATION_TYPE, createParentRelation } = require('./parent-relations');
const { getValueListBindings, validateValueLists, valueListConstraints, valueListElement, listValueListDefinitions } = require('./value-lists');
const { rolePermissions, permissionsFor, userRoles, createUser, listUsers, updateUser, deleteUser } = require('./roles');

const app = express();
const port = Number(process.env.PORT || 3000);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const documentDirectory = path.resolve(__dirname, '..', '..', 'importerade dokument');
const maxDocumentSize = 25 * 1024 * 1024;
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: maxDocumentSize + 1, files: 1, fields: 2, fieldSize: 1024, parts: 3 },
  fileFilter(_request, file, callback) {
    if (!['.pdf', '.docx', '.xlsx', '.png', '.jpg'].includes(path.extname(file.originalname).toLowerCase())) {
      return callback(Object.assign(new Error('Filtypen stöds inte'), { status: 400 }));
    }
    callback(null, true);
  },
}).single('file');

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

async function requireNoDocuments(connection, recordId) {
  const [documents] = await connection.execute('SELECT objectId FROM base_document WHERE recordId = ? LIMIT 1', [recordId]);
  if (documents.length) fail(409, 'Handlingen innehåller dokument och kan inte tas bort');
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

async function authenticate(request, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) fail(401, 'Authentication required');
  const [users] = await pool.execute(
    `SELECT u.id, u.username FROM cassis_sessions s JOIN cassis_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()`, [tokenHash(token)],
  );
  if (!users.length) fail(401, 'Session expired or invalid');
  const roles = await userRoles(pool, users[0].id);
  const permissions = permissionsFor(roles);
  if (!roles.length || !permissions.includes('read')) fail(403, 'User has no supported role');
  request.username = users[0].username;
  request.userId = users[0].id;
  request.roles = roles;
  request.permissions = permissions;
  request.token = token;
}

app.post('/api/documents/:id/open', express.urlencoded({ extended: false, limit: '1kb' }), async (request, response, next) => {
  await authenticate(request, request.body?.token);
  await sendDocument(request, response, next, 'inline');
});

app.use('/api', async (request, _response, next) => {
  const match = /^Bearer ([0-9a-f]{64})$/i.exec(request.get('authorization') || '');
  await authenticate(request, match?.[1]);
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

function conversationBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => key !== 'body')) fail(400, 'Only body is allowed');
  const value = text(body.body, 'body', 4000);
  if (!value.trim()) fail(400, 'body must not be empty');
  return value;
}

async function conversationPosts(connection, caseId, userId, postId) {
  const [rows] = await connection.execute(
    `SELECT p.id, p.caseId, COALESCE(u.username, p.authorName) AS authorName,
       p.body, p.created, p.updated, COALESCE(p.authorId = ?, 0) AS isOwn
     FROM case_conversation_posts p LEFT JOIN cassis_users u ON u.id = p.authorId
     WHERE p.caseId = ?${postId ? ' AND p.id = ?' : ''}
     ORDER BY p.created, p.id`,
    postId ? [userId, caseId, postId] : [userId, caseId],
  );
  return rows.map((row) => ({ ...row, isOwn: Number(row.isOwn) === 1 }));
}

app.get('/api/cases/:id/conversation', async (request, response) => {
  const caseId = id(request.params.id, 'case id');
  await requireObject(pool, caseId, 'base_case');
  response.json(await conversationPosts(pool, caseId, request.userId));
});

app.post('/api/cases/:id/conversation', authorize('case:update'), async (request, response) => {
  const caseId = id(request.params.id, 'case id');
  const body = conversationBody(request.body);
  const postId = randomUUID();
  const post = await transaction(async (connection) => {
    await requireObject(connection, caseId, 'base_case', true);
    await connection.execute(
      `INSERT INTO case_conversation_posts (id, caseId, authorId, authorName, body, created, updated)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      [postId, caseId, request.userId, request.username, body],
    );
    return (await conversationPosts(connection, caseId, request.userId, postId))[0];
  });
  response.status(201).json(post);
});

app.put('/api/cases/:id/conversation/:postId', authorize('case:update'), async (request, response) => {
  const caseId = id(request.params.id, 'case id');
  const postId = id(request.params.postId, 'post id');
  const body = conversationBody(request.body);
  const post = await transaction(async (connection) => {
    await requireObject(connection, caseId, 'base_case', true);
    const [rows] = await connection.execute(
      'SELECT authorId FROM case_conversation_posts WHERE id = ? AND caseId = ? FOR UPDATE', [postId, caseId],
    );
    if (!rows.length) fail(404, 'Conversation post not found');
    if (!rows[0].authorId || rows[0].authorId.toLowerCase() !== request.userId.toLowerCase()) {
      fail(403, 'Only the author can edit a conversation post');
    }
    await connection.execute(
      'UPDATE case_conversation_posts SET body = ?, updated = UTC_TIMESTAMP(3) WHERE id = ?', [body, postId],
    );
    return (await conversationPosts(connection, caseId, request.userId, postId))[0];
  });
  response.json(post);
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
      await requireNoDocuments(connection, child.objectId);
    }
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
    await requireNoDocuments(connection, objectId);
    await connection.execute('DELETE FROM cassis_objects WHERE objectId = ?', [objectId]);
  });
  response.sendStatus(204);
});

app.get('/api/documents', async (_request, response) => {
  const [rows] = await pool.execute(
    `SELECT o.*, d.recordId, d.name, d.documentType, d.documentType_ValueList, d.filetype, d.filesize, d.filename, d.originalFilename
     FROM base_document d JOIN cassis_objects o ON o.objectId = d.objectId ORDER BY o.created DESC, o.objectId`,
  );
  response.json(rows);
});

function documentPath(document) {
  if (!['pdf', 'docx', 'xlsx', 'png', 'jpg'].includes(document.filetype.toLowerCase())
      || document.filename !== `${document.objectId}.${document.filetype}`) {
    throw new Error(`Invalid stored filename for document ${document.objectId}`);
  }
  return path.join(documentDirectory, document.filename);
}

function documentDownloadName(document) {
  if (document.originalFilename) return document.originalFilename;
  const name = document.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'dokument';
  return name.toLowerCase().endsWith(`.${document.filetype.toLowerCase()}`) ? name : `${name}.${document.filetype}`;
}

async function sendDocument(request, response, next, disposition) {
  const objectId = id(request.params.id, 'document id');
  const [rows] = await pool.execute('SELECT objectId, name, filename, filetype, originalFilename FROM base_document WHERE objectId = ?', [objectId]);
  if (!rows.length) fail(404, 'Dokumentet finns inte');
  const document = rows[0];
  const filePath = documentPath(document);
  await fs.access(filePath);
  response.attachment(documentDownloadName(document));
  if (disposition === 'inline') {
    response.set('Content-Disposition', response.get('Content-Disposition').replace(/^attachment/, 'inline'));
  }
  response.type(document.filetype);
  response.set('X-Content-Type-Options', 'nosniff');
  response.set('Cache-Control', 'no-store');
  response.sendFile(filePath, (error) => {
    if (error) next(error);
  });
}

app.get('/api/documents/:id/content', async (request, response, next) => {
  await sendDocument(request, response, next, 'attachment');
});

app.put('/api/documents/:id', authorize('record:update'), async (request, response) => {
  const objectId = id(request.params.id, 'document id');
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).some((key) => key !== 'name')) fail(400, 'Only name can be changed');
  const name = text(request.body.name, 'name', 100);
  if (!name.trim()) fail(400, 'Ange dokumentnamn');
  await transaction(async (connection) => {
    await requireObject(connection, objectId, 'base_document', true);
    await connection.execute('UPDATE base_document SET name = ? WHERE objectId = ?', [name, objectId]);
    await updateAudit(connection, objectId, request.username);
  });
  response.json({ objectId, name });
});

app.delete('/api/documents/:id', authorize('record:update'), async (request, response) => {
  const objectId = id(request.params.id, 'document id');
  let originalPath;
  let stagedPath;
  let staged = false;
  try {
    await transaction(async (connection) => {
      const [rows] = await connection.execute('SELECT objectId, filename, filetype FROM base_document WHERE objectId = ? FOR UPDATE', [objectId]);
      if (!rows.length) fail(404, 'Dokumentet finns inte');
      originalPath = documentPath(rows[0]);
      stagedPath = `${originalPath}.${randomUUID()}.deleting`;
      await fs.rename(originalPath, stagedPath);
      staged = true;
      await connection.execute('DELETE FROM cassis_objects WHERE objectId = ?', [objectId]);
    });
  } catch (error) {
    if (staged) {
      try {
        const [rows] = await pool.execute('SELECT objectId FROM base_document WHERE objectId = ?', [objectId]);
        if (rows.length) await fs.rename(stagedPath, originalPath);
        else await fs.unlink(stagedPath);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Kunde inte återställa eller ta bort dokumentfilen ${objectId}`);
      }
    }
    throw error;
  }
  await fs.unlink(stagedPath);
  response.sendStatus(204);
});

app.post('/api/records/:id/documents', authorize('record:update'), uploadDocument, async (request, response) => {
  const recordId = id(request.params.id, 'record id');
  if (!request.file) fail(400, 'Välj en fil att importera');
  if (request.file.size > maxDocumentSize) fail(413, 'Filen får vara högst 25 MiB');
  const name = text(request.body?.name, 'name', 100);
  const documentType = text(request.body?.documentType, 'documentType', 100);
  const originalFilename = text(request.file.originalname, 'originalFilename', 255);
  if (!name.trim() || !documentType.trim()) fail(400, 'Ange dokumentnamn och dokumenttyp');
  const objectId = randomUUID();
  const extension = path.extname(request.file.originalname);
  const filetype = extension.slice(1);
  const filename = `${objectId}${extension}`;
  const filePath = path.join(documentDirectory, filename);
  let written = false;
  try {
    await transaction(async (connection) => {
      await requireObject(connection, recordId, 'base_record', true);
      const bindings = await getValueListBindings(connection);
      const [values] = await connection.execute(
        `SELECT e.objectId FROM cassis_valuelistelements e JOIN cassis_valuelists l ON l.objectId = e.listId
         WHERE BINARY l.listName = BINARY ? AND BINARY e.value = BINARY ?`,
        [bindings.base_document.documentType, documentType],
      );
      if (!values.length) fail(400, 'Dokumenttypen måste finnas i värdelistan documentType');
      await insertObject(connection, objectId, 'base_document', request.username);
      await connection.execute(
        'INSERT INTO base_document (objectId, recordId, name, documentType, filetype, filesize, filename, originalFilename) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [objectId, recordId, name, documentType, filetype, request.file.size, filename, originalFilename],
      );
      await fs.mkdir(documentDirectory, { recursive: true });
      const file = await fs.open(filePath, 'wx');
      written = true;
      try {
        await file.writeFile(request.file.buffer);
      } finally {
        await file.close();
      }
    });
  } catch (error) {
    if (written) {
      try {
        const [rows] = await pool.execute('SELECT objectId FROM base_document WHERE objectId = ?', [objectId]);
        if (!rows.length) await fs.unlink(filePath);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Kunde inte kontrollera eller städa filen ${filename}`);
      }
    }
    throw error;
  }
  const [rows] = await pool.execute(
    `SELECT o.*, d.recordId, d.name, d.documentType, d.documentType_ValueList, d.filetype, d.filesize, d.filename, d.originalFilename
     FROM base_document d JOIN cassis_objects o ON o.objectId = d.objectId WHERE d.objectId = ?`, [objectId],
  );
  response.status(201).json(rows[0]);
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
    `SELECT o.objectId, o.objectType, o.created, o.createdBy, COALESCE(c.diaryNumber, r.name, d.name) AS label,
       c.diaryNumber, c.caseSentence, COALESCE(r.name, d.name) AS name, r.recordType,
       d.recordId, d.documentType, d.filetype, d.filesize, d.filename, d.originalFilename
     FROM cassis_objects o
     LEFT JOIN base_case c ON c.objectId = o.objectId
     LEFT JOIN base_record r ON r.objectId = o.objectId
     LEFT JOIN base_document d ON d.objectId = o.objectId
     LEFT JOIN cassis_relations p ON p.id = r.objectId AND p.targetId = r.objectId AND p.relationType = ?
     WHERE o.objectType IN ('base_case', 'base_record', 'base_document') AND (LOCATE(?, CONVERT(CONCAT_WS(' ', o.objectId, o.objectType, o.created, o.createdBy, o.lastUpdated,
       o.lastUpdatedBy, c.diaryNumber, c.classification, c.caseSentence,
       p.sourceId, r.name, r.description, r.recordType, d.recordId, d.name, d.documentType, d.filetype, d.filesize, d.filename) USING utf8mb4) COLLATE utf8mb4_general_ci) > 0
       OR LOCATE(?, d.originalFilename COLLATE utf8mb4_general_ci) > 0
       OR EXISTS (SELECT 1 FROM case_extraclass e WHERE e.caseId = o.objectId AND LOCATE(?, CONVERT(e.value USING utf8mb4) COLLATE utf8mb4_general_ci) > 0))
     ORDER BY o.created DESC, o.objectId`, [PARENT_RELATION_TYPE, query.trim(), query.trim(), query.trim()],
  );
  response.json(rows);
});

app.use((error, _request, response, next) => {
  if (response.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    error.status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  }
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
