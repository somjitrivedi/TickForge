import type { GameDefinition, PlayerId, Tick } from "./types.ts";

export interface HeadlessOptions<I> {
  seed: number;
  players: readonly PlayerId[];
  ticks: number;
  inputFor(tick: Tick, player: PlayerId): I;
}

export interface HeadlessResult<S> {
  state: S;
  hashes: number[];
}

export function runHeadless<S, I>(game: GameDefinition<S, I>, options: HeadlessOptions<I>): HeadlessResult<S> {
  const state = game.createState(options.seed);
  for (const p of options.players) game.addPlayer(state, p);
  const inputs = new Map<PlayerId, I>();
  const hashes: number[] = [];
  for (let t = 0; t < options.ticks; t++) {
    inputs.clear();
    for (const p of options.players) inputs.set(p, options.inputFor(t, p));
    game.step(state, inputs);
    hashes.push(game.hashState(state));
  }
  return { state, hashes };
}
