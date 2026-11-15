const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getValueListBindings, validateValueLists, valueListConstraints, valueListElement } = require('../src/value-lists');

test('validates configured single and multivalue fields without restricting other fields', async () => {
  const connection = {
    async execute(sql, names) {
      assert.match(sql, /SELECT l.listName, e.value FROM cassis_valuelists/);
      assert.deepEqual(names, ['classes', 'extra']);
      return [[
        { listName: 'classes', value: 'A' },
        { listName: 'classes', value: 'B' },
        { listName: 'extra', value: 'ett' },
        { listName: 'extra', value: 'två' },
      ]];
    },
  };
  const bindings = { classification: 'classes', extraclass: 'extra' };
  await validateValueLists(connection, { classification: 'A', extraclass: ['ett', 'två'], caseSentence: 'Fritt' }, bindings);
  await validateValueLists(connection, { classification: 'B', extraclass: [], caseSentence: '' }, bindings);
  await assert.rejects(
    validateValueLists(connection, { classification: 'a', extraclass: [], caseSentence: 'Fritt' }, bindings),
    (error) => error.status === 400 && error.message.includes('classes'),
  );
  await assert.rejects(
    validateValueLists(connection, { classification: 'A', extraclass: ['ett', 'gammalt'], caseSentence: 'Fritt' }, bindings),
    (error) => error.status === 400 && error.message.includes('extra'),
  );
});

test('reads explicit column defaults and rejects inconsistent extraclass references', async () => {
  const rows = [
    { TABLE_NAME: 'base_case', COLUMN_NAME: 'classification_ValueList', COLUMN_DEFAULT: 'classes' },
    { TABLE_NAME: 'base_case', COLUMN_NAME: 'extraclass_ValueList', COLUMN_DEFAULT: 'extra' },
    { TABLE_NAME: 'case_extraclass', COLUMN_NAME: 'value_ValueList', COLUMN_DEFAULT: 'extra' },
    { TABLE_NAME: 'base_record', COLUMN_NAME: 'recordType_ValueList', COLUMN_DEFAULT: 'types' },
    { TABLE_NAME: 'base_document', COLUMN_NAME: 'documentType_ValueList', COLUMN_DEFAULT: 'documents' },
  ];
  const connection = { execute: async () => [rows] };
  assert.deepEqual(await getValueListBindings(connection), {
    base_case: { classification: 'classes', extraclass: 'extra' },
    base_record: { recordType: 'types' },
    base_document: { documentType: 'documents' },
  });

  rows[2].COLUMN_DEFAULT = 'other';
  await assert.rejects(getValueListBindings(connection), /do not match/);
});

test('limits shared lists to the strictest bound field and marks unsupported roles', () => {
  const bindings = {
    base_case: { classification: 'shared', extraclass: 'shared' },
    base_record: { recordType: 'other' },
    base_document: { documentType: 'other' },
  };
  assert.deepEqual(valueListConstraints('shared', bindings), {
    boundFields: ['base_case.classification', 'base_case.extraclass'], maxValueLength: 8,
  });
  assert.equal(valueListConstraints('unused', bindings).maxValueLength, 255);
  assert.equal(valueListElement('1', 'admin', 'userRole').supported, true);
  assert.equal(valueListElement('2', 'Ny roll', 'userRole').supported, false);
  assert.equal(valueListElement('3', 'Ny roll', 'other').supported, true);
});
