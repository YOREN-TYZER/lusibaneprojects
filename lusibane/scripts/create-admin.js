'use strict';
// Usage: node scripts/create-admin.js "Full Name" email@example.com
// The password is typed at the prompt (hidden), never put on the command line or in shell history.
const readline = require('node:readline');
const { q } = require('../src/db');
const sec = require('../src/security');
const { v, now } = require('../src/core');

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(s); };
    rl.question(prompt, (a) => { rl.output.write('\n'); rl.close(); resolve(a); });
  });
}

(async () => {
  try {
    const name = v.text(process.argv[2], 'Name', { min: 2, max: 100 });
    const email = v.email(process.argv[3]);
    const pw = await askHidden('Password (min 10 characters): ');
    const pw2 = await askHidden('Repeat password: ');
    if (pw !== pw2) throw new Error('Passwords do not match');
    const problem = sec.passwordProblem(pw, email);
    if (problem) throw new Error(problem);
    if (q('SELECT 1 FROM users WHERE email=?').get(email)) throw new Error('That email already exists');
    q("INSERT INTO users(role,name,email,phone,pw_hash,created_at) VALUES('admin',?,?,'',?,?)")
      .run(name, email, await sec.hashPassword(pw), now());
    console.log(`Admin account created for ${email}`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
