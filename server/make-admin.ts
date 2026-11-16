/**
 * Create an admin account, or change an admin's password:
 *
 *   npm run make-admin -- <username>
 *
 * Asks for the password (typed text is hidden), or takes it from ADMIN_PASSWORD. Only a salted
 * scrypt hash is stored, in ADMINS_FILE (data/admins.json by default, never committed). The
 * running server reads that file at each admin login, so it doesn't need a restart. Admins own
 * every item. Run it from server/, with the same DATA_FILE / ADMINS_FILE settings as the server.
 */
import { createInterface } from 'node:readline';
import { adminEntry, ADMINS_FILE, keyOf, readAdmins, USERNAME, writeAdmins } from './accounts.js';

const name = process.argv[2] ?? '';
if (!USERNAME.test(name)) {
  console.error('usage: npm run make-admin -- <username>   (3-16 letters, numbers or _)');
  process.exit(1);
}

function ask(prompt: string): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // hide what is typed: echo nothing but the prompt
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stdout.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      res(answer);
    });
  });
}

let password = process.env.ADMIN_PASSWORD ?? '';
if (!password) {
  password = await ask(`Password for ${name}: `);
  if ((await ask('Again: ')) !== password) {
    console.error('The two passwords differ: nothing changed.');
    process.exit(1);
  }
}
if (!password) {
  console.error('Empty password: nothing changed.');
  process.exit(1);
}
if (password.length < 8) console.warn('Warning: that password is short. Anyone who guesses it owns this admin account.');

const admins = readAdmins();
admins[keyOf(name)] = await adminEntry(name, password);
writeAdmins(admins);
console.log(`Admin "${name}" saved to ${ADMINS_FILE}.`);
process.exit(0);
