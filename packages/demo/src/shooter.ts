import { createRng, Hasher, nextRange } from "@tickforge/sim";
import type { GameDefinition, PlayerId, RngState } from "@tickforge/sim";

export const ARENA_WIDTH = 100_000;
export const ARENA_HEIGHT = 60_000;
export const PLAYER_RADIUS = 1_000;
export const PLAYER_SPEED = 300;
export const DIAGONAL_NUM = 707;
export const DIAGONAL_DEN = 1000;
export const MAX_HP = 100;

export const Button = {
  Up: 1,
  Down: 2,
  Left: 4,
  Right: 8,
} as const;

export interface ShooterInput {
  buttons: number;
}

export interface ShooterPlayer {
  id: PlayerId;
  x: number;
  y: number;
  hp: number;
}

export interface ShooterState {
  tick: number;
  rng: RngState;
  players: Map<PlayerId, ShooterPlayer>;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function axis(buttons: number, neg: number, pos: number): number {
  return ((buttons & pos) !== 0 ? 1 : 0) - ((buttons & neg) !== 0 ? 1 : 0);
}

export function movePlayer(p: ShooterPlayer, buttons: number): void {
  const dx = axis(buttons, Button.Left, Button.Right);
  const dy = axis(buttons, Button.Up, Button.Down);
  if (dx === 0 && dy === 0) return;
  const speed = dx !== 0 && dy !== 0 ? Math.trunc((PLAYER_SPEED * DIAGONAL_NUM) / DIAGONAL_DEN) : PLAYER_SPEED;
  p.x = clamp(p.x + dx * speed, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS);
  p.y = clamp(p.y + dy * speed, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS);
}

export const shooter: GameDefinition<ShooterState, ShooterInput> = {
  id: "topdown-shooter",
  tickRate: 30,

  createState(seed) {
    return { tick: 0, rng: createRng(seed), players: new Map() };
  },

  addPlayer(state, id) {
    if (state.players.has(id)) throw new Error(`Player ${id} already in game`);
    state.players.set(id, {
      id,
      x: nextRange(state.rng, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS),
      y: nextRange(state.rng, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS),
      hp: MAX_HP,
    });
  },

  removePlayer(state, id) {
    state.players.delete(id);
  },

  step(state, inputs) {
    for (const p of state.players.values()) {
      const input = inputs.get(p.id);
      if (input) movePlayer(p, input.buttons);
    }
    state.tick++;
  },

  neutralInput() {
    return { buttons: 0 };
  },

  cloneState(state) {
    const players = new Map<PlayerId, ShooterPlayer>();
    for (const [id, p] of state.players) players.set(id, { ...p });
    return { tick: state.tick, rng: { s: state.rng.s }, players };
  },

  hashState(state) {
    const h = new Hasher().int(state.tick).int(state.rng.s | 0);
    const ids = [...state.players.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const p = state.players.get(id)!;
      h.int(p.id).int(p.x).int(p.y).int(p.hp);
    }
    return h.digest();
  },
};
