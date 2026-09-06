export function codexProtocolFixture(version = '0.134.0', mode = 'normal', logPath: string | null = null) {
  return `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv[2] === '--version') { console.log('codex-cli ${version}'); process.exit(0); }
const mode = ${JSON.stringify(mode)};
const log = ${JSON.stringify(logPath)};
const record = (value) => { if (log) fs.appendFileSync(log, JSON.stringify(value) + '\\n'); };
record({pid:process.pid, home:process.env.HOME, codexHome:process.env.CODEX_HOME, apiKey:process.env.OPENAI_API_KEY, cwd:process.cwd()});
if (mode === 'version_only') { console.log('codex-cli ${version}'); process.exit(0); }
if (mode === 'exit') process.exit(7);
if (mode === 'timeout') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
let initialized = false;
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const frame = JSON.parse(line); record(frame);
  if (mode === 'timeout') return;
  if (mode === 'bad_json') return console.log('{broken');
  if (mode === 'error') return console.log(JSON.stringify({id:frame.id,error:{code:-1,message:'bad'}}));
  if (frame.method === 'initialize') return console.log(JSON.stringify({id:frame.id,result:mode === 'bad_initialize' ? {} : {userAgent:'fixture/1'}}));
  if (frame.method === 'initialized') { initialized = true; return; }
  if (frame.method !== 'thread/list' || !initialized) process.exit(8);
  console.log(JSON.stringify({id:frame.id,result:mode === 'bad_list' ? {} : {data:[],nextCursor:null}}));
  if (mode === 'crash_after_list') process.exit(9);
});
`;
}
