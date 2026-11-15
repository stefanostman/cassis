require('dotenv').config({ quiet: true });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../src/db');
const app = require('../src/server');
const { createUser, rolePermissions } = require('../src/roles');
const { createParentRelation } = require('../src/parent-relations');

test('imports documents, validates uploads and protects their parent records', async () => {
  const username = `doc_test_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(16).toString('hex');
  const caseId = randomUUID();
  const recordId = randomUUID();
  const roleElementId = randomUUID();
  const documentType = `test_${randomBytes(6).toString('hex')}`;
  const storedDocuments = [];
  let userId;
  let server;
  const originalPermissions = rolePermissions.Beslutsfattare;
  try {
    const user = await createUser(pool, username, password, ['Beslutsfattare']);
    userId = user.id;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[list]] = await connection.execute('SELECT objectId FROM cassis_valuelists WHERE BINARY listName = BINARY ?', ['documentType']);
      assert.ok(list, 'Run npm run setup before the document tests');
      for (const [objectId, objectType] of [[caseId, 'base_case'], [recordId, 'base_record'], [roleElementId, 'cassis_valuelistelement']]) {
        await connection.execute('INSERT INTO cassis_objects VALUES (?, ?, UTC_TIMESTAMP(3), ?, UTC_TIMESTAMP(3), ?)',
          [objectId, objectType, username, username]);
      }
      await connection.execute('INSERT INTO base_case (objectId, diaryNumber, classification, caseSentence) VALUES (?, ?, ?, ?)',
        [caseId, 'DOC-TEST', '', '']);
      await connection.execute('INSERT INTO base_record (objectId, name, description, recordType) VALUES (?, ?, ?, ?)',
        [recordId, 'Handling', '', '']);
      await createParentRelation(connection, caseId, recordId);
      await connection.execute('INSERT INTO cassis_valuelistelements (objectId, listId, value) VALUES (?, ?, ?)',
        [roleElementId, list.objectId, documentType]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    async function request(url, method = 'GET', body) {
      const headers = { Authorization: `Bearer ${token}` };
      if (typeof body === 'string') headers['Content-Type'] = 'application/json';
      const response = await fetch(base + url, { method, headers, body });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    }
    function form(filename, content, type = documentType) {
      const result = new FormData();
      if (filename) result.append('file', new Blob([content]), filename);
      result.append('name', 'Dokument');
      result.append('documentType', type);
      return result;
    }

    assert.equal((await request(`/records/${recordId}/documents`, 'POST', form('fel.exe', 'data'))).status, 400);
    assert.equal((await request(`/records/${recordId}/documents`, 'POST', form(null, 'data'))).status, 400);
    assert.equal((await request(`/records/${recordId}/documents`, 'POST', form('fil.pdf', 'data', 'okänd'))).status, 400);
    assert.equal((await request(`/records/${randomUUID()}/documents`, 'POST', form('fil.pdf', 'data'))).status, 404);
    assert.equal((await request(`/records/${recordId}/documents`, 'POST', form(`${'a'.repeat(252)}.pdf`, 'data'))).status, 400);
    rolePermissions.Beslutsfattare = ['read'];
    assert.equal((await request(`/records/${recordId}/documents`, 'POST', form('fil.pdf', 'data'))).status, 403);
    rolePermissions.Beslutsfattare = originalPermissions;

    const originalFilename = 'räkning 📄.PDF';
    const result = await request(`/records/${recordId}/documents`, 'POST', form(originalFilename, 'filinnehåll'));
    assert.equal(result.status, 201);
    storedDocuments.push(result.body);
    assert.equal(result.body.recordId, recordId);
    assert.equal(result.body.objectType, 'base_document');
    assert.equal(result.body.documentType, documentType);
    assert.equal(result.body.filetype, 'PDF');
    assert.equal(result.body.filename, `${result.body.objectId}.PDF`);
    assert.equal(result.body.originalFilename, originalFilename);
    assert.equal(result.body.filesize, Buffer.byteLength('filinnehåll'));
    assert.equal(result.body.createdBy, username);
    const directory = path.resolve(__dirname, '..', '..', 'importerade dokument');
    assert.equal(await fs.readFile(path.join(directory, result.body.filename), 'utf8'), 'filinnehåll');
    const listed = (await request('/documents')).body.find((item) => item.objectId === result.body.objectId);
    assert.equal(listed.originalFilename, originalFilename);
    const [[saved]] = await pool.execute('SELECT originalFilename FROM base_document WHERE objectId = ?', [result.body.objectId]);
    assert.equal(saved.originalFilename, originalFilename);

    for (const query of ['Dokument', documentType, 'PDF', String(result.body.filesize), result.body.filename, 'RÄKNING', originalFilename, recordId, username]) {
      const search = await request(`/search?q=${encodeURIComponent(query)}`);
      assert.equal(search.status, 200);
      const match = search.body.find((item) => item.objectId === result.body.objectId);
      assert.ok(match, `Document should match ${query}`);
      assert.equal(match.objectType, 'base_document');
      assert.equal(match.name, result.body.name);
      assert.equal(match.recordId, recordId);
      assert.equal(match.documentType, documentType);
      assert.equal(match.filetype, 'PDF');
      assert.equal(match.filesize, result.body.filesize);
      assert.equal(match.filename, result.body.filename);
      assert.equal(match.originalFilename, originalFilename);
    }

    const maxSize = 25 * 1024 * 1024;
    const maxLengthFilename = `${'a'.repeat(250)}.xlsx`;
    const atLimit = await request(`/records/${recordId}/documents`, 'POST', form(maxLengthFilename, new Uint8Array(maxSize)));
    assert.equal(atLimit.status, 201);
    storedDocuments.push(atLimit.body);
    assert.equal(atLimit.body.originalFilename, maxLengthFilename);
    assert.equal((await fs.stat(path.join(directory, atLimit.body.filename))).size, maxSize);
    assert.equal((await request(`/records/${recordId}/documents`, 'POST',
      form('large.pdf', new Uint8Array(maxSize + 1)))).status, 413);

    rolePermissions.Beslutsfattare = [...originalPermissions, 'case:delete', 'record:delete'];
    assert.equal((await request(`/records/${recordId}`, 'DELETE')).status, 409);
    assert.equal((await request(`/cases/${caseId}`, 'DELETE')).status, 409);
    assert.ok((await request('/documents')).body.some((item) => item.objectId === result.body.objectId));
    rolePermissions.Beslutsfattare = ['read'];
    assert.equal((await request(`/documents/${result.body.objectId}`, 'PUT', JSON.stringify({ name: 'Ändrat' }))).status, 403);
    assert.equal((await request(`/documents/${result.body.objectId}`, 'DELETE')).status, 403);
    rolePermissions.Beslutsfattare = originalPermissions;
    assert.equal((await request(`/documents/${result.body.objectId}`, 'PUT', JSON.stringify({ name: 'Ändrat', filename: 'annat.pdf' }))).status, 400);
    assert.equal((await request(`/documents/${result.body.objectId}`, 'PUT', JSON.stringify({ name: '  ' }))).status, 400);
    const updated = await request(`/documents/${result.body.objectId}`, 'PUT', JSON.stringify({ name: 'Ändrat namn' }));
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Ändrat namn');
    const [[afterEdit]] = await pool.execute('SELECT name, originalFilename FROM base_document WHERE objectId = ?', [result.body.objectId]);
    assert.equal(afterEdit.name, 'Ändrat namn');
    assert.equal(afterEdit.originalFilename, originalFilename);
    assert.ok((await request('/search?q=%C3%84ndrat')).body.some((item) => item.objectId === result.body.objectId));
    assert.equal((await request('/search?q=Dokument')).body.some((item) => item.objectId === result.body.objectId), false);

    const download = await fetch(`${base}/documents/${result.body.objectId}/content`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type'), /^application\/pdf/);
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.ok(download.headers.get('content-disposition').includes(encodeURIComponent(originalFilename)));
    assert.equal(await download.text(), 'filinnehåll');
    const open = await fetch(`${base}/documents/${result.body.objectId}/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }),
    });
    assert.equal(open.status, 200);
    assert.match(open.headers.get('content-disposition'), /^inline;/);
    assert.ok(open.headers.get('content-disposition').includes(encodeURIComponent(originalFilename)));
    assert.equal(await open.text(), 'filinnehåll');
    const noToken = await fetch(`${base}/documents/${result.body.objectId}/open`, { method: 'POST' });
    assert.equal(noToken.status, 401);

    await pool.execute('UPDATE base_document SET originalFilename = NULL, name = ? WHERE objectId = ?', ['Visa/namn.xlsx', atLimit.body.objectId]);
    assert.ok((await request('/search?q=Visa%2Fnamn')).body.some((item) => item.objectId === atLimit.body.objectId && item.originalFilename === null));
    const legacy = await fetch(`${base}/documents/${atLimit.body.objectId}/content`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(legacy.status, 200);
    assert.match(legacy.headers.get('content-disposition'), /Visa_namn\.xlsx/);
    await legacy.arrayBuffer();
    const originalGetConnection = pool.getConnection;
    const originalConsoleError = console.error;
    try {
      pool.getConnection = async function () {
        const connection = await originalGetConnection.call(pool);
        const execute = connection.execute;
        const release = connection.release;
        connection.execute = function (sql, params) {
          if (sql === 'DELETE FROM cassis_objects WHERE objectId = ?') throw new Error('Simulated delete failure');
          return execute.call(connection, sql, params);
        };
        connection.release = function () {
          connection.execute = execute;
          connection.release = release;
          return release.call(connection);
        };
        return connection;
      };
      console.error = () => {};
      assert.equal((await request(`/documents/${result.body.objectId}`, 'DELETE')).status, 500);
    } finally {
      pool.getConnection = originalGetConnection;
      console.error = originalConsoleError;
    }
    assert.equal(await fs.readFile(path.join(directory, result.body.filename), 'utf8'), 'filinnehåll');
    assert.ok((await request('/documents')).body.some((item) => item.objectId === result.body.objectId));
    for (const document of [...storedDocuments]) {
      assert.equal((await request(`/documents/${document.objectId}`, 'DELETE')).status, 204);
      storedDocuments.splice(storedDocuments.indexOf(document), 1);
      await assert.rejects(fs.stat(path.join(directory, document.filename)), { code: 'ENOENT' });
    }
    assert.equal((await request(`/documents/${result.body.objectId}`, 'DELETE')).status, 404);
    assert.equal((await request(`/search?q=${encodeURIComponent(originalFilename)}`)).body.some((item) => item.objectId === result.body.objectId), false);
    rolePermissions.Beslutsfattare = [...originalPermissions, 'case:delete', 'record:delete'];
    assert.equal((await request(`/records/${recordId}`, 'DELETE')).status, 204);
  } finally {
    rolePermissions.Beslutsfattare = originalPermissions;
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const document of storedDocuments) {
      await pool.execute('DELETE FROM cassis_objects WHERE objectId = ?', [document.objectId]);
      await fs.unlink(path.resolve(__dirname, '..', '..', 'importerade dokument', document.filename));
    }
    await pool.execute('DELETE FROM cassis_objects WHERE objectId IN (?, ?, ?)', [recordId, caseId, roleElementId]);
    if (userId) await pool.execute('DELETE FROM cassis_users WHERE id = ?', [userId]);
    await pool.end();
  }
});
