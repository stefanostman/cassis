require('dotenv').config({ quiet: true });

const pool = require('./db');
const { createUser: createUserWithRoles } = require('./roles');

async function createUser() {
  const username = process.argv[2];
  const password = process.env.CASSIS_NEW_PASSWORD;
  const roles = process.argv.slice(3);
  await createUserWithRoles(pool, username, password, roles);
  console.log(`Created user ${username}.`);
}

createUser().catch((error) => {
  console.error('Could not create user:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
