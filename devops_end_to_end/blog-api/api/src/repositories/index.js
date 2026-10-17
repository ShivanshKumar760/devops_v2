import { env } from '../config/env.js';

const backend = env.mongoUri ? 'mongo' : 'memory';
console.log(`[repositories] using ${backend} backend`);

const { usersRepo } = await import(`./users.${backend}.js`);
const { postsRepo } = await import(`./posts.${backend}.js`);

export { usersRepo, postsRepo };
