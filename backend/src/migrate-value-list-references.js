require('dotenv').config({ quiet: true });

const pool = require('./db');

const references = [
  { table: 'base_case', column: 'classification_ValueList', list: 'classification', previous: ['classification_ValueList'], constraint: 'chk_case_classification_list' },
  { table: 'base_case', column: 'extraclass_ValueList', list: 'extraClass', previous: ['extraclass', 'extraclass_ValueList', 'extraClass_ValueList'], constraint: 'chk_case_extraclass_list' },
  { table: 'case_extraclass', column: 'value_ValueList', list: 'extraClass', previous: ['extraclass', 'extraclass_ValueList', 'extraClass_ValueList'], constraint: 'chk_extra_value_list' },
  { table: 'base_record', column: 'recordType_ValueList', list: 'recordType', previous: ['recordType_ValueList'], constraint: 'chk_record_type_list' },
];
const lists = [references[0], references[1], references[3]];

function expectedCheck(column, list) {
  return `(cast(\`${column}\` as char charset binary) = cast(_utf8mb4'${list}' as char charset binary))`;
}

async function checkListNames(connection, lock = false) {
  for (const { list, previous } of lists) {
    const names = [list, ...previous];
    const [rows] = await connection.execute(
      `SELECT listName FROM cassis_valuelists WHERE BINARY listName IN (${names.map(() => 'BINARY ?').join(', ')})${lock ? ' FOR UPDATE' : ''}`,
      names,
    );
    if (new Set(rows.map((row) => row.listName)).size > 1) {
      throw new Error(`Multiple versions of ${list} contain values; resolve the conflict before migration`);
    }
  }
}

async function migrate() {
  const connection = await pool.getConnection();
  try {
    const [newSchema] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'cassis_valuelists' AND COLUMN_NAME = 'objectId'`,
    );
    if (newSchema.length) throw new Error('This older migration cannot run after value lists become objects');
    const [oldTables] = await connection.execute(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'valuelists'`,
    );
    if (oldTables.length) {
      const [oldRows] = await connection.query('SELECT 1 FROM valueLists LIMIT 1');
      if (oldRows.length) throw new Error('The previous valueLists table is not empty; review its data before switching tables');
    }
    await checkListNames(connection);
    const changes = [];
    for (const ref of references) {
      const { table, column, list, previous, constraint } = ref;
      const allowed = [list, ...previous];
      const [columns] = await connection.execute(
        `SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column],
      );
      const existing = columns[0];
      const legacy = existing && table === 'base_case' && column === 'classification_ValueList'
        && existing.DATA_TYPE === 'varchar' && existing.CHARACTER_MAXIMUM_LENGTH === 45
        && existing.IS_NULLABLE === 'YES' && [null, ...allowed].includes(existing.COLUMN_DEFAULT);
      if (existing && !legacy && (existing.DATA_TYPE !== 'varchar' || existing.CHARACTER_MAXIMUM_LENGTH !== 100
        || existing.IS_NULLABLE !== 'NO' || !allowed.includes(existing.COLUMN_DEFAULT)
        || existing.COLLATION_NAME !== 'utf8mb4_bin')) {
        throw new Error(`Existing ${table}.${column} has an incompatible definition`);
      }
      if (existing) {
        const [conflicts] = await connection.execute(
          `SELECT 1 FROM \`${table}\` WHERE \`${column}\` IS NOT NULL
           AND BINARY \`${column}\` NOT IN (${allowed.map(() => 'BINARY ?').join(', ')}) LIMIT 1`,
          allowed,
        );
        if (conflicts.length) throw new Error(`Existing ${table}.${column} values conflict with ${list}`);
      }
      const [constraints] = await connection.execute(
        `SELECT tc.CONSTRAINT_TYPE, tc.ENFORCED, cc.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS tc
         LEFT JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
           AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
         WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_NAME = ?`,
        [table, constraint],
      );
      let check = '';
      if (constraints.length) {
        const found = constraints[0];
        if (found.CONSTRAINT_TYPE !== 'CHECK' || found.ENFORCED !== 'YES' || typeof found.CHECK_CLAUSE !== 'string') {
          throw new Error(`Existing constraint ${constraint} has an incompatible definition`);
        }
        check = found.CHECK_CLAUSE.replace(/\\'/g, "'");
        if (!allowed.some((name) => check === expectedCheck(column, name))) {
          throw new Error(`Existing constraint ${constraint} has an incompatible definition`);
        }
      }
      changes.push({ ...ref, existing, legacy, check });
    }

    for (const { table, column, list, previous, constraint, existing, legacy, check } of changes) {
      if (check && check !== expectedCheck(column, list)) {
        await connection.query(`ALTER TABLE \`${table}\` DROP CHECK \`${constraint}\``);
      }
      if (!existing) {
        await connection.query(
          `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` VARCHAR(100)
           CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '${list}'`,
        );
      } else {
        await connection.execute(
          `UPDATE \`${table}\` SET \`${column}\` = ?
           WHERE BINARY \`${column}\` IN (${previous.map(() => 'BINARY ?').join(', ')})${legacy ? ` OR \`${column}\` IS NULL` : ''}`,
          [list, ...previous],
        );
        if (legacy || existing.COLUMN_DEFAULT !== list) {
          await connection.query(
            `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` VARCHAR(100)
             CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '${list}'`,
          );
        }
      }
      if (check !== expectedCheck(column, list)) {
        await connection.query(
          `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraint}\` CHECK (BINARY \`${column}\` = BINARY '${list}')`,
        );
      }
    }

    await connection.beginTransaction();
    try {
      await checkListNames(connection, true);
      for (const { list, previous } of lists) {
        for (const oldName of previous) {
          await connection.execute('UPDATE cassis_valuelists SET listName = ? WHERE BINARY listName = BINARY ?', [list, oldName]);
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log('Value-list references and list names are ready.');
  } finally {
    connection.release();
  }
}

migrate().catch((error) => {
  console.error('Value-list reference migration failed:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
