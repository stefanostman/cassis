require('dotenv').config({ quiet: true });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/migrate-relation-object-types');

function connectionFor(columns, invalid = []) {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(sql);
      if (sql.includes('information_schema.COLUMNS')) return [columns];
      if (sql.startsWith('SELECT r.id')) return [invalid];
      return [[]];
    },
  };
}

test('adds, populates and enforces the relation object type column', async () => {
  const connection = connectionFor([]);
  await migrate(connection);
  assert.ok(connection.statements.some((sql) => sql.includes('ADD COLUMN objectTypes VARCHAR(101) NULL')));
  assert.ok(connection.statements.some((sql) => sql.includes("CONCAT(s.objectType, '-', t.objectType)")));
  assert.ok(connection.statements.some((sql) => sql.includes('MODIFY COLUMN objectTypes VARCHAR(101) NOT NULL')));
});

test('resumes a partial migration but refuses inconsistent relation types', async () => {
  const column = { DATA_TYPE: 'varchar', CHARACTER_MAXIMUM_LENGTH: 101, IS_NULLABLE: 'YES' };
  const connection = connectionFor([column], [{ id: 'bad-relation' }]);
  await assert.rejects(migrate(connection), /inconsistent object types/);
  assert.equal(connection.statements.some((sql) => sql.includes('MODIFY COLUMN')), false);
  const alreadyComplete = connectionFor([{ ...column, IS_NULLABLE: 'NO' }]);
  await migrate(alreadyComplete);
  assert.equal(alreadyComplete.statements.some((sql) => sql.includes('ALTER TABLE')), false);
});
