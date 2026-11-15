const PARENT_RELATION_TYPE = 'parent-child';

async function createParentRelation(connection, caseId, recordId) {
  // The record ID identifies its system-managed parent relation.
  await connection.execute(
    'INSERT INTO cassis_relations (id, sourceId, targetId, objectTypes, relationType) VALUES (?, ?, ?, ?, ?)',
    [recordId, caseId, recordId, 'base_case-base_record', PARENT_RELATION_TYPE],
  );
}

async function ensureParentRelation(connection, caseId, recordId) {
  const [rows] = await connection.execute(
    `SELECT id, sourceId, targetId, relationType FROM cassis_relations
     WHERE id = ? OR (sourceId = ? AND targetId = ? AND relationType = ?)`,
    [recordId, caseId, recordId, PARENT_RELATION_TYPE],
  );
  if (rows.length === 0) {
    await createParentRelation(connection, caseId, recordId);
    return true;
  }
  const relation = rows[0];
  if (rows.length !== 1 || relation.id.toLowerCase() !== recordId.toLowerCase()
      || relation.sourceId.toLowerCase() !== caseId.toLowerCase()
      || relation.targetId.toLowerCase() !== recordId.toLowerCase()
      || relation.relationType !== PARENT_RELATION_TYPE) {
    throw new Error(`Conflicting relation for record ${recordId}; existing relations were not changed`);
  }
  return false;
}

module.exports = { PARENT_RELATION_TYPE, createParentRelation, ensureParentRelation };
