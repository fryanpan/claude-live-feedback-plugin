/**
 * Build a synthetic data dir for the boot-cost benchmark, in a SUBPROCESS.
 *
 * Out of process on purpose: building the fixture arms the builder's own save
 * timers and file polls, and any of those still alive would land inside the
 * steady-state window the benchmark measures against a freshly booted
 * instance. A separate process cannot pollute that window.
 *
 * Usage: bun run make-boot-fixture.ts <dataDir> <srcDir> <liveBound> <deadBound> <hub>
 * Prints one JSON line: { "aliasToId": { alias: docId }, "liveIds": [...] }
 */
import { writeFileSync } from 'node:fs';
import { Rooms } from '../../src/rooms.ts';
import { SseHub } from '../../src/sse.ts';
import { createWebhookDispatcher } from '../../src/webhooks.ts';

const [dataDir, srcDir, liveArg, deadArg, hubArg, bodyArg] = process.argv.slice(2);
const liveBound = Number(liveArg);
const deadBound = Number(deadArg);
const hub = Number(hubArg);
const bodyParas = Number(bodyArg ?? 3);

const body = (i: number): string =>
  Array.from(
    { length: bodyParas },
    (_, p) =>
      `Synthetic paragraph ${p} of doc ${i}. It carries enough prose that the ` +
      'parse and the Yjs state are not trivially small, which is what makes ' +
      'the boot measurement comparable to a real data dir.',
  ).join('\n\n');

const rooms = new Rooms({
  dataDir,
  sse: new SseHub(),
  webhooks: createWebhookDispatcher({ onLog: () => {} }),
});

const aliasToId: Record<string, string> = {};
const liveIds: string[] = [];

for (let i = 0; i < liveBound; i++) {
  const path = `${srcDir}/live-${i}.md`;
  writeFileSync(path, `# Doc ${i}\n\n${body(i)}\n`);
  const alias = `live-doc-${i}`;
  const res = rooms.createForCaller(alias, { type: 'markdown', sourceUrl: path });
  if (!res.ok) throw new Error('fixture create failed');
  rooms.attachFile(res.room.docId, path);
  aliasToId[alias] = res.room.docId;
  liveIds.push(res.room.docId);
}

for (let i = 0; i < deadBound; i++) {
  const alias = `dead-doc-${i}`;
  const res = rooms.createForCaller(alias, {
    type: 'markdown',
    sourceUrl: `${srcDir}/gone-${i}.md`,
  });
  if (!res.ok) throw new Error('fixture create failed');
  aliasToId[alias] = res.room.docId;
}

for (let i = 0; i < hub; i++) {
  rooms.getOrCreate(`task:t-synthetic${i}`, { type: 'markdown' }, { authority: 'server' });
}

rooms.flush();
console.log(JSON.stringify({ aliasToId, liveIds }));
process.exit(0);
