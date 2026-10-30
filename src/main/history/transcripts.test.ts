import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverTranscriptFiles,
  MAX_CHUNK_CHARS,
  parseTranscript,
  parseTranscriptContent,
  redactSecrets,
  transcriptBelongsTo,
} from './transcripts';

// All fixtures are synthetic. Never paste real transcript content here.

const SID = '11111111-2222-3333-4444-555555555555';
const CWD = '/work/demo';

let clock = Date.parse('2026-01-01T00:00:00.000Z');
let uuidCounter = 0;

function base(extra: Record<string, unknown> = {}) {
  clock += 1000;
  uuidCounter += 1;
  return {
    uuid: `u-${uuidCounter}`,
    timestamp: new Date(clock).toISOString(),
    sessionId: SID,
    cwd: CWD,
    gitBranch: 'main',
    ...extra,
  };
}

const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  base({ type: 'user', message: { role: 'user', content }, ...extra });

const assistant = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
  base({ type: 'assistant', message: { role: 'assistant', model: 'claude-test', content: blocks }, ...extra });

const say = (text: string) => assistant([{ type: 'text', text }]);
const think = (thinking: string) => assistant([{ type: 'thinking', thinking, signature: 'sig' }]);
const tool = (name: string, input: Record<string, unknown>) =>
  assistant([{ type: 'tool_use', id: `toolu_${uuidCounter}`, name, input }]);
const toolResult = (content: string) =>
  user([{ type: 'tool_result', tool_use_id: 'toolu_x', content }]);

const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const parse = (raw: string, opts = {}) => parseTranscriptContent(raw, `/p/${SID}.jsonl`, opts);

beforeEach(() => {
  clock = Date.parse('2026-01-01T00:00:00.000Z');
  uuidCounter = 0;
});

