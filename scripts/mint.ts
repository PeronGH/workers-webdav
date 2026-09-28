import { derivePassword, USERNAME_PATTERN } from '../src/auth';

const secret = process.env.AUTH_SECRET;
const usernames = process.argv.slice(2);

if (!secret || usernames.length === 0) {
	console.error('Usage: AUTH_SECRET=<secret> bun run mint <username>...');
	process.exit(1);
}

for (const username of usernames) {
	if (!USERNAME_PATTERN.test(username)) {
		console.error(`Invalid username "${username}": must match ${String(USERNAME_PATTERN)}`);
		process.exit(1);
	}
	console.log(`${username}\t${await derivePassword(secret, username)}`);
}
