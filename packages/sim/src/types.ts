export type Tick = number;
export type PlayerId = number;

export interface GameDefinition<S, I> {
  readonly id: string;
  readonly tickRate: number;
  createState(seed: number): S;
  addPlayer(state: S, player: PlayerId): void;
  removePlayer(state: S, player: PlayerId): void;
  step(state: S, inputs: ReadonlyMap<PlayerId, I>): void;
  neutralInput(): I;
  cloneState(state: S): S;
  hashState(state: S): number;
}
