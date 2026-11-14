// Builds the secrets file for `cf deploy` from the local secret files (never printed, never in the repo):
// ~/.near-credentials/heat-index-web/secrets.json (RELAYER_KEY, OWNER_SECRET) + nearai.key (NEARAI_KEY, optional).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const dir = `${homedir()}/.near-credentials/heat-index-web`;
const out = JSON.parse(readFileSync(`${dir}/secrets.json`, 'utf8'));
if (existsSync(`${dir}/nearai.key`)) out.NEARAI_KEY = readFileSync(`${dir}/nearai.key`, 'utf8').trim();
writeFileSync(`${dir}/deploy-secrets.json`, JSON.stringify(out), { mode: 0o600 });
console.log(`secrets: ${Object.keys(out).join(', ')}`);
