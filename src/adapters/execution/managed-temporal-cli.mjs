import fs from 'node:fs';
const built = new URL('../integration/managed-temporal-cli.js', import.meta.url);
const source = new URL('../integration/managed-temporal-cli.ts', import.meta.url);
export const { installTemporalCli, managedTemporalCliPath } = await import(fs.existsSync(built) ? built.href : source.href);
