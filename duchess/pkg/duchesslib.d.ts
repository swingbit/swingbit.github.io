/* tslint:disable */
/* eslint-disable */
/**
* Computes the best move from the given board
* @param {string} fromFEN
* @returns {string}
*/
export function find_best_move(fromFEN: string): string;
/**
* Checks that the move is legal e returns a new FEN for the opponent
* @param {string} fromFEN
* @param {string} fromPos
* @param {string} toPos
* @returns {string}
*/
export function make_move(fromFEN: string, fromPos: string, toPos: string): string;
/**
* Reports whether and in what way the game ended
* @param {string} fromFEN
* @returns {string}
*/
export function check_end_game(fromFEN: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly find_best_move: (a: number, b: number, c: number) => void;
  readonly make_move: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly check_end_game: (a: number, b: number, c: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_malloc: (a: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number) => number;
  readonly __wbindgen_free: (a: number, b: number) => void;
  readonly __wbindgen_exn_store: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {SyncInitInput} module
*
* @returns {InitOutput}
*/
export function initSync(module: SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {InitInput | Promise<InitInput>} module_or_path
*
* @returns {Promise<InitOutput>}
*/
export default function init (module_or_path?: InitInput | Promise<InitInput>): Promise<InitOutput>;
