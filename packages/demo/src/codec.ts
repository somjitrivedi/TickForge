import { ProtocolError } from "@tickforge/protocol";
import type { GameCodec } from "@tickforge/protocol";
import { MAX_HP } from "./shooter.ts";
import type { ShooterInput, ShooterPlayer, ShooterState } from "./shooter.ts";

const BUTTON_MASK = 0x0f;
const MAX_PLAYERS_IN_STATE = 1024;

export const shooterCodec: GameCodec<ShooterState, ShooterInput> = {
  writeInput(w, input) {
    w.u8(input.buttons & BUTTON_MASK);
  },

  readInput(r) {
    const buttons = r.u8();
    if ((buttons & ~BUTTON_MASK) !== 0) throw new ProtocolError(`Unknown button bits 0x${buttons.toString(16)}`);
    return { buttons };
  },

  writeState(w, state) {
    w.u32(state.tick).u32(state.rng.s).varuint(state.players.size);
    for (const p of state.players.values()) w.u32(p.id).i32(p.x).i32(p.y).u8(p.hp);
  },

  readState(r) {
    const tick = r.u32();
    const s = r.u32();
    const count = r.varuint();
    if (count > MAX_PLAYERS_IN_STATE) throw new ProtocolError(`Too many players in state: ${count}`);
    const players = new Map<number, ShooterPlayer>();
    for (let i = 0; i < count; i++) {
      const p: ShooterPlayer = { id: r.u32(), x: r.i32(), y: r.i32(), hp: r.u8() };
      if (p.hp > MAX_HP) throw new ProtocolError(`hp ${p.hp} exceeds ${MAX_HP}`);
      players.set(p.id, p);
    }
    return { tick, rng: { s }, players };
  },
};
