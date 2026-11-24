import { parseArgs } from "node:util";
import { TickForgeClient } from "@tickforge/client";
import { createRng, nextInt } from "@tickforge/sim";
import { shooterCodec } from "./codec.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "ws://127.0.0.1:7350" },
    bots: { type: "string", default: "8" },
    seconds: { type: "string", default: "10" },
    room: { type: "string", default: "" },
  },
});

const count = Number(values.bots);
const seconds = Number(values.seconds);
if (!Number.isInteger(count) || count < 1 || count > 1000) throw new RangeError("--bots must be 1-1000");
if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError("--seconds must be positive");

interface Bot {
  client: TickForgeClient<ReturnType<typeof shooterCodec.readState>, { buttons: number }>;
  snapshots: number;
  timer: ReturnType<typeof setInterval> | undefined;
}

const rng = createRng(Date.now() >>> 0);
const bots: Bot[] = [];

for (let i = 0; i < count; i++) {
  const client = new TickForgeClient(shooterCodec, { url: values.url });
  const bot: Bot = { client, snapshots: 0, timer: undefined };
  client.onSnapshot = () => {
    bot.snapshots++;
  };
  try {
    const session = await client.connect({ name: `bot-${i + 1}`, roomId: values.room });
    let buttons = 0;
    bot.timer = setInterval(() => {
      if (nextInt(rng, 10) === 0) buttons = nextInt(rng, 16);
      if (client.status === "connected") client.sendInput({ buttons });
    }, 1000 / session.tickRate);
    bots.push(bot);
  } catch (err) {
    console.error(`bot-${i + 1} failed to join: ${(err as Error).message}`);
  }
}

console.log(`${bots.length}/${count} bots connected; running ${seconds}s`);
const started = performance.now();

const report = setInterval(() => {
  const elapsed = (performance.now() - started) / 1000;
  const total = bots.reduce((n, b) => n + b.snapshots, 0);
  const rtts = bots.map((b) => b.client.rttMs).filter((r): r is number => r !== undefined);
  const avgRtt = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
  const rooms = new Set(bots.map((b) => b.client.session?.roomId)).size;
  console.log(
    `t=${elapsed.toFixed(1)}s rooms=${rooms} snapshots/bot/s=${(total / bots.length / elapsed).toFixed(1)} ` +
      `avgRtt=${avgRtt.toFixed(1)}ms pendingInputs=${bots.reduce((n, b) => n + b.client.pendingInputs, 0)}`,
  );
}, 2000);

setTimeout(() => {
  clearInterval(report);
  for (const b of bots) {
    clearInterval(b.timer);
    b.client.leave();
  }
  setTimeout(() => process.exit(0), 200);
}, seconds * 1000);
