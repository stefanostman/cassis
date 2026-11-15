const { rolePermissions } = require('./roles');

async function getValueListBindings(connection) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_DEFAULT FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND (
       (TABLE_NAME = 'base_case' AND COLUMN_NAME IN ('classification_ValueList', 'extraclass_ValueList'))
       OR (TABLE_NAME = 'case_extraclass' AND COLUMN_NAME = 'value_ValueList')
       OR (TABLE_NAME = 'base_record' AND COLUMN_NAME = 'recordType_ValueList')
     )`,
  );
  function reference(table, column) {
    const row = rows.find((item) => item.TABLE_NAME === table && item.COLUMN_NAME === column);
    if (!row || typeof row.COLUMN_DEFAULT !== 'string' || !row.COLUMN_DEFAULT) {
      throw new Error(`Missing value-list reference for ${table}.${column}; run the value-list reference migration`);
    }
    return row.COLUMN_DEFAULT;
  }
  const classification = reference('base_case', 'classification_ValueList');
  const extraclass = reference('base_case', 'extraclass_ValueList');
  const extraValue = reference('case_extraclass', 'value_ValueList');
  if (extraclass !== extraValue) throw new Error('Extraclass value-list references do not match');
  return {
    base_case: { classification, extraclass },
    base_record: { recordType: reference('base_record', 'recordType_ValueList') },
  };
}

async function validateValueLists(connection, data, bindings) {
  const entries = Object.entries(bindings);
  const listNames = entries.map(([, listName]) => listName);
  const placeholders = listNames.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT l.listName, e.value FROM cassis_valuelists l
     JOIN cassis_valuelistelements e ON e.listId = l.objectId WHERE l.listName IN (${placeholders})`,
    listNames,
  );
  const lists = new Map();
  for (const { listName, value } of rows) {
    if (!lists.has(listName)) lists.set(listName, new Set());
    lists.get(listName).add(value);
  }
  for (const [field, listName] of entries) {
    const input = data[field];
    const allowed = lists.get(listName);
    if (allowed && (Array.isArray(input) ? input : [input]).some((value) => !allowed.has(value))) {
      const error = new Error(`${field} must contain only values from ${listName}`);
      error.status = 400;
      throw error;
    }
  }
}

function valueListConstraints(listName, bindings) {
  const fields = [
    { listName: bindings.base_case.classification, field: 'base_case.classification', max: 8 },
    { listName: bindings.base_case.extraclass, field: 'base_case.extraclass', max: 50 },
    { listName: bindings.base_record.recordType, field: 'base_record.recordType', max: 100 },
  ].filter((entry) => entry.listName === listName);
  return {
    boundFields: fields.map((entry) => entry.field),
    maxValueLength: Math.min(255, ...fields.map((entry) => entry.max)),
  };
}

function valueListElement(objectId, value, listName) {
  return {
    objectId,
    value,
    supported: listName !== 'userRole' || Object.hasOwn(rolePermissions, value),
  };
}

async function listValueListDefinitions(connection) {
  const bindings = await getValueListBindings(connection);
  const [rows] = await connection.execute(
    `SELECT l.objectId, l.listName, l.listDescription, e.objectId AS elementId, e.value
     FROM cassis_valuelists l LEFT JOIN cassis_valuelistelements e ON e.listId = l.objectId`,
  );
  const lists = new Map();
  for (const row of rows) {
    if (!lists.has(row.objectId)) {
      lists.set(row.objectId, {
        objectId: row.objectId, listName: row.listName, listDescription: row.listDescription,
        ...valueListConstraints(row.listName, bindings), values: [],
      });
    }
    if (row.elementId !== null) lists.get(row.objectId).values.push(valueListElement(row.elementId, row.value, row.listName));
  }
  const result = [...lists.values()];
  for (const list of result) list.values.sort((a, b) => a.value.localeCompare(b.value, 'sv'));
  return result.sort((a, b) => a.listName.localeCompare(b.listName, 'sv'));
}

module.exports = { getValueListBindings, validateValueLists, valueListConstraints, valueListElement, listValueListDefinitions };

