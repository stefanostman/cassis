require('dotenv').config({ quiet: true });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const pool = require('../src/db');
const { hashPassword } = require('../src/password');
const { ensureParentRelation } = require('../src/parent-relations');
const { validateValueLists } = require('../src/value-lists');
const { createUser: createUserWithRoles, rolePermissions } = require('../src/roles');
const app = require('../src/server');

test('authenticated CRUD, search, relations and cascading deletion', async () => {
  const username = `test_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(16).toString('hex');
  let userId;
  const extraUserIds = [];
  const objectIds = [];
  const valueListIds = [];
  const valueElementIds = [];
  const originalGetConnection = pool.getConnection;
  // Keep the CRUD fixture independent of value lists configured in the shared database.
  pool.getConnection = async function () {
    const connection = await originalGetConnection.call(pool);
    const execute = connection.execute;
    const release = connection.release;
    connection.execute = function (sql, params) {
      if (sql.startsWith('SELECT l.listName, e.value FROM cassis_valuelists l')) return Promise.resolve([[]]);
      return execute.call(connection, sql, params);
    };
    connection.release = function () {
      connection.execute = execute;
      connection.release = release;
      return release.call(connection);
    };
    return connection;
  };
  let server;
  try {
    const field = `test_${randomUUID().replaceAll('-', '')}`;
    const connection = await originalGetConnection.call(pool);
    try {
      await connection.beginTransaction();
      const { insertAudit } = require('../src/seed-value-lists');
      const listId = randomUUID();
      const elementId = randomUUID();
      await insertAudit(connection, listId, 'cassis_valuelist');
      await insertAudit(connection, elementId, 'cassis_valuelistelement');
      await connection.execute('INSERT INTO cassis_valuelists (objectId, listName) VALUES (?, ?)', [listId, `${field}_ValueList`]);
      await connection.execute('INSERT INTO cassis_valuelistelements (objectId, listId, value) VALUES (?, ?, ?)', [elementId, listId, 'A']);
      await validateValueLists(connection, { [field]: 'A' }, { [field]: `${field}_ValueList` });
      await assert.rejects(validateValueLists(connection, { [field]: 'B' }, { [field]: `${field}_ValueList` }), (error) => error.status === 400);
    } finally {
      await connection.rollback();
      connection.release();
    }
    const [columns] = await pool.query('SHOW COLUMNS FROM base_record');
    assert.equal(columns.some((column) => column.Field === 'caseId'), false);
    const adminUser = await createUserWithRoles(pool, username, password, ['admin']);
    userId = adminUser.id;
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    let token = '';
    async function request(path, method = 'GET', body) {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    }

    assert.equal((await request('/cases')).status, 401);
    assert.equal((await request('/value-lists')).status, 401);
    assert.equal((await request('/auth/login', 'POST', { username, password: 'wrong' })).status, 401);
    const login = await request('/auth/login', 'POST', { username, password });
    assert.equal(login.status, 200);
    token = login.body.token;
    const listResponse = await request('/value-lists');
    const [listRows] = await pool.query(
      'SELECT l.listName, e.value FROM cassis_valuelists l JOIN cassis_valuelistelements e ON e.listId = l.objectId',
    );
    const sortLists = (rows) => rows.sort((a, b) => a.listName.localeCompare(b.listName) || a.value.localeCompare(b.value, 'sv'));
    assert.deepEqual(listResponse.body, sortLists(listRows));
    assert.deepEqual((await request('/value-list-bindings')).body, {
      base_case: { classification: 'classification', extraclass: 'extraClass' },
      base_record: { recordType: 'recordType' },
      base_document: { documentType: 'documentType' },
    });
    const [invalidAudits] = await pool.query(
      `SELECT l.objectId FROM cassis_valuelists l LEFT JOIN cassis_objects o ON o.objectId = l.objectId
       WHERE o.objectId IS NULL OR o.objectType <> 'cassis_valuelist'
       UNION ALL
       SELECT e.objectId FROM cassis_valuelistelements e LEFT JOIN cassis_objects o ON o.objectId = e.objectId
       WHERE o.objectId IS NULL OR o.objectType <> 'cassis_valuelistelement'`,
    );
    assert.deepEqual(invalidAudits, []);
    assert.equal((await request('/search?q=cassis_valuelist')).body.every((row) =>
      ['base_case', 'base_record', 'base_document'].includes(row.objectType)), true);

    const listName = `${username}_list`;
    const createdList = await request('/value-list-definitions', 'POST', { listName, listDescription: 'Beskrivning' });
    assert.equal(createdList.status, 201);
    valueListIds.push(createdList.body.objectId);
    assert.deepEqual(createdList.body.values, []);
    assert.equal(createdList.body.maxValueLength, 255);
    assert.equal((await request('/value-list-definitions')).body.some((item) =>
      item.objectId === createdList.body.objectId && item.values.length === 0), true);
    assert.equal((await request('/value-list-definitions', 'POST', { listName, listDescription: '' })).status, 409);
    const element = await request(`/value-list-definitions/${createdList.body.objectId}/values`, 'POST', { value: 'Övrigt' });
    assert.equal(element.status, 201);
    valueElementIds.push(element.body.objectId);
    assert.equal(element.body.supported, true);
    assert.equal((await request(`/value-list-definitions/${createdList.body.objectId}/values`, 'POST', { value: 'Övrigt' })).status, 409);
    assert.equal((await request(`/value-list-definitions/${createdList.body.objectId}/values`, 'POST', { value: '  ' })).status, 400);
    assert.equal((await request(`/value-list-definitions/${createdList.body.objectId}`, 'PUT',
      { listName: 'changed', listDescription: 'Nytt' })).status, 400);
    assert.equal((await request(`/value-list-definitions/${createdList.body.objectId}`, 'PUT',
      { listDescription: 'Nytt' })).status, 200);
    const listAfterUpdate = (await request('/value-list-definitions')).body.find((item) => item.objectId === createdList.body.objectId);
    assert.equal(listAfterUpdate.listName, listName);
    assert.equal(listAfterUpdate.listDescription, 'Nytt');
    assert.deepEqual(listAfterUpdate.values, [element.body]);
    const [audits] = await pool.execute('SELECT objectId, objectType, createdBy, lastUpdatedBy FROM cassis_objects WHERE objectId IN (?, ?)',
      [createdList.body.objectId, element.body.objectId]);
    assert.equal(audits.length, 2);
    assert.ok(audits.every((item) => item.createdBy === username && item.lastUpdatedBy === username));
    const definitions = (await request('/value-list-definitions')).body;
    const classification = definitions.find((item) => item.listName === 'classification');
    assert.equal(classification.maxValueLength, 8);
    assert.equal((await request(`/value-list-definitions/${classification.objectId}/values`, 'POST', { value: 'x'.repeat(9) })).status, 400);
    const rolesList = definitions.find((item) => item.listName === 'userRole');
    const unsupportedRole = `role_${randomBytes(8).toString('hex')}`;
    const roleValue = await request(`/value-list-definitions/${rolesList.objectId}/values`, 'POST', { value: unsupportedRole });
    assert.equal(roleValue.status, 201);
    valueElementIds.push(roleValue.body.objectId);
    assert.equal(roleValue.body.supported, false);
    assert.equal((await request('/users', 'POST', { username: `${username}_unsupported`, password, roles: [unsupportedRole] })).status, 400);

    for (const invalidRoles of [[], ['not-a-role'], ['admin', 'admin']]) {
      assert.equal((await request('/users', 'POST', { username: `${username}_invalid`, password, roles: invalidRoles })).status, 400);
    }
    const adminToken = token;
    let handlerToken;
    const checks = [
      ['case:create', '/cases', 'POST', {}],
      ['record:create', '/records', 'POST', {}],
      ['case:update', `/cases/${randomUUID()}`, 'PUT', {}],
      ['record:update', `/records/${randomUUID()}`, 'PUT', {}],
      ['case:delete', `/cases/${randomUUID()}`, 'DELETE'],
      ['record:delete', `/records/${randomUUID()}`, 'DELETE'],
      ['relation:manage', '/relations', 'POST', {}],
      ['user:create', '/users', 'POST', {}],
      ['value-list:manage', '/value-list-definitions', 'POST', {}],
    ];
    for (const [index, assigned] of [['Koordinator'], ['Handläggare'], ['Beslutsfattare'], ['Handläggare', 'Koordinator']].entries()) {
      const newUsername = `${username}_${index}`;
      const newUser = await request('/users', 'POST', { username: newUsername, password, roles: assigned });
      assert.equal(newUser.status, 201);
      extraUserIds.push(newUser.body.id);
      token = '';
      const roleLogin = await request('/auth/login', 'POST', { username: newUsername, password });
      assert.equal(roleLogin.status, 200);
      token = roleLogin.body.token;
      if (assigned.length === 1 && assigned[0] === 'Handläggare') handlerToken = token;
      const expected = [...new Set(assigned.flatMap((role) => rolePermissions[role]))];
      assert.deepEqual(new Set((await request('/me')).body.permissions), new Set(expected));
      assert.equal((await request('/cases')).status, 200);
      for (const [permission, path, method, body] of checks) {
        const result = await request(path, method, body);
        assert.equal(result.status, expected.includes(permission) ? (method === 'DELETE' ? 404 : 400) : 403,
          `${assigned.join(', ')} ${permission}`);
      }
      token = adminToken;
    }
    const managedName = `${username}_managed`;
    const managed = await request('/users', 'POST', { username: managedName, password, roles: ['Handläggare'] });
    assert.equal(managed.status, 201);
    extraUserIds.push(managed.body.id);
    const users = await request('/users');
    assert.equal(users.status, 200);
    assert.deepEqual(users.body.find((item) => item.id === managed.body.id), managed.body);
    assert.equal(users.body.some((item) => 'password_hash' in item || 'password' in item), false);
    assert.equal((await request(`/users/${userId}`, 'DELETE')).status, 409);
    assert.equal((await request(`/users/${randomUUID()}`, 'DELETE')).status, 404);
    assert.equal((await request(`/users/${managed.body.id}`, 'PUT', {
      username: managedName, roles: [],
    })).status, 400);
    assert.equal((await request(`/users/${managed.body.id}`, 'PUT', {
      username, roles: ['Handläggare'],
    })).status, 409);
    token = handlerToken;
    assert.equal((await request('/value-list-definitions')).status, 403);
    assert.equal((await request('/value-list-definitions', 'POST', { listName: 'denied', listDescription: '' })).status, 403);
    assert.equal((await request(`/value-list-definitions/${createdList.body.objectId}`, 'PUT', { listDescription: 'denied' })).status, 403);
    assert.equal((await request(`/value-list-definitions/${createdList.body.objectId}/values`, 'POST', { value: 'denied' })).status, 403);
    assert.equal((await request('/users')).status, 403);
    assert.equal((await request(`/users/${managed.body.id}`, 'PUT', {
      username: managedName, roles: ['admin'],
    })).status, 403);
    assert.equal((await request(`/users/${managed.body.id}`, 'DELETE')).status, 403);
    token = '';
    const managedLogin = await request('/auth/login', 'POST', { username: managedName, password });
    assert.equal(managedLogin.status, 200);
    token = adminToken;
    assert.equal((await request(`/users/${managed.body.id}`, 'PUT', {
      username: managedName, roles: ['Koordinator'],
    })).status, 200);
    token = managedLogin.body.token;
    assert.ok((await request('/me')).body.permissions.includes('case:create'));
    token = adminToken;
    const replacementPassword = randomBytes(16).toString('hex');
    const renamed = `${managedName}_new`;
    const updatedUser = await request(`/users/${managed.body.id}`, 'PUT', {
      username: renamed, password: replacementPassword, roles: ['Koordinator', 'Handläggare'],
    });
    assert.deepEqual(updatedUser.body, { id: managed.body.id, username: renamed, roles: ['Koordinator', 'Handläggare'] });
    token = managedLogin.body.token;
    assert.equal((await request('/me')).status, 401);
    token = '';
    assert.equal((await request('/auth/login', 'POST', { username: renamed, password })).status, 401);
    const newLogin = await request('/auth/login', 'POST', { username: renamed, password: replacementPassword });
    assert.equal(newLogin.status, 200);
    token = adminToken;
    assert.equal((await request(`/users/${managed.body.id}`, 'DELETE')).status, 204);
    assert.equal((await request('/users')).body.some((item) => item.id === managed.body.id), false);
    token = newLogin.body.token;
    assert.equal((await request('/me')).status, 401);
    token = adminToken;
    const noRoleId = randomUUID();
    extraUserIds.push(noRoleId);
    await pool.execute('INSERT INTO cassis_users (id, username, password_hash) VALUES (?, ?, ?)',
      [noRoleId, `${username}_no_role`, await hashPassword(password)]);
    token = '';
    assert.equal((await request('/auth/login', 'POST', { username: `${username}_no_role`, password })).status, 403);
    token = adminToken;

    const caseData = { diaryNumber: username, classification: 'ABC', caseSentence: 'A case', extraclass: ['first', 'second'] };
    const created = await request('/cases', 'POST', caseData);
    assert.equal(created.status, 201);
    const caseId = created.body.objectId;
    objectIds.push(caseId);
    assert.deepEqual(created.body.extraclass, ['first', 'second']);
    assert.equal(created.body.classification_ValueList, 'classification');
    assert.equal(created.body.extraclass_ValueList, 'extraClass');
    const [extraReferences] = await pool.execute(
      'SELECT value_ValueList FROM case_extraclass WHERE caseId = ? ORDER BY position', [caseId],
    );
    assert.deepEqual(extraReferences.map((row) => row.value_ValueList), ['extraClass', 'extraClass']);
    await assert.rejects(pool.execute(
      'UPDATE base_case SET classification_ValueList = ? WHERE objectId = ?', ['other', caseId],
    ));
    assert.equal(created.body.createdBy, username);
    assert.equal(created.body.lastUpdatedBy, username);
    assert.equal((await request(`/cases/${caseId}`)).body.objectType, 'base_case');
    assert.equal((await request('/cases', 'POST', { ...caseData, diaryNumber: 'x'.repeat(21) })).status, 400);

    const updated = await request(`/cases/${caseId}`, 'PUT', { ...caseData, extraclass: ['unique-extraclass'] });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.extraclass, ['unique-extraclass']);
    assert.equal(updated.body.created, created.body.created);
    assert.equal(updated.body.lastUpdatedBy, username);
    const caseSearchResult = (await request('/search?q=unique-extraclass')).body.find((row) => row.objectId === caseId);
    assert.equal(caseSearchResult.objectType, 'base_case');
    assert.equal(caseSearchResult.created, created.body.created);
    assert.equal(caseSearchResult.createdBy, username);
    assert.equal(caseSearchResult.diaryNumber, caseData.diaryNumber);
    assert.equal(caseSearchResult.caseSentence, caseData.caseSentence);
    assert.equal(caseSearchResult.name, null);
    assert.equal(caseSearchResult.recordType, null);

    token = handlerToken;
    assert.equal((await request('/cases', 'POST', caseData)).status, 403);
    const handlerRecord = await request('/records', 'POST', {
      caseId, name: 'Handler test', description: '', recordType: '',
    });
    assert.equal(handlerRecord.status, 201);
    objectIds.push(handlerRecord.body.objectId);
    assert.equal((await request(`/records/${handlerRecord.body.objectId}`, 'DELETE')).status, 403);
    token = adminToken;
    assert.equal((await request(`/records/${handlerRecord.body.objectId}`, 'DELETE')).status, 204);

    const secondCase = await request('/cases', 'POST', { ...caseData, diaryNumber: 'second-case' });
    assert.equal(secondCase.status, 201);
    const secondCaseId = secondCase.body.objectId;
    objectIds.push(secondCaseId);

    const recordData = { caseId, name: username, description: 'A record', recordType: 'document' };
    assert.equal((await request('/records', 'POST', { ...recordData, caseId: randomUUID() })).status, 404);
    const record = await request('/records', 'POST', recordData);
    assert.equal(record.status, 201);
    assert.equal(record.body.recordType_ValueList, 'recordType');
    const recordId = record.body.objectId;
    objectIds.push(recordId);
    assert.equal((await request(`/records/${recordId}`)).body.caseId, caseId);
    let parentRelation = (await request('/relations')).body.find((row) => row.id === recordId);
    assert.deepEqual(parentRelation, {
      id: recordId, sourceId: caseId, targetId: recordId, objectTypes: 'base_case-base_record', relationType: 'parent-child', automatic: true,
    });
    assert.equal((await request(`/relations/${recordId}`, 'DELETE')).status, 409);
    assert.equal((await request(`/relations/${recordId}`, 'PUT', {
      sourceId: caseId, targetId: recordId, relationType: 'related',
    })).status, 409);
    assert.equal((await request('/relations', 'POST', {
      sourceId: caseId, targetId: recordId, relationType: 'PARENT-CHILD ',
    })).status, 400);

    await pool.execute('DELETE FROM cassis_relations WHERE id = ?', [recordId]);
    const conflictingId = randomUUID();
    await pool.execute('INSERT INTO cassis_relations (id, sourceId, targetId, objectTypes, relationType) VALUES (?, ?, ?, ?, ?)',
      [conflictingId, caseId, recordId, 'base_case-base_record', 'parent-child']);
    await assert.rejects(ensureParentRelation(pool, caseId, recordId), /Conflicting relation/);
    assert.equal((await request('/relations')).body.some((row) => row.id === conflictingId), true);
    await pool.execute('DELETE FROM cassis_relations WHERE id = ?', [conflictingId]);
    assert.equal(await ensureParentRelation(pool, caseId, recordId), true);
    assert.equal(await ensureParentRelation(pool, caseId, recordId), false);

    await pool.execute('UPDATE cassis_relations SET sourceId = ? WHERE id = ?', [secondCaseId, recordId]);
    assert.equal((await request(`/records/${recordId}`)).body.caseId, secondCaseId);
    assert.equal((await request(`/search?q=${secondCaseId}`)).body.some((row) => row.objectId === recordId), true);
    await pool.execute('UPDATE cassis_relations SET sourceId = ? WHERE id = ?', [caseId, recordId]);

    const changed = await request(`/records/${recordId}`, 'PUT', { ...recordData, description: 'Updated record' });
    assert.equal(changed.body.description, 'Updated record');
    assert.equal((await request(`/records/${recordId}`, 'PUT', { ...recordData, description: 'Updated record', caseId: secondCaseId })).status, 200);
    parentRelation = (await request('/relations')).body.find((row) => row.id === recordId);
    assert.equal(parentRelation.sourceId, secondCaseId);
    assert.equal(parentRelation.targetId, recordId);
    assert.equal(parentRelation.objectTypes, 'base_case-base_record');
    assert.equal((await request(`/records/${recordId}`, 'PUT', { ...recordData, description: 'Updated record' })).status, 200);
    assert.equal((await request('/relations')).body.find((row) => row.id === recordId).sourceId, caseId);
    assert.equal((await request(`/cases/${secondCaseId}`, 'DELETE')).status, 204);
    assert.equal((await request(`/records/${recordId}`)).body.caseId, caseId);
    const recordSearchResult = (await request('/search?q=Updated%20record')).body.find((row) => row.objectId === recordId);
    assert.equal(recordSearchResult.objectType, 'base_record');
    assert.equal(recordSearchResult.created, record.body.created);
    assert.equal(recordSearchResult.createdBy, username);
    assert.equal(recordSearchResult.diaryNumber, null);
    assert.equal(recordSearchResult.caseSentence, null);
    assert.equal(recordSearchResult.name, recordData.name);
    assert.equal(recordSearchResult.recordType, recordData.recordType);
    assert.equal((await request(`/search?q=${encodeURIComponent(username)}`)).body.some((row) =>
      row.objectId === caseId), true);

    const relation = await request('/relations', 'POST', { sourceId: caseId, targetId: recordId, relationType: 'related' });
    assert.equal(relation.status, 201);
    assert.equal(relation.body.objectTypes, 'base_case-base_record');
    assert.equal((await request('/relations', 'POST', { sourceId: caseId, targetId: recordId, relationType: 'related' })).status, 409);
    assert.equal((await request('/relations')).body.some((row) => row.id === relation.body.id), true);
    const duplicateTarget = await request('/relations', 'POST', { sourceId: caseId, targetId: recordId, relationType: 'other' });
    assert.equal(duplicateTarget.status, 201);
    assert.equal((await request(`/relations/${duplicateTarget.body.id}`, 'PUT',
      { sourceId: caseId, targetId: recordId, relationType: 'related' })).status, 409);
    assert.equal((await request('/relations')).body.find((row) => row.id === duplicateTarget.body.id).relationType, 'other');
    assert.equal((await request(`/relations/${duplicateTarget.body.id}`, 'DELETE')).status, 204);
    const changedRelation = await request(`/relations/${relation.body.id}`, 'PUT',
      { sourceId: recordId, targetId: caseId, relationType: 'changed', objectTypes: 'incorrect' });
    assert.equal(changedRelation.status, 200);
    assert.equal(changedRelation.body.objectTypes, 'base_record-base_case');
    const [persistedRelation] = await pool.execute('SELECT objectTypes FROM cassis_relations WHERE id = ?', [relation.body.id]);
    assert.equal(persistedRelation[0].objectTypes, 'base_record-base_case');
    assert.equal((await request(`/relations/${relation.body.id}`, 'PUT',
      { sourceId: randomUUID(), targetId: caseId, relationType: 'changed' })).status, 404);
    assert.equal((await request(`/relations/${relation.body.id}`, 'PUT',
      { sourceId: recordId, targetId: caseId, relationType: 'parent-child' })).status, 400);
    token = handlerToken;
    assert.equal((await request(`/relations/${relation.body.id}`, 'PUT',
      { sourceId: caseId, targetId: recordId, relationType: 'changed' })).status, 403);
    token = adminToken;
    assert.equal((await request(`/relations/${relation.body.id}`, 'DELETE')).status, 204);
    const cascadeRelation = await request('/relations', 'POST', { sourceId: recordId, targetId: caseId });
    assert.equal(cascadeRelation.status, 201);
    const extraRecord = await request('/records', 'POST', recordData);
    assert.equal(extraRecord.status, 201);
    objectIds.push(extraRecord.body.objectId);
    assert.equal((await request(`/records/${extraRecord.body.objectId}`, 'DELETE')).status, 204);
    assert.equal((await request(`/records/${extraRecord.body.objectId}`)).status, 404);
    assert.equal((await request('/relations')).body.some((row) => row.id === extraRecord.body.objectId), false);
    assert.equal((await request(`/cases/${caseId}`, 'DELETE')).status, 204);
    assert.equal((await request(`/records/${recordId}`)).status, 404);
    assert.equal((await request('/relations')).body.some((row) => row.id === cascadeRelation.body.id), false);
    assert.equal((await request('/relations')).body.some((row) => row.id === recordId), false);
    assert.equal((await request('/auth/logout', 'POST')).status, 204);
    assert.equal((await request('/cases')).status, 401);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const id of valueElementIds) await pool.execute('DELETE FROM cassis_objects WHERE objectId = ?', [id]);
    for (const id of valueListIds) await pool.execute('DELETE FROM cassis_objects WHERE objectId = ?', [id]);
    for (const objectId of objectIds.reverse()) {
      await pool.execute('DELETE FROM cassis_objects WHERE objectId = ?', [objectId]);
    }
    for (const id of extraUserIds) await pool.execute('DELETE FROM cassis_users WHERE id = ?', [id]);
    if (userId) await pool.execute('DELETE FROM cassis_users WHERE id = ?', [userId]);
    pool.getConnection = originalGetConnection;
    await pool.end();
  }
});
