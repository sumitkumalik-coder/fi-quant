#!/usr/bin/env node
/**
 * scripts/seed-github-db.js
 *
 * Run once after creating your GitHub DB repo:
 *   GITHUB_TOKEN=ghp_xxx GITHUB_REPO=you/fi-quant-db node scripts/seed-github-db.js
 *
 * Creates the folder structure and README in your private GitHub repo
 * that acts as permanent persistent storage for all trade history.
 */

const GH_TOKEN  = process.env.GITHUB_TOKEN;
const GH_REPO   = process.env.GITHUB_REPO;   // e.g. "yourname/fi-quant-db"
const GH_BRANCH = 'main';

if (!GH_TOKEN || !GH_REPO) {
  console.error('❌  Set GITHUB_TOKEN and GITHUB_REPO env vars first.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept:        'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
  'User-Agent':  'fi-quant-seeder',
};

async function createFile(path, content, message) {
  const encoded = Buffer.from(content).toString('base64');
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${path}`, {
    method:  'PUT',
    headers,
    body:    JSON.stringify({ message, content: encoded, branch: GH_BRANCH }),
  });
  const j = await r.json();
  if (r.ok) console.log(`✅  Created: ${path}`);
  else      console.error(`❌  Failed ${path}:`, j.message);
  return r.ok;
}

async function seed() {
  console.log(`\n🌱  Seeding GitHub DB repo: ${GH_REPO}\n`);

  /* README */
  await createFile('README.md', `# FI/QUANT Database

This private repository stores all trade history, strategy states,
and discovery engine results for FI/QUANT.

**Structure:**
\`\`\`
db/
  trades/          Monthly trade logs (YYYY-MM.json)
  strategies/      Per-strategy state files
  sde/             Strategy Discovery Engine weekly results
  stats/           Monthly portfolio stats + equity curve
\`\`\`

**Auto-managed by the FI/QUANT Vercel API.**
Never edit manually — all writes go through api/sync.js.

Last seeded: ${new Date().toISOString()}
`, 'init: README');

  /* Placeholder files to establish folder structure */
  const month = new Date().toISOString().slice(0, 7);
  const week  = (() => {
    const d = new Date();
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const wk = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(wk).padStart(2,'0')}`;
  })();

  await createFile(`db/trades/${month}.json`,
    JSON.stringify([], null, 2),
    `init: trades folder for ${month}`);

  await createFile(`db/strategies/_index.json`,
    JSON.stringify([], null, 2),
    'init: strategies index');

  await createFile(`db/sde/${week}.json`,
    JSON.stringify([], null, 2),
    `init: SDE results for ${week}`);

  await createFile(`db/stats/${month}.json`,
    JSON.stringify([], null, 2),
    `init: stats for ${month}`);

  await createFile('.gitignore', `node_modules/\n.env\n.vercel/\n`, 'init: gitignore');

  console.log('\n✅  Done! Your GitHub DB repo is ready.');
  console.log('\nNext steps:');
  console.log('  1. Add these secrets to your Vercel project:');
  console.log('     GITHUB_TOKEN = your PAT (repo scope)');
  console.log(`     GITHUB_REPO  = ${GH_REPO}`);
  console.log('     KV_REST_API_URL   = from Vercel KV dashboard');
  console.log('     KV_REST_API_TOKEN = from Vercel KV dashboard');
  console.log('  2. Run: vercel --prod');
}

seed().catch(console.error);
