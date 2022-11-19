# Duchess
A simple chess engine. 
Because it's fun and because I needed an excuse to get accustomed to Rust.

## Status
- Move generation:
  - (done) all standard moves, castling, promotion, check
  - (missing) checkmate, en passant
- Check validity of human moves:
  - (done) all standard moves, castling, promotion
  - (missing) check, checkmate, en passant
- UI:
  - (partial) [UCI](https://en.wikipedia.org/wiki/Universal_Chess_Interface) interface (use with e.g. [Arena Chess GUI](http://www.playwitharena.de/))
- Evaluations and heuristics:
  - (done) simple board value based on pieces
  - (done) simplified positional evaluation
  - (missing) more evaluations
- Search algorithm:
  - (done) Minimax (fail-soft α-β pruning)
  - (done) Negamax (fail-soft α-β pruning)
  - (done) Negascout (fail-soft α-β pruning)
- Optional optimizations:
  - (missing) transposition table
  - (partial) move ordering
  - (missing) more efficient board representations