describe('chunking', () => {
  it('builds one chunk per real prompt with User/Assistant text', () => {
    const { chunks, meta } = parse(
      jsonl(
        user('Please add a dark mode toggle to settings'),
        say('Sure, I will add it.'),
        say('Done: the toggle lives in the Appearance tab.'),
        user('Now write unit tests for the toggle'),
        say('Tests added.'),
      ),
    );
    expect(chunks.map((c) => c.id)).toEqual([`${SID}:0`, `${SID}:1`]);
    expect(chunks[0].text).toBe(
      'User: Please add a dark mode toggle to settings\n\nAssistant: Sure, I will add it.\nDone: the toggle lives in the Appearance tab.',
    );
    expect(chunks[0].kind).toBe('turn');
    expect(chunks[0].sessionId).toBe(SID);
    expect(chunks[0].ts).toBe(Date.parse('2026-01-01T00:00:01.000Z'));
    expect(chunks[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(meta).toMatchObject({ id: SID, cwds: [CWD], gitBranch: 'main' });
    expect(meta.firstTs).toBe(Date.parse('2026-01-01T00:00:01.000Z'));
    expect(meta.lastTs).toBe(Date.parse('2026-01-01T00:00:05.000Z'));
  });

  it('marks non-empty thinking and skips the empty thinking blocks the CLI stores', () => {
    const { chunks } = parse(
      jsonl(user('Why does the build fail on CI?'), think(''), think('The lockfile is stale.'), say('Regenerate the lockfile.')),
    );
    expect(chunks[0].text).toBe(
      'User: Why does the build fail on CI?\n\nAssistant: [thinking] The lockfile is stale.\nRegenerate the lockfile.',
    );
  });

  it('turns tool calls into one-line markers, drops tool results, and collects edited files', () => {
    const { chunks } = parse(
      jsonl(
        user('Fix the failing parser test please'),
        tool('Bash', { command: 'npx vitest run src/parser', description: 'Run parser tests' }),
        toolResult('FAIL src/parser.test.ts\n'.repeat(200)),
        tool('Bash', { command: `echo ${'x'.repeat(300)}` }),
        tool('Read', { file_path: '/work/demo/src/parser.ts' }),
        tool('Edit', { file_path: '/work/demo/src/parser.ts', old_string: 'a', new_string: 'b' }),
        tool('Write', { file_path: 'notes/plan.md', content: 'x' }),
        tool('NotebookEdit', { notebook_path: '/work/demo/nb.ipynb', new_source: 'x' }),
        tool('Grep', { pattern: 'parseLine', path: 'src' }),
        say('Fixed the off-by-one in parseLine.'),
      ),
    );
    const text = chunks[0].text;
    expect(text).toContain('[Bash] Run parser tests');
    expect(text).toContain('[Read] /work/demo/src/parser.ts');
    expect(text).toContain('[Edit] /work/demo/src/parser.ts');
    expect(text).toContain('[Grep] parseLine in src');
    expect(text).not.toContain('FAIL src/parser.test.ts');
    const longMarker = text.split('\n').find((line) => line.startsWith('[Bash] echo'))!;
    expect(longMarker.length).toBeLessThanOrEqual('[Bash] '.length + 101);
    expect(longMarker.endsWith('…')).toBe(true);
    // Relative paths resolve against the record's cwd; Read is not an edit.
    expect(chunks[0].files).toEqual([
      '/work/demo/src/parser.ts',
      path.join(CWD, 'notes/plan.md'),
      '/work/demo/nb.ipynb',
    ]);
  });

  it('does not treat a tool_result-only user record as a new prompt', () => {
    const { chunks } = parse(
      jsonl(
        user('List the files in the repository root'),
        tool('Bash', { command: 'ls' }),
        toolResult('README.md\nsrc'),
        say('There are two entries.'),
      ),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('There are two entries.');
  });

  it('ignores system-generated user records', () => {
    const { chunks } = parse(
      jsonl(
        user('Refactor the logging module for clarity'),
        say('Refactored.'),
        user('<local-command-stdout>Set model to opus</local-command-stdout>'),
        user('<system-reminder>The date changed.</system-reminder>'),
        user('[Request interrupted by user for tool use]'),
        user('Caveat: The messages below were generated by the user while running local commands.'),
        user('<bash-input>git status</bash-input>'),
        user('<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>'),
        user('Base directory for this skill: /skills/x', { isMeta: true }),
        user('Your usage limit has reset. Continue the task.', { isMeta: true, turnOrigin: 'auto_continuation' }),
        say('Continuing with the refactor.'),
      ),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('User: Refactor the logging module for clarity\n\nAssistant: Refactored.\nContinuing with the refactor.');
  });

  it('strips inline reminders from a real prompt but keeps the prompt', () => {
    const { chunks } = parse(
      jsonl(
        user([
          { type: 'text', text: 'Summarize the open pull requests' },
          { type: 'text', text: '<system-reminder>internal context</system-reminder>' },
        ]),
        say('There are three.'),
      ),
    );
    expect(chunks[0].text).toBe('User: Summarize the open pull requests\n\nAssistant: There are three.');
  });

  it('keeps a pasted prompt that starts with markup', () => {
    const { chunks } = parse(jsonl(user('<div class="card">why is this not centered?</div>'), say('Use flexbox.')));
    expect(chunks[0].text).toContain('User: <div class="card">');
  });

  it('folds task notifications into the current turn instead of starting one', () => {
    const notification = [
      '<task-notification>',
      '<task-id>bg1</task-id>',
      '<status>completed</status>',
      '<summary>Background build finished</summary>',
      '</task-notification>',
    ].join('\n');
    const { chunks } = parse(
      jsonl(
        user('Kick off the release build in the background'),
        say('Started the build.'),
        user(notification, { origin: { kind: 'task-notification' }, turnOrigin: 'task_notification' }),
        say('The build passed.'),
        // Same thing delivered mid-turn as a queued-command attachment.
        base({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notification } }),
      ),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('[task-notification] Background build finished');
    expect(chunks[0].text).toContain('The build passed.');
    expect(chunks[0].text).not.toContain('<task-id>');
  });

  it('treats a slash command as a prompt and drops it when nothing answered', () => {
    const { chunks } = parse(
      jsonl(
        user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
        user('<local-command-stdout>Set model</local-command-stdout>'),
        user('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the auth module</command-args>'),
        user('Skill body expanded here', { isMeta: true }),
        say('Reviewing the auth module now.'),
      ),
    );
    expect(chunks.map((c) => c.id)).toEqual([`${SID}:1`]);
    expect(chunks[0].text).toBe('User: /review the auth module\n\nAssistant: Reviewing the auth module now.');
  });

  it('opens turns for queued prompts, peer messages and scheduled wake-ups', () => {
    const { chunks } = parse(
      jsonl(
        user('Migrate the database schema to v2'),
        say('Migrating.'),
        base({
          type: 'attachment',
          attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'Also back up the old tables first', origin: { kind: 'human' } },
        }),
        say('Backing up first.'),
        // The same queued prompt landing again as a user record is a duplicate.
        user('Also back up the old tables first'),
        say('Backup complete.'),
        user('Another Claude session sent a message:\n<agent-message from="abc">Staging is free now</agent-message>', {
          isMeta: true,
          origin: { kind: 'peer' },
        }),
        say('Deploying to staging.'),
        user('Check whether the nightly job finished', { isMeta: true, turnOrigin: 'scheduled' }),
        say('It finished.'),
      ),
    );
    expect(chunks.map((c) => c.text.split('\n')[0])).toEqual([
      'User: Migrate the database schema to v2',
      'User: Also back up the old tables first',
      'User: [peer message] Staging is free now',
      'User: [scheduled] Check whether the nightly job finished',
    ]);
    expect(chunks[1].text).toContain('Backup complete.');
  });

  it('folds trivially short prompts into the current turn', () => {
    const { chunks } = parse(
      jsonl(
        user('Draft a plan for the caching layer'),
        say('Plan: 1. LRU 2. TTL'),
        user('yes go'),
        say('Implemented both.'),
      ),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(
      'User: Draft a plan for the caching layer\n\nAssistant: Plan: 1. LRU 2. TTL\n\nUser: yes go\n\nAssistant: Implemented both.',
    );
    // The threshold is tunable.
    expect(parse(jsonl(user('Draft a plan'), say('a'), user('yes go'), say('b')), { minPromptChars: 3 }).chunks).toHaveLength(2);
  });

  it('skips turns with no assistant text (tool calls alone do not count)', () => {
    const { chunks } = parse(
      jsonl(
        user('Run the linter over the whole repository'),
        tool('Bash', { command: 'npm run lint' }),
        toolResult('ok'),
        user('Now explain what the linter config does'),
        say('It extends the recommended rules.'),
      ),
    );
    expect(chunks.map((c) => c.seq)).toEqual([1]);
  });

  it('turns compact summaries into compact_summary chunks without ending the turn', () => {
    const { chunks } = parse(
      jsonl(
        user('Port the scheduler to the new queue API'),
        say('Starting the port.'),
        base({ type: 'system', subtype: 'compact_boundary' }),
        user('This session is being continued from a previous conversation. Summary: scheduler port in progress.', {
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
        }),
        say('Finished the port after compaction.'),
      ),
    );
    expect(chunks.map((c) => [c.id, c.kind])).toEqual([
      [`${SID}:0`, 'turn'],
      [`${SID}:1`, 'compact_summary'],
    ]);
    expect(chunks[0].text).toContain('Finished the port after compaction.');
    expect(chunks[1].text).toMatch(/^Compaction summary: This session is being continued/);
  });

  it('skips API error stand-ins and synthetic assistant messages', () => {
    const { chunks } = parse(
      jsonl(
        user('Generate the changelog for this release'),
        assistant([{ type: 'text', text: 'API Error: overloaded' }], { isApiErrorMessage: true }),
        base({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }),
      ),
    );
    expect(chunks).toHaveLength(0);
  });

  it('dedupes records replayed with the same uuid', () => {
    const prompt = user('Explain the retry policy in the client');
    const answer = say('It retries three times with backoff.');
    const { chunks } = parse(jsonl(prompt, answer, prompt, answer));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text.match(/retries three times/g)).toHaveLength(1);
  });

  it('splits very long turns into parts within the budget, carrying the prompt', () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => say(`Paragraph ${i}: ${'lorem ipsum '.repeat(80)}`));
    const raw = jsonl(user('Write the full design document for sync'), ...paragraphs, tool('Write', { file_path: '/work/demo/doc.md' }), say('end'));
    const { chunks } = parse(raw);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].id).toBe(`${SID}:0`);
    expect(chunks[1].id).toBe(`${SID}:0.1`);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(chunk.seq).toBe(0);
    }
    expect(chunks[1].text.startsWith('User: Write the full design document for sync (continued)\n\nAssistant: ')).toBe(true);
    // Files belong to the part that edited them.
    expect(chunks[chunks.length - 1].files).toEqual(['/work/demo/doc.md']);
    expect(chunks[0].files).toEqual([]);
    // Nothing is lost: every paragraph lands in exactly one part.
    const all = chunks.map((c) => c.text).join('\n');
    for (let i = 0; i < 60; i++) expect(all.match(new RegExp(`Paragraph ${i}:`, 'g'))).toHaveLength(1);
  });

  it('hard-splits a single oversized block', () => {
    const { chunks } = parse(jsonl(user('Paste the whole log file here'), say('y'.repeat(50_000))), { maxChunkChars: 10_000 });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(10_000);
  });

  it('keeps seq, ids and earlier hashes stable when the file grows', () => {
    const head = jsonl(
      user('First task: rename the config loader'),
      say('Renamed.'),
      user('Second task: add a migration for it'),
      say('Added.'),
    );
    const before = parse(head).chunks;
    const grown = parse(head + jsonl(say('Also updated the docs.'), user('Third task: release notes please'), say('Written.'))).chunks;
    expect(grown.map((c) => c.id)).toEqual([`${SID}:0`, `${SID}:1`, `${SID}:2`]);
    expect(grown[0].hash).toBe(before[0].hash);
    // The open turn grew, so its hash moved.
    expect(grown[1].hash).not.toBe(before[1].hash);

    // A growing long turn only adds parts; earlier parts are unchanged.
    const long = (n: number) =>
      jsonl(user('Write the long report on the outage'), ...Array.from({ length: n }, (_, i) => say(`Section ${i} ${'z'.repeat(3000)}`)));
    uuidCounter = 0;
    const short = parse(long(10)).chunks;
    uuidCounter = 0;
    const longer = parse(long(20)).chunks;
    expect(longer.length).toBeGreaterThan(short.length);
    for (let i = 0; i < short.length - 1; i++) {
      expect(longer[i].id).toBe(short[i].id);
      expect(longer[i].hash).toBe(short[i].hash);
    }
  });

  it('tolerates a truncated last line', () => {
    const raw = jsonl(user('Audit the dependency licenses'), say('All MIT.')) + '{"type":"user","message":{"role":"user","content":"Next ta';
    const { chunks } = parse(raw);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('All MIT.');
  });

  it('accepts a Buffer and collects every cwd, the latest title and relocations', () => {
    const raw = jsonl(
      user('Investigate the flaky upload test'),
      base({ type: 'ai-title', aiTitle: 'Flaky upload test' }),
      say('Looking.', ),
      { ...say('Found it in src.'), cwd: '/work/demo/src' },
      base({ type: 'ai-title', aiTitle: 'Fix flaky upload test' }),
      { type: 'relocated', relocatedCwd: '/work/moved', sessionId: SID },
    );
    const { meta } = parseTranscriptContent(Buffer.from(raw), `/p/${SID}.jsonl`);
    expect(meta.cwds).toEqual([CWD, '/work/demo/src', '/work/moved']);
    expect(meta.title).toBe('Fix flaky upload test');
    expect(parse(raw + jsonl({ type: 'custom-title', customTitle: 'My name', sessionId: SID })).meta.title).toBe('My name');
  });

  it('skips ignored record types by prefix but still reads type-first records it needs', () => {
    const raw = [
      JSON.stringify({ type: 'file-history-snapshot', messageId: 'm', snapshot: { cwd: '/elsewhere' } }),
      JSON.stringify({ type: 'api-request-blob', cwd: '/elsewhere', blob: 'x'.repeat(1000) }),
      JSON.stringify({ type: 'mode' }),
      // A user record that happens to put `type` first must not be skipped.
      JSON.stringify({ type: 'user', ...base(), message: { role: 'user', content: 'Rename the queue worker class' } }),
      JSON.stringify(say('Renamed it.')),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Rename worker', sessionId: SID }),
    ].join('\n');
    for (const content of [raw, Buffer.from(raw)]) {
      const { chunks, meta } = parseTranscriptContent(content, `/p/${SID}.jsonl`);
      expect(chunks.map((c) => c.text)).toEqual(['User: Rename the queue worker class\n\nAssistant: Renamed it.']);
      expect(meta.cwds).toEqual([CWD]);
      expect(meta.title).toBe('Rename worker');
    }
  });

  it('redacts secrets in chunk text and titles', () => {
    const secret = 'ghp_' + 'A1b2C3d4'.repeat(5);
    const { chunks, meta } = parse(
      jsonl(user(`Use this token ${secret} to push`), base({ type: 'ai-title', aiTitle: `Push with ${secret}` }), say(`Pushed using ${secret}.`)),
    );
    expect(chunks[0].text).not.toContain(secret);
    expect(chunks[0].text).toContain('[REDACTED]');
    expect(meta.title).toBe('Push with [REDACTED]');
  });
});

