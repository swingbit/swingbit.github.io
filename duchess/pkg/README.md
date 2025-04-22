# Duchess
A simple chess engine. 
Because it's fun and because I needed an excuse to get accustomed to Rust.

The `wasm` branch is playable online at https://swingbit.github.io/duchess/

## Status
- Move generation:
  - (done) all standard moves, castling, promotion, check, checkmate, draw
  - (missing) en passant
- Check validity of human moves:
  - (done) all standard moves, castling, promotion, check, checkmate, draw
  - (missing) en passant
- UI:
  - (partial) [UCI](https://en.wikipedia.org/wiki/Universal_Chess_Interface) interface (branch `main`. Use with e.g. [Arena Chess GUI](http://www.playwitharena.de/))
  - integration with [chessboardjs](https://chessboardjs.com) via Wasm compilation (branch `wasm`)
- Evaluations and heuristics:
  - (done) simple board value based on pieces
  - (done) [simplified positional evaluation](https://www.chessprogramming.org/Simplified_Evaluation_Function)
  - (missing) more evaluations
- Search algorithm:
  - (done) Minimax
  - (done) Negamax
  - (done) Negascout
- Optional optimizations:
  - (missing) transposition table
  - (partial) move ordering
  - (missing) more efficient board representations

## How to run Duchess on a browser
- Make sure `wasm-pack` [is installed](https://rustwasm.github.io/wasm-pack/installer/)
- Run `./build.sh`
- Run `./server.py`
- Open a broser to: http://localhost:8000/duchess.html