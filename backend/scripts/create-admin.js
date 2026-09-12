const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { readUsers, writeUsers, toPublic } = require("../src/lib/auth");

async function main() {
  const username = process.env.ADMIN_USERNAME || process.argv[2];
  const password = process.env.ADMIN_PASSWORD || process.argv[3];
  if (!username || !password) {
    console.error("usage: ADMIN_USERNAME=admin ADMIN_PASSWORD=secret npm run create-admin");
    process.exit(1);
  }
  const rows = readUsers();
  if (rows.find((u) => u.username === username)) {
    console.error(`user ${username} already exists`);
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(String(password), 10);
  const user = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    username,
    passwordHash,
    role: "admin",
    createdAt: new Date().toISOString(),
  };
  rows.push(user);
  writeUsers(rows);
  console.log(JSON.stringify(toPublic(user)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