describe('redactSecrets', () => {
  const R = '[REDACTED]';
  const cases: [string, string, string][] = [
    ['anthropic', `key sk-ant-api03-${'aB3_'.repeat(10)}xyz`, `key ${R}`],
    ['openai legacy', `sk-${'Ab1'.repeat(16)}`, R],
    ['openai project', `sk-proj-${'Ab1-_'.repeat(10)}`, R],
    ['github classic', `ghp_${'a1B2'.repeat(9)}`, R],
    ['github oauth', `gho_${'a1B2'.repeat(9)}`, R],
    ['github fine-grained', `github_pat_11ABCDEFG_${'x1Y2'.repeat(12)}`, R],
    ['aws key id', 'aws AKIAIOSFODNN7EXAMPLE end', `aws ${R} end`],
    ['slack', 'xoxb-1234567890-abcdefghij', R],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', R],
    [
      'pem',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc123\nQUJDREVGR0hJSktMTU5PUFFS\n-----END RSA PRIVATE KEY-----',
      R,
    ],
    ['pem openssh', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', R],
    ['pem truncated', 'cat <<EOF\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEF', `cat <<EOF\n${R}`],
    ['bearer header', 'curl -H "Authorization: Bearer abc123def456ghi789"', `curl -H "Authorization: Bearer ${R}"`],
    ['basic header', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', `Authorization: Basic ${R}`],
    ['env password', 'DB_PASSWORD=hunter', `DB_PASSWORD=${R}`],
    ['env token', 'export GITHUB_TOKEN="abcdef0123456789"', `export GITHUB_TOKEN="${R}"`],
    ['yaml password', 'password: s3cr3tPass', `password: ${R}`],
    ['upper colon', 'PASSWORD:hunter2!', `PASSWORD:${R}`],
    ['json secret', '{"client_secret": "Zx81kq0PqLm2"}', `{"client_secret": "${R}"}`],
    ['camel api key', "const apiKey = 'abcd1234efgh5678';", `const apiKey = '${R}';`],
    ['header api key', "-H 'X-Api-Key: 9f8e7d6c5b4a3210'", `-H 'X-Api-Key: ${R}'`],
    ['passwd', 'passwd=letmein99', `passwd=${R}`],
    ['query token', 'https://api.example.com/v1?token=q8w7e6r5t4y3&x=1', `https://api.example.com/v1?token=${R}&x=1`],
    ['flag equals', 'psql --password=Tr0ub4dor', `psql --password=${R}`],
    ['flag space', 'tool --api-key "k3y-abcdef-123456"', `tool --api-key "${R}"`],
    ['flag space bare', 'login --password hunter2', `login --password ${R}`],
    ['sshpass', "sshpass -p 'S3cret!' ssh root@10.0.0.5", `sshpass -p ${R} ssh root@10.0.0.5`],
    ['mysql glued', "mysql -u root -p'S3cret!' appdb", `mysql -u root -p${R} appdb`],
    ['url creds', 'postgres://admin:Sup3rS3cret@db.internal:5432/app', `postgres://admin:${R}@db.internal:5432/app`],
    ['stripe', `sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`, R],
    ['env pass', 'DB_PASS=hunter22', `DB_PASS=${R}`],
    ['passphrase', 'passphrase = `c0rrect-horse`', `passphrase = \`${R}\``],
  ];
  for (const [name, input, expected] of cases) {
    it(`redacts ${name}`, () => expect(redactSecrets(input)).toBe(expected));
  }

  const untouched: [string, string][] = [
    ['prose about passwords', 'The password must be at least 12 characters and the token expires hourly.'],
    ['ts type annotations', 'interface Creds { password: string; token?: string; apiKey: string }'],
    ['code reading a secret', 'const token = await getToken(); const secret = config.secret; password = hashedPassword'],
    ['env references', 'TOKEN=$GITHUB_TOKEN; PASSWORD=${DB_PASS}; api_key: "{{ secrets.KEY }}"'],
    ['process.env', 'const apiKey = process.env.OPENAI_API_KEY;'],
    ['token counts', 'max_tokens=4096, input_token: 1234, tokens: 98765432'],
    ['metadata keys', 'TOKEN_URL=https://auth.example.com/token\nSECRET_NAME=prod-db-credentials\npasswordField: "pwd-input"'],
    ['placeholders', 'password: ******** and token=<your-token> and PASSWORD=changeme'],
    ['bearer variable', 'curl -H "Authorization: Bearer $TOKEN" https://api.example.com'],
    ['sk- words', 'Use sk-learn style pipelines; see the risk-assessment-2026 doc.'],
    ['passport and bypass', 'PASSPORT=issued; bypass=enabled-for-admins; compass: north'],
    ['mysql prompt form', 'mysql -u root -p appdb'],
    ['git ssh url', 'git clone git@github.com:owner/repo.git'],
    ['url env creds', 'postgres://${DB_USER}:${DB_PASS}@db:5432/app'],
    ['flag mention', 'pass the --token flag to the CLI'],
    ['comparison', 'if (password === confirmPassword) return;'],
    ['quoted prose', 'placeholder: "Enter your password here"'],
    ['short values', 'pass=3 fail=0 token: abc'],
    ['jwt-like words', 'eyJ is how base64 JSON starts'],
    // Shapes seen as false positives on real transcripts:
    ['test summaries', 'Tests pass: 120/120 and all required checks pass: `lint-and-build`'],
    ['config templates', '"apiKey": "{env:OPENAI_KEY}", api_key:{llm_key}'],
    ['rust paths', 'ticket: Secret::new(raw), ApiKeyHasher::hash(key)'],
    ['c arrows', 'token = (s->bearer_token) ? session->bearer_token : NULL;'],
    ['ssrf host:port', 'userinfo trick http://localhost:80@169.254.169.254/'],
    ['variable names in quotes', 'password: "DB_PASSWORD_VAR"'],
    ['literal marker', 'API_KEY=[REDACTED] stays as it was'],
  ];
  for (const [name, input] of untouched) {
    it(`leaves ${name} alone`, () => expect(redactSecrets(input)).toBe(input));
  }

  it('redacts long values completely', () => {
    const long = 'Ab1'.repeat(400); // 1200 chars, longer than any early cap
    expect(redactSecrets(`SESSION_TOKEN=${long}`)).toBe(`SESSION_TOKEN=${R}`);
    expect(redactSecrets(`{"auth_token": "${long}"}`)).toBe(`{"auth_token": "${R}"}`);
  });

  it('reports each hit to the diagnostics callback', () => {
    const hits: string[] = [];
    redactSecrets('DB_PASSWORD=hunter and AKIAIOSFODNN7EXAMPLE', (rule) => hits.push(rule));
    expect(hits.sort()).toEqual(['assignment', 'aws-access-key']);
  });
});

describe('transcriptBelongsTo', () => {
  const identity = (p: string) => p;
  const meta = (...cwds: string[]) => ({ cwds });

  it('matches the folder itself and anything inside it', () => {
    expect(transcriptBelongsTo(meta('/a/b'), '/a/b', { platform: 'linux', realpath: identity })).toBe(true);
    expect(transcriptBelongsTo(meta('/x', '/a/b/src/deep'), '/a/b', { platform: 'linux', realpath: identity })).toBe(true);
  });

  it('respects the path boundary', () => {
    expect(transcriptBelongsTo(meta('/a/bc'), '/a/b', { platform: 'linux', realpath: identity })).toBe(false);
    expect(transcriptBelongsTo(meta('/a'), '/a/b', { platform: 'linux', realpath: identity })).toBe(false);
  });

  it('normalizes trailing separators and dot segments', () => {
    expect(transcriptBelongsTo(meta('/a/b/'), '/a/b//', { platform: 'linux', realpath: identity })).toBe(true);
    expect(transcriptBelongsTo(meta('/a/b/c/../d'), '/a/b/', { platform: 'linux', realpath: identity })).toBe(true);
    expect(transcriptBelongsTo(meta('/anything'), '/', { platform: 'linux', realpath: identity })).toBe(true);
  });

  it('is case-insensitive on darwin and win32 only', () => {
    expect(transcriptBelongsTo(meta('/Users/Me/Proj/src'), '/users/me/proj', { platform: 'darwin', realpath: identity })).toBe(true);
    expect(transcriptBelongsTo(meta('/Users/Me/Proj'), '/users/me/proj', { platform: 'linux', realpath: identity })).toBe(false);
    expect(transcriptBelongsTo(meta('C:\\Work\\Repo\\src'), 'c:/work/repo/', { platform: 'win32', realpath: identity })).toBe(true);
    expect(transcriptBelongsTo(meta('C:\\Work\\Repo2'), 'C:\\Work\\Repo', { platform: 'win32', realpath: identity })).toBe(false);
  });

  it('compares realpaths too, and survives realpath failures', () => {
    const realpath = (p: string) => {
      if (p.startsWith('/link')) return p.replace('/link', '/real');
      throw new Error('ENOENT');
    };
    expect(transcriptBelongsTo(meta('/real/proj/src'), '/link/proj', { platform: 'linux', realpath })).toBe(true);
    expect(transcriptBelongsTo(meta('/link/proj'), '/real/proj', { platform: 'linux', realpath })).toBe(true);
    expect(transcriptBelongsTo(meta('/gone/proj'), '/gone/proj', { platform: 'linux', realpath })).toBe(true);
  });

  it('is false for a missing folder or no cwds', () => {
    expect(transcriptBelongsTo(meta('/a/b'), null)).toBe(false);
    expect(transcriptBelongsTo(meta('/a/b'), '')).toBe(false);
    expect(transcriptBelongsTo(meta(), '/a/b', { platform: 'linux', realpath: identity })).toBe(false);
  });
});

describe('files on disk', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sg-history-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('discovers main and subagent transcripts and skips everything else', async () => {
    const project = path.join(dir, '-work-demo');
    await mkdir(path.join(project, SID, 'subagents'), { recursive: true });
    await mkdir(path.join(project, SID, 'tool-results'), { recursive: true });
    await mkdir(path.join(project, 'memory'), { recursive: true });
    await writeFile(path.join(project, `${SID}.jsonl`), jsonl(user('hello there, main session'), say('hi')));
    await writeFile(path.join(project, SID, 'subagents', 'agent-abc123.jsonl'), jsonl(user('subagent task prompt here'), say('ok')));
    await writeFile(path.join(project, SID, 'subagents', 'agent-abc123.meta.json'), JSON.stringify({ description: 'Survey the tests' }));
    await writeFile(path.join(project, SID, 'tool-results', 'x.txt'), 'noise');
    await writeFile(path.join(project, 'memory', 'MEMORY.md'), 'noise');
    await writeFile(path.join(dir, 'stray.jsonl'), 'not inside a project');

    const found = await discoverTranscriptFiles(dir);
    expect(found.map((f) => [path.relative(dir, f.file), f.id, f.parentSessionId])).toEqual([
      [path.join('-work-demo', `${SID}.jsonl`), SID, undefined],
      [path.join('-work-demo', SID, 'subagents', 'agent-abc123.jsonl'), 'agent-abc123', SID],
    ]);
    expect(found[0].size).toBeGreaterThan(0);
    expect(found[0].mtimeMs).toBeGreaterThan(0);

    const sub = await parseTranscript(found[1]);
    expect(sub.meta).toMatchObject({ id: 'agent-abc123', parentSessionId: SID, title: 'Survey the tests' });
    expect(sub.chunks[0].id).toBe('agent-abc123:0');
    // The parent is inferred from the layout when only a path is given.
    expect((await parseTranscript(found[1].file)).meta.parentSessionId).toBe(SID);
  });

  it('returns nothing for a missing projects dir', async () => {
    expect(await discoverTranscriptFiles(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('performance', () => {
  it('parses a ~5 MB transcript quickly', () => {
    const records: unknown[] = [];
    for (let i = 0; i < 400; i++) {
      records.push(user(`Task number ${i}: refactor module ${i} with care`));
      records.push(think(''));
      records.push(tool('Bash', { command: `npm test -- module${i}`, description: `Test module ${i}` }));
      records.push(toolResult('PASS '.repeat(2000)));
      records.push(say(`Refactored module ${i}. ${'detail '.repeat(150)}`));
    }
    const raw = jsonl(...records);
    expect(raw.length).toBeGreaterThan(4_000_000);
    const start = performance.now();
    const { chunks } = parse(raw);
    const elapsed = performance.now() - start;
    expect(chunks).toHaveLength(400);
    // Generous bound for slow CI; locally this is tens of ms.
    expect(elapsed).toBeLessThan(1500);
  });
});
