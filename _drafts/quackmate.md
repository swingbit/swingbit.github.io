---
layout: post
title: Quack-Mate
subtitle: Pushing the Boundaries of Pure SQL Chess
# date: 2026-03-01
tags: chess duckdb sql
---

Let's address the elephant in the room right away: SQL is absolutely not the most convenient or efficient paradigm for programming a chess engine. It is inherently designed for set-based data retrieval, not for the highly branching, depth-first search that characterises traditional chess engines. My intention with Quack-Mate was never to build a competitive engine to dethrone Stockfish. Rather, it was a passionate exploration of a single, slightly mad question: just how far can we push a modern analytical database engine to play chess?

The primary reason for embarking on this project was simply that it seemed nobody had done it before—at least, not like this. While there have been a few attempts to implement chess in databases, they typically rely heavily on procedural extensions like Oracle's PL/SQL or PostgreSQL's PL/pgSQL (with explicit loops and variables), or they are written as C extensions. Implementing a fully functioning chess engine purely through relational algebra and standard SQL queries on a modern analytical engine (like the brilliant DuckDB) felt like uncharted territory.

Modern analytical engines like DuckDB are absolute beasts at crunching numbers in high volumes. Exploring the immense tree of chess possibilities immediately brings to mind joining a table of 'boards' with a table of 'all possible moves' to create a new generation of boards. If a pure SQL formulation is possible, you get the tremendous benefits of advanced database engines for free: brutal query optimisation and vectorised parallelisation over millions of rows. 

But why is raw efficiency so heavily emphasised in chess programming? It comes down to a mathematical nightmare known as combinatorial explosion. From the starting position, White has 20 possible moves, and Black has 20 responses, meaning there are 400 possible games after just one full turn. After three full turns, there are over 119 million possible games. After just four full turns (8 ply), the game tree explodes to roughly 85 billion possible games! To play well, an engine must look as far ahead into this exponentially growing branches as possible. Therefore, in chess engines, speed directly translates to search depth, and depth translates directly into playing strength.

## Anatomy of a Chess Engine (and How SQL Handles It)

Before diving into the complex queries, it helps to understand the basic components of a traditional chess engine and how Quack-Mate translates them into the language of relational databases.

### Board Representation & Bitboards

The absolute foundation of any engine is how it "sees" the game. A highly optimised state representation is critical because the engine will need to store, copy, and evaluate millions of these states per second during a deep search.

Before we talk about moving pieces, we have to talk about how the board is stored. A chess board has 64 squares. By a happy coincidence of computing history, modern CPU registers are standardly 64 bits wide. 

Modern chess engines use **Bitboards**: 64-bit integers where each bit represents a square on the board (1 if occupied, 0 if empty). Instead of keeping one big array that says "Square E4 houses a White Pawn", engines maintain separate bitboards for each piece type. You need 12 in total: White Pawns, White Knights, Black Pawns... all the way to Black Kings.

Using Bitboards means answering chess questions becomes lighting-fast bitwise math. 

Want to know where *all* white pieces are?
```
white_pawns | white_knights | ... | white_king
```
 
Is that square empty?
```
(all_pieces & square_mask) == 0
```

Want to flip the presence of a white knight on a square?
```
white_knights ^ square_mask
```

This is how modern engines evaluate positions millions of times per second.

To replicate this state-of-the-art representation in a database, we hit an immediate wall. Standard SQL *does not have* unsigned 64-bit integers. PostgreSQL, for example, natively only has a signed `BIGINT` (which uses 1 bit for the sign, leaving 63 bits—useless for a full 64-square board!). You *could* painstakingly use a signed `BIGINT`, but it requires injecting lots of computationally expensive conditions into every query just to mask and handle the sign bit correctly. 

Alternatively, you could reach for larger or non-standard SQL data types, but this solution isn't optimal either:
- **ClickHouse**: The leader in this space, offering native 128-bit (`UInt128`) and even 256-bit unsigned integers.
- **MonetDB**: Offers a native 128-bit `HUGEINT` type. 
- **Snowflake**: Its primary numeric type is `NUMBER`, but its internal engine and bitwise functions (like `BITAND`, `BITSHIFTLEFT`) actually operate on and return signed 128-bit integers.
- **PostgreSQL (via Extension)**: While lacking native support in core, the popular `pg-uint128` extension adds unsigned 128-bit integers (which suffers from the severe query overhead of executing over a non-native data type).

This is precisely where DuckDB shines. While a few other databases do support unsigned 64-bit integers natively (such as MySQL and MariaDB with `BIGINT UNSIGNED`, and ClickHouse with `UInt64`), DuckDB combines native `UBIGINT` support without the overhead of 128-bit arithmetic, while providing the embedded analytical engine necessary to process massive game trees locally.

By storing the entire game state as a single database row containing 12 `UBIGINT` columns, we can finally translate chess computations into pure, vectorized SQL operations. The profound elegance of bitboards is most striking when moving a piece down the search tree. Instead of looping over a traditional array to painstakingly clear "Square A1" and write to "Square A2", a move mathematically distills down to two simple square-presence flips. By applying two bitwise `XOR` operations against the original bitboard—one to toggle off the "from" square, and one to toggle on the "to" square—the piece instantly teleports to its new destination. Because DuckDB supports these bitwise operators natively on unsigned integers, the analytical engine can execute these elegant binary flips across millions of rows simultaneously at staggering speeds:

```sql
-- Applying a move to the white pawns bitboard
SELECT 
    -- The xor() function flips the bit at deltaFrom (removing the pawn)
    -- and flips the bit at deltaTo (placing the new pawn)
    xor(s.wP_bb, xor(deltaFrom_mask, deltaTo_mask)) AS wP_bb
FROM current_states s
-- (This happens concurrently for all 12 piece column types)
```

### Pseudo-Move Generation

To look into the future, the engine must systematically generate all possible next moves from a given position. Building the massive tree of variations starts here. These generated moves are "pseudo-legal". This means they follow the basic geometric movement rules of the pieces (e.g., a bishop moving diagonally), but they don't yet account for complex board state rules, like whether making that move would illegally expose the player's own King to check.

**The Imperative Way:** While modern engines don't naively loop over all 64 squares, they *do* iterate piece-by-piece. They grab the bitboard for a specific piece type (like Knights), use hardware instructions to find the first set bit (the square the piece is on), and then loop over its pre-calculated "mobility mask"—a bitboard showing every legally reachable square from that position regardless of whether an enemy piece is there or not—to generate moves.

```cpp
// Generating pseudo-legal moves (imperative bitboard engine)
U64 knights = board.white_knights_bb;

// Loop over every knight we have
while (knights) {
    // Hardware instruction finds the piece's square index
    int sq = pop_lsb(&knights); 
    
    // Look up the mobility mask and loop over every reachable target square
    U64 valid_destinations = KNIGHT_MOBILITY[sq] & ~board.own_pieces_bb;
    while (valid_destinations) {
        int target_sq = pop_lsb(&valid_destinations);
        add_move(move_list, sq, target_sq);
    }
}
// ... repeat this entire process for Bishops, Rooks, Queens, etc.
```

**The SQL Way:** We pre-compute these masks for every piece on every square and store them as two static lookup tables: `mobility_precomputed` (showing where a piece can legally move) and `attacks_precomputed` (a separate table necessary specifically for Pawns, which move forward but capture diagonally). Generating next moves isn't done piece-by-piece; it's a massive, concurrent `JOIN` operation. We explode the current game state out into all its pieces and join them with the pre-computed mobility tables to instantly spawn rows for every possible pseudo-legal continuation for *all* pieces simultaneously.

```sql
SELECT 
    s.id AS parent_id, m.from_sq, m.target_sq AS to_sq, pt.piece
FROM current_states s

-- 1. Explode: Find occupied squares for all active pieces simultaneously
JOIN LATERAL (
    SELECT 2 AS piece WHERE is_bit_set(s.wN_bb, sq.i) UNION ALL
    SELECT 3 AS piece WHERE is_bit_set(s.wB_bb, sq.i) UNION ALL
    -- ... and so on for Rooks, Queens, Kings
) pt ON true

-- 2. Generate pseudo-moves for all regular identified pieces
JOIN mobility_precomputed m ON m.from_sq = sq.i AND m.piece = pt.piece
WHERE (m.ray_mask & s.all_pieces_bb) = 0 
  AND NOT is_bit_set(s.my_pieces_bb, m.target_sq)

UNION ALL

-- 3. Generate pawn captures separately using attack masks
SELECT 
    s.id AS parent_id, sq.i AS from_sq, a.target_sq AS to_sq, 1 AS piece
FROM current_states s
JOIN LATERAL (SELECT 1 AS piece WHERE is_bit_set(s.wP_bb, sq.i)) p ON true
JOIN attacks_precomputed a ON a.from_sq = sq.i AND a.piece = p.piece
-- Pawn attacks are only valid legal moves if an opponent piece is actually there to capture!
WHERE is_bit_set(s.opponent_pieces_bb, a.target_sq) 
```

### Is the King in Check? (Move Validation)

Chess rules forbid making a move that leaves your own King under attack. "Pseudo-move generation" creates moves based on piece logic, but "validation" acts as the strict filter that tosses out the illegal ones before they pollute the search tree.

**The Imperative Way:** While older or simpler engines might literally "make the move, check if the king is attacked, take it back," this is way too slow for a modern engine. Modern engines use bitwise math on the *current* board state. They pre-calculate an "absolute pin mask" for pieces defending the king and evaluate if a proposed move violates a pin or places the King onto an attacked square, usually doing this validation lazily right before the move is searched.

```cpp
// Fast bitwise legality test on the current state (modern imperative)
bool is_legal(Board board, Move move) {
    if (piece_type(move) == KING) {
        return !is_square_attacked(board, to_sq(move), opponent);
    }
    // If piece is pinned, it can only move along the pinning ray.
    // (A jumping Knight's move will never align, cleanly returning false).
    if ((board.pinned_mask & (1ULL << from_sq(move)))) {
        return aligned(from_sq(move), to_sq(move), board.king_sq);
    }
    // ... en-passant edge cases
    return true;
}
```

**The SQL Way:** Interestingly, Quack-Mate's approach is actually closer to the older, slower imperative method. Calculating absolute pin masks dynamically in pure SQL is agonizingly inefficient. Even though DuckDB exposes powerful native bitwise functions (like `bit_count()` for population counts), building a pin mask relationally requires projecting attack rays from every enemy slider towards our King, masking those rays against our own pieces, computing the `bit_count()` to verify if exactly *one* of our pieces sits on that ray, and then feeding those results into a heavy `JOIN` against the pseudo-move pool to restrict the mobility of the pinned pieces.

Instead, DuckDB embraces the brute force of set theory. We skip the messy pre-validation entirely and simply *apply* all pseudo-legal moves (via our ultra-fast bitwise XORs) to spawn a massive CTE of `expanded_states`, and then we filter the illegal boards out. 

To understand why this is feasible in SQL, we have to look at how imperative engines manage memory. To save space and allocation overhead, classical engines typically maintain only a *single* chessboard object in memory. To test a move, the engine mutates that singular state, evaluates it, and then explicitly "un-makes" or takes back the move to restore the board for the next iteration of its `for` loop. Copying the full board object endlessly would crush performance.

SQL flips this paradigm on its head. Generating massive sets of independent, immutable rows is what the relational engine does best. By executing our XOR logic, DuckDB spawns millions of entirely distinct rows representing the newly applied board states. Because each moved piece exists in its own separate universe, we don't have to sequentially "un-make" anything—we just effortlessly drop the illegal rows from the final result set. 

The mechanism for identifying and dropping those illegal rows is surprisingly elegant. To check legality concurrently across millions of these distinct states without the need for complex pin-masks, we perform a "backwards" attack check. In practice, this means we use the enemy pieces' own movement rules in reverse, starting from the King. We look at the King's new square and execute an `EXISTS` subquery finding out if, for example, a Knight placed on the King's square would hit any actual enemy Knights (because if our hypothetical Knight can reach them, their real Knight can reach our King!). 

Why do it backwards? Performance. Remember that the locations of the enemy pieces are compacted into singular 64-bit integers. To perform a "forward" check, the SQL engine would need to know their exact squares. To get those squares, the database must painfully "decompress" the bitboards by exploding them into distinct rows—generating up to 16 intermediate rows per board state. The engine would then have to join every single one of those rows against the precomputed tables to calculate their specific attack masks, and finally verify if our King's square falls within any of them.

While we *do* perform this exact type of bitboard decompression earlier during pseudo-move generation, it is strictly on *our* pieces (not the enemy's), and we only pay that heavy cost *once* per parent board. 

You might wonder: why not just decompress the enemy bitboards at the same time and do the forward legality check *during* move generation? 
1. **The Pin-Mask Problem:** Evaluating legality before a move is actually applied requires computing those painfully complex, dynamic "pin masks" we explicitly built this architecture to avoid. We need the move applied *first* to see the resulting board state. 
2. **Computational Waste:** We generate far more pseudo-legal moves than we actually search. Our pruning techniques will mercilessly discard millions of them. We want to delay computing legality until *after* the moves are applied and filtered, doing as little work as possible on branches that won't survive anyway.

When we finally do validate those surviving child boards, if we used a "forward" attack check, we would be forced to decompress the enemy bitboards for *every single newly generated child state* (which still number in the millions), multiplying the relational cost astronomically.

By checking backwards, we completely skip this secondary bitboard explosion. We constantly track our single King's square, so we only need to perform **one** lookup into the precomputed table per child state. The resulting query row hands us the backward attack masks for all piece types simultaneously. We then simply bitwise `AND` those masks against the fully compacted, unexploded enemy bitboards. If the result is strictly greater than 0, it means an enemy is mathematically standing on a legally attacking square! This approach successfully reduces a massive, multi-row O(N) piece-explosion per state into a blazing fast O(1) lookup.

```sql
SELECT * FROM expanded_states m
-- Filter out the rows where the King is left under attack
WHERE NOT EXISTS (
    SELECT 1 FROM attacks_precomputed ap 
    WHERE ap.square = m.king_sq
    AND (
        -- If we conceptually place a Knight on the King's square, does it hit an enemy Knight?
        (m.enemy_knights_bb & ap.knight_mask) > 0 OR
        -- ... does it hit an enemy pawn? ... etc
        (m.enemy_pawns_bb & ap.pawn_mask) > 0
    )
    -- (A similar subquery checks sliding pieces through mobility_precomputed)
)
```

### Board Evaluation

Once the engine reaches its maximum search depth, it has to stop looking ahead and simply judge the resulting position. This "static evaluation" provides the heuristic score that tells the engine whether a sequence of moves was brilliant or disastrous.

**The Imperative Way:** Historically, static evaluation functions looped over an array representation of the board. An imperative *bitboard* engine speeds this up exponentially by using hardware `popcount` instructions (which instantly count how many bits are set to 1) to sum up material, and `pop_lsb` loops to apply Piece-Square Table (PST) bonuses for positional placement. Modern world-champion engines like Stockfish, however, go infinitely further: they evaluate complex heuristics like pawn structures and king safety, and increasingly rely on efficiently updatable neural networks (NNUE) to score the board state holistically.

```cpp
// A classic bitboard evaluation function
int score = 0;

// Hardware popcount calculates material sums instantly without looping
score += popcount(board.white_queens) * 5;
score -= popcount(board.black_queens) * 5;
score += popcount(board.white_knights) * 2;
score -= popcount(board.black_knights) * 2;
// ... (repeat for all piece types)

// piece-square tables are tabulated by popping bits
U64 white_knights = board.white_knights;
while (white_knights) {
    int sq = pop_lsb(&white_knights);
    score += PST_KNIGHT[sq];
}
// ... (repeat popping loop for black knights, queens, etc.)

// Modern engines eschew all of this for NNUE inferences:
// return evaluate_nnue(board);
return score;
```

**The SQL Way:** Integrating a neural network or complex pawn-structure algorithms into a single recursive SQL query is practically impossible without crushing performance. Therefore, Quack-Mate's evaluation is forced to remain purely mathematical and set-based (the classic Material + PST approach). 

The SQL engine accomplishes this via a correlated subquery. For each board row evaluated from the outer `search_tree`, it pivots the 12 wide bitboard columns into 12 distinct rows on the fly using a `VALUES` table. In practice, this means we construct a massive logical intermediate table containing exactly 12 rows *for every single board state being evaluated*. The engine then performs a single set-based `JOIN` of this massive intermediate set against the pre-computed Piece-Square Table, effortlessly summing up both the material weight and positional bonuses for all pieces across millions of board states simultaneously.

```sql
SELECT 
    id,
    -- We pivot the columns into rows, and join against the Piece-Square Table
    -- to sum up material and positional bonuses in one go!
    COALESCE(
        (SELECT SUM(pst.value)
        FROM pst_values pst, 
        (VALUES 
            (5, wQ_bb), (-5, bQ_bb), -- Queens
            (2, wN_bb), (-2, bN_bb)  -- Knights (etc...)
        ) AS pb(piece, bitboard)
        WHERE pst.piece = pb.piece 
        AND is_bit_set(pb.bitboard, pst.square))
    , 0) AS static_eval
FROM search_tree
WHERE depth = MAX_DEPTH
```

## The Elegance of the Single Query: Recursive Minimax

The engine has now generated the tree of legal moves and statically evaluated the final resulting board states (the leaf nodes). To actually make a decision, these scores need to bubble back up to the root node so the engine can choose the most promising move right now, assuming best play from both sides.

The most elegant part of this pure SQL experiment is the "Recursive Strategy". It tackles this entire generation, evaluation, and score propagation cycle in **one single, glorious query** using a `WITH RECURSIVE` Common Table Expression (CTE). The structural translation is beautiful, mapping perfectly from an imperative Minimax algorithm into the language of relational sets.

In an imperative language, a minimax function calls itself recursively to explore the game tree. Every level in this tree represents a "ply" (a single half-move by either White or Black). At each ply, the algorithm swaps sides and assumes that the player whose turn it is will play perfectly to maximize their own advantage. 

When the search hits the maximum depth limit (the base case), it evaluates the board and recursively bubbles those static scores back up. Because White always wants the highest positive score and Black always wants the lowest negative score, the algorithm mathematically alternates between returning the *maximum* score for White's plies and the *minimum* score for Black's plies—hence the name, "Mini-Max".

*(A note on convention: many chess engines count depth backwards, starting at MAX_DEPTH and decrementing to 0 at the leaves. I have never liked that. Throughout this post and in Quack-Mate's code, depth starts at 0 (the root) and increments to MAX_DEPTH (the leaves). It's just more intuitive.)*

```cpp
int minimax(Board node, int depth, bool is_white_turn) {
    // EVALUATION (base case)
    if (depth == MAX_DEPTH) {
        return static_eval(node);
    }

    // EXPANSION
    MoveList children = generate_moves(node);

    // BACKPROPAGATION & The "Mini-Max" Logic
    int best_score = is_white_turn ? -INFINITY : INFINITY;
    
    for (Move child : children) {
        // Recursively visit children
        int score = minimax(child.board, depth + 1, !is_white_turn);
        
        if (is_white_turn) {
            best_score = max(best_score, score); // White maximises
        } else {
            best_score = min(best_score, score); // Black minimises
        }
    }

    return best_score;
}
```

This maps almost directly to the CTE approach, where the recursion is handled by the database engine:

```sql
WITH RECURSIVE
    search_tree AS (
        SELECT id, state, 0 as depth FROM root -- Root Node
        UNION ALL        
        -- EXPANSION (Top-down)
        SELECT child.id, child.state, parent.depth + 1
        FROM search_tree parent
        JOIN possible_moves child ON ...
        WHERE parent.depth < MAX_DEPTH
    ),
    --- EVALUATION (Base Case)
    leaf_nodes AS (
        SELECT id, parent_id, static_eval(state) as score, depth
        FROM search_tree
        WHERE depth = MAX_DEPTH
    ),
    minimax AS (
        SELECT id, parent_id, score, depth 
        FROM leaf_nodes
        UNION ALL
        SELECT
            parent.id, parent.parent_id, parent.depth,
            --- The "Mini-Max" Logic
            CASE WHEN parent.is_white_turn
                 THEN MAX(child.score) -- White maximises
                 ELSE MIN(child.score) -- Black minimises
            END as score
        FROM search_tree parent --- BACKPROPAGATION (Bottom-Up)
        JOIN minimax child ON parent.id = child.parent_id
        GROUP BY parent.id, parent.parent_id, parent.depth, parent.is_white_turn
    )
SELECT score FROM minimax WHERE depth = 0;
```

It highlights the underlying structure of a minimax algorithm perfectly, purely through sets joining sets.

By using a `GROUP BY parent_id` combined with an aggregate `MAX()` or `MIN()`, SQL effortlessly handles the bubbling up of minimax scores across millions of branches simultaneously.

## The Hard Limits of Elegance

This recursive CTE approach is incredibly neat, but its limitations become apparent rather quickly. It successfully calculates the best move, but it has to analyse *every single possible move* to do so. This is known as an un-pruned search.

To search deep enough to play well, engines rely on **Alpha-Beta Pruning**. Conceptually, Alpha-Beta pruning is a mathematical shortcut: if you are evaluating a sequence of moves and you discover a single opponent response that completely refutes your idea (e.g., you lose your Queen for nothing), you can immediately stop searching that branch. You don't need to know *exactly* how badly you lose if you play it; you just need to know it's worse than an alternative you already found.

For Alpha-Beta pruning to be effective, it inherently requires a **Depth-First Search (DFS)**. The engine must plunge down a single, promising branch all the way to the end to establish a strong "score to beat." This threshold is tracked using two mathematical bounds: **Alpha** (the minimum guaranteed score for the current player) and **Beta** (the maximum score the opponent will ever allow you to achieve). Once those bounds are established, the engine can use them to rapidly prune the remaining, shallower branches.

This is exactly where the single-query SQL approach fails. A `WITH RECURSIVE` query is inherently a **Breadth-First Search (BFS)** engine. It generates *all* moves at depth 1, then *all* responses at depth 2 simultaneously. It cannot plunge down a single path to establish a pruning threshold before looking at the others. Because the engine must hold every single position of every single depth in memory simultaneously, a search depth of merely 3 logical turns becomes a hard limit. Going any deeper means waiting an eternity and watching your RAM vanish into the ether. 

Furthermore, integrating a sequential, threshold-updating logic like Alpha-Beta pruning across parallelised, set-based rows within a single monolithic query is a nightmare to express and practically impossible to execute performantly.

## Breaking the Limit: Orchestration and Iterative Deepening

To make the engine actually playable, elegance had to make way for pragmatism. I implemented a strategy called **Batched Principal Variation Search (BPVS)**. That name is quite a mouthful—we will unpack the exact mechanics of "Batched" and "Principal Variation Search" in the following sections, as they rely on advanced pruning concepts. 

At its foundation, however, BPVS abandons the single recursive SQL query in favour of a lightweight, external Javascript loop acting as an orchestrator. This orchestrator contains no chess logic; its sole responsibility is to track the search state and execute a standard chess technique called **Iterative Deepening**.

Instead of telling DuckDB to search directly to Depth N, the Javascript orchestrator runs a series of discrete searches: Depth 1, then restarting from the root to reach Depth 2, then restarting again for Depth 3, and so on. This might sound incredibly wasteful—why throw away the tree and start over?—but it solves two massive problems:
*   **Memory Efficiency:** A single recursive CTE query is an atomic operation that must hold every intermediate step in memory simultaneously. By breaking the search into discrete transactions, we can physically `DELETE` the massive working tables between iterations, forcing DuckDB to clear its RAM. More importantly, because Iterative Deepening enables effective **Move Ordering**, the tree we build during our final iteration is heavily *pruned* (which is exponentially smaller than the unpruned tree a recursive CTE is forced to generate).
*   **Query Bounds:** The Javascript orchestrator doesn't execute a single SQL query per iteration. Instead, to reach Depth 3, it fires a highly controlled sequence of discrete SQL queries: `expand(0->1)`, then `expand(1->2)`, followed by `evaluate(2)`, and finally `bubble_up(2->0)`. Crucially, Javascript doesn't perform any of these evaluations or bubbling math itself—it contains zero chess logic. It simply acts as a puppet master, orchestrating the state machine by firing the appropriate SQL queries in the correct order. Because the database engine cannot dynamically update Alpha-Beta pruning thresholds mid-query, this sequence allows the orchestrator to pause between SQL executions, read the resulting bounds, and dynamically inject them into the *next* SQL string.

But this raises a glaring question: why restart from Depth 0, duplicating the work of previous iterations? Couldn't we just save the final Depth 2 tree in a table, and exclusively run `expand(2->3)` on its leaves? 

We could, but doing so destroys Alpha-Beta pruning! Alpha-Beta works by establishing a "score to beat" (Alpha) as early as possible. To get a strong Alpha for a Depth 3 search, the engine must start at the root, follow the single most promising path (the Principal Variation) down to Depth 3, evaluate it, and bubble that new score back up to the top. Only armed with that updated global threshold can the engine safely prune terrible branches branching off from Depth 1. If we simply expanded all the old Depth 2 leaves simultaneously, we would have no global threshold to test them against. Furthermore, as new scores are generated at Depth 3, bubbling them back up and updating the evaluations of a massive, pre-existing Depth 2 SQL tree is computationally disastrous. Because a chess tree grows exponentially, the "duplicated work" of simply regenerating those shallow nodes is mathematically negligible compared to the staggering amount of time saved by pruning with a fresh, updated map.

It is this "fresh map" that makes Iterative Deepening the crucial prerequisite for all advanced pruning. Because the engine restarts the search from the root every iteration, it gets to carry over the knowledge it gained from the previous depth. By the time we begin generating the tree for Depth 3, our global Transposition and History tables are already packed with the results from Depth 2. This gives us an incredibly accurate map of which moves we should prioritize searching first!

### The Pruning Prerequisite: Move Ordering

If an engine happens to search the best moves first, it can mathematically prove that certain other branches don't need to be searched at all (this is Alpha-Beta pruning). Guessing which moves will be the best *before* actually searching them is the secret to a fast engine, and the cornerstone of our BPVS approach. 

It is crucial to distinguish **Move Ordering Scores** from the **Static Evaluation** discussed previously. Static Evaluation is a deep, mathematically rigorous judgement of the final board state *at the very end* of a search branch. Move Ordering, conversely, is a "quick and dirty" heuristic applied *before* searching. Its sole job is to guess which moves are the most promising so the engine can search them first. 

**The Imperative Way:** Before diving down into the search tree, engines generate a list of legal moves and assign each a quick `ordering_score`. While this score can sometimes incorporate the current static evaluation as a baseline, it relies heavily on move-specific heuristics, such as prioritising moves that capture a high-value piece using a low-value piece. This specific capturing heuristic is known as MVV-LVA (Most Valuable Victim - Least Valuable Attacker). In practice, MVV-LVA is just one of many heuristics, and a modern engine will usually combine several of them to calculate a move's score (some of these, like "Killer Moves," are discussed below). The `moves` array is then sorted by this combined score.

```cpp
// Score moves before searching them to maximise Alpha-Beta pruning
for (int i = 0; i < move_count; i++) {
    int ordering_score = 0;
    Move m = moves[i];
    
    if (is_capture(m)) {
        // MVV-LVA: Most Valuable Victim - Least Valuable Attacker
        // E.g., Pawn taking a Queen gets a massive ordering score
        ordering_score = (10 * piece_value[captured_piece(m)]) - piece_value[moving_piece(m)];
    } else if (is_killer_move(m)) {
        // Bonus for non-captures that proved strong in sibling branches
        ordering_score = KILLER_BONUS;
    }
    // ... add to static evaluation baseline, etc.
    
    move_scores[i] = ordering_score;
}
// Search the moves with the highest ordering scores first
sort_moves_by_score(moves, move_scores);
```

**The SQL Way:** In our BPVS approach, move ordering is handled via SQL Window Functions. We compute an estimated score for each generated move row based on a strict layering of heuristics. At the absolute top are **Transposition Table** hits (if we've searched this exact position before, the previously found "best move" is almost certainly still the best). This is followed by Captures (MVV-LVA), Checks, and **Killer Moves**. Finally, as a fallback for "quiet moves" (moves that do not capture or check), we use **History scores**—a global table tracking how often a specific piece moving to a specific square has been successful elsewhere. 

*(Note: If concepts like Transposition Tables, Killer Moves, and History scores sound unfamiliar, don't worry! We will break down exactly how they are mechanically implemented in SQL in the heuristic and pruning sections below).*

We use `ROW_NUMBER()` partitioned by the parent board state to rank these sibling moves. Our pipeline then processes the `rank = 1` moves (the most promising ones) first in a "Principal Variation" batch, aggressively establishing a high Alpha threshold to prune the subsequent batches.

```sql
SELECT *,
    ROW_NUMBER() OVER (
        PARTITION BY parent_id 
        ORDER BY (
            -- 1. TT Best Move: > 2,000,000
            (CASE WHEN is_tt_hit = 1 THEN 2000000 ELSE 0 END) +
            -- 2. Captures (MVV-LVA): > 1,000,000
            (CASE WHEN is_capture = 1 THEN 1000000 + (piece_val(captured) * 10 - piece_val(attacker)) ELSE 0 END) +
            -- 3. Checks: > 600,000
            (CASE WHEN is_check = 1 THEN 600000 ELSE 0 END) +
            -- 4. Killers: > 500,000
            (CASE WHEN is_killer = 1 THEN 500000 ELSE 0 END) +
            -- 5. History + Positional (PST): < 400,000
            COALESCE(history_score, 0) + COALESCE(pst_value, 0)
        ) DESC
    ) as rank
FROM candidate_moves
```

Let's take a deep dive into the specific techniques integrated to squeeze every drop of performance out of the engine, and how the conceptual leap from arrays to tables is made.

### Principal Variation Search (PVS) & Alpha-Beta Pruning

While standard Alpha-Beta pruning is the mathematical foundation of modern chess engines, Quack-Mate skips implementing it directly and instead relies exclusively on a more advanced variant called **Principal Variation Search (PVS)**. As we will see later, this is not just an optimization, but a structural necessity for the database architecture. The core premise of PVS is that if our move ordering is good, the very first move we examine (the Principal Variation, or PV) is highly likely to be the best. 

**The Imperative Way:** In a standard imperative language, the PVS algorithm searches this first expected "best move" with a standard, wide "full window" (passing the actual, broad **Alpha** and **Beta** bounds) to figure out exactly how good it is. 

For all subsequent sibling moves, we assume they are *worse* than the PV. We can prove this quickly by searching them with a "zero window" (where `alpha` and `beta` are identical). A zero-window search is incredibly fast because almost every branch is instantly pruned. If the result proves the move *is* worse, great! We move on. If it somehow proves it's better, we must re-search that move with a full window to find its true score.

```cpp
int pvs(Board node, int ply, int limit, int alpha, int beta) {
    if (ply == limit) return static_eval(node);
    bool is_first_move = true;
    for (Move m : generate_moves(node)) {
        Board next = apply_move(node, m);
        int score;

        if (is_first_move) {
            // Full-window search for the expected best move
            score = -pvs(next, ply + 1, limit, -beta, -alpha);
            is_first_move = false;
        } else {
            // Zero-window search for the rest, expecting them to fail
            score = -pvs(next, ply + 1, limit, -alpha - 1, -alpha);

            // If it failed high, we guessed wrong. Re-search with full window!
            if (score > alpha && score < beta) {
                score = -pvs(next, ply + 1, limit, -beta, -alpha);
            }
        }
        if (score >= beta) return beta;   // Pruning Cut-Off!
        if (score > alpha) alpha = score; // Update best score
    }
    return alpha;
}
```

**The SQL Way:** This is where the "Batched" in BPVS comes in to save the day. In a traditional engine, you search moves sequentially, one by one. In SQL, searching 30 moves sequentially means 30 round-trips to the database, which is cripplingly slow. However, if you shove all 30 remaining moves into a single SQL query, you cannot update your Alpha-Beta thresholds *between* them, rendering your pruning useless.

We need a compromise. We take our entire pipeline of ordered moves and slice the execution horizontally into **Batches**:
1.  **Batch 1 (PV Nodes):** The top `rank = 1` moves representing the single most promising path for every parent. We search this relatively tiny set of moves at full depth with a full-window to quickly establish strong `alpha` and `beta` thresholds.
2.  **Batch 2+ (Rest Nodes):** The remaining alternate moves. Instead of generating the entire rest of the game tree at once, we chunk them into smaller batches of 256. We evaluate one batch, calculate the new minimax scores, update our `alpha` threshold, and then use that threshold to prune descendants in the *next* batch.

This creates a brilliant "Hybrid" search: Depth-First for the macro-tree (stepping ply-by-ply via the orchestrator), but Breadth-First for the micro-tree (evaluating batches of moves as sets).

You might be wondering: *Could we have just used simple Alpha-Beta mapped to these batches, instead of jumping to a more advanced variant like PVS?* We could, but standard Alpha-Beta is fundamentally fluid—the `alpha` threshold updates continuously as sibling moves are evaluated. If a batch of 256 moves was evaluated simultaneously using standard Alpha-Beta, the 2nd move might improve `alpha`, meaning the 3rd move *should* have been instantly pruned. Because SQL evaluates the entire batch at once, we would waste massive compute cycles expanding the 3rd move before the JavaScript loop could register the new threshold. 

This is why PVS is a structural necessity for SQL. By evaluating the remaining sibling moves under the assumption that they will strictly *fail* against a fixed, identical boundary (the zero-window), PVS creates a perfectly static expectation. This allows DuckDB to aggressively verify thousands of rows in bulk without needing to coordinate threshold updates mid-query.

### Transposition Tables (TT)

In chess, many different sequences of moves can lead to the exact same board position (a transposition). Without memory, an engine will stupidly re-evaluate the same position millions of times. A Transposition Table solves this by acting as a global cache, serving two distinct and incredibly powerful roles:
1. **Total Branch Pruning**: If we reach a board state we have evaluated before, and our previous search was *at least as deep* as our current requirement, we can instantly return the cached `score` and skip searching the entire branch. 
2. **Move Ordering**: If we reach a previously evaluated state, but we need to search it *deeper* than we did before, we cannot use the old cached score. However, we *can* look at the `best_move` that was saved during that shallow search and heavily prioritize testing it first, massively increasing our chances of an early Alpha-Beta cutoff!

To do this efficiently, all modern engines (including Quack-Mate) identify repeating positions using a **Zobrist Hash**, a brilliant application of bitwise math. A random, static 64-bit number is pre-generated for every possible piece type appearing on every possible square (yielding an array of 12 piece types × 64 squares = 768 random numbers, plus a handful of extras to track castling rights and turn order). To calculate the hash for any board state, the engine simply takes the random numbers corresponding to the pieces currently on the board and XORs (`^`) them all together. Because `A ^ A = 0`, engines can update this hash incredibly fast incrementally: if a Knight moves from g1 to f3, the engine just takes the old board hash, XORs it by `Random(White Knight on g1)` to remove the piece, and then XORs by `Random(White Knight on f3)` to place it.

Where engines diverge is how they *store* and look up these hashes.

**The Imperative Way:** This blazing-fast 64-bit Zobrist Hash is used as the primary key in a massive, painstakingly pre-allocated memory map (the Transposition Table) living in raw RAM, which must be carefully protected by complex read/write locks when the engine is using multiple threads.

```cpp
// Probe the TT before searching
TTEntry entry = transposition_table[zobrist_hash];
// Did we search this position at least as deep as we are now?
if (entry.is_valid && entry.limit >= limit) {
    return entry.score; // Cache hit! Skip the search.
}
// ... after searching, lock and save back to the TT
transposition_table[zobrist_hash] = {limit, score, best_move};
```

**The SQL Way:** In SQL, memory management, lock-contention, and hash-mapping are entirely abstracted away. A Transposition Table is literally just a database table (`CREATE TABLE transposition_table(...)`). Reading from it is a standard `LEFT JOIN ON (hash)`. 

Updating the TT for thousands of evaluated nodes simultaneously is beautifully concise, leveraging standard `UPSERT` semantics. DuckDB handles the parallel execution and memory locking effortlessly:

```sql
INSERT INTO transposition_table (board_hash, static_eval, depth, best_move_from, best_move_to)
SELECT 
    st.board_hash, 
    st.minimax_eval,
    (MAX_DEPTH - st.depth) as remaining_depth,
    bm.from_sq, 
    bm.to_sq
FROM search_tree st
-- Join to find the specific move that yielded the minimax evaluation
LEFT JOIN tt_best_moves bm ON (bm.parent_id = st.id AND bm.minimax_eval = st.minimax_eval)
WHERE st.minimax_eval IS NOT NULL
-- Upsert logic: only retain the newest evaluation if it searched deeper!
ON CONFLICT (board_hash) DO UPDATE SET
    static_eval = EXCLUDED.static_eval,
    depth = EXCLUDED.depth,
    best_move_from = EXCLUDED.best_move_from,
    best_move_to = EXCLUDED.best_move_to
WHERE EXCLUDED.depth >= transposition_table.depth;
```

### Killer Move Heuristic

Suppose we are exploring different ways to respond to our opponent. If a specific "quiet" move (like a solid knight jump that doesn't capture anything) proves to be devastating in one variation, it is highly likely to be a devastating response in similar variations too. This is known as a "killer move."

**The Imperative Way:** The engine tracks a couple of recent "killer moves" per search depth in a small array. During move generation, if a standard generated move matches a stored killer move for that depth, its ordering score is artificially inflated.

```cpp
if (m == killer_moves[depth][0] || m == killer_moves[depth][1]) {
    ordering_score += KILLER_BONUS;
}
```

**The SQL Way:** We maintain an explicit `killer_moves` table. When generating our `candidate_moves`, we use a correlated `EXISTS` clause to instantly add a massive numeric offset to the `move_order_score`.

```sql
SELECT
    m.from_sq, m.to_sq, m.piece,
    -- ... other scoring logic ...
    (CASE 
        WHEN EXISTS(
            SELECT 1 FROM killer_moves km 
            WHERE km.depth = parent.depth 
            AND km.from_sq = m.from_sq 
            AND km.to_sq = m.to_sq
        ) 
        THEN 500000 -- Massive ordering bonus!
        ELSE 0 
    END) as killer_bonus
FROM search_space parent 
JOIN possible_moves m ...
```

This violently bubbles those specific rows to the very top of their respective batches, practically guaranteeing they are searched immediately after the PV node and captures! 

### History Heuristic

Killer Moves remember specific moves that worked well at a given depth. The **History Heuristic** takes a broader view: it maintains a global score for every `(piece, destination_square)` combination across the entire search. Every time a move causes a Beta cutoff (a pruning success), its history score is incremented. Over time, the history table learns that, say, "a Knight landing on d5 tends to be a strong move" regardless of the surrounding context.

**The Imperative Way:** Engines typically maintain a 2D array indexed by `[piece][to_square]`. When a move causes a cutoff, its entry is incremented by a bonus proportional to the remaining search depth. Cutoffs higher up in the tree (with more remaining depth) receive a much larger bonus because they prune exponentially larger subtrees.

```cpp
// After a Beta cutoff:
// The further we are from the limit, the more important this cutoff is.
int importance = (MAX_DEPTH - ply);
history_table[moving_piece][to_square] += importance * importance;
```

**The SQL Way:** The history table is, naturally, a database table. After each BPVS iteration completes, the orchestrator fires a bulk `UPSERT` to merge the successful moves' scores into the global `history_moves` table.

```sql
INSERT INTO history_moves (piece, to_sq, score)
SELECT piece, to_sq, remaining_depth * remaining_depth
FROM search_tree
WHERE is_cutoff = 1
ON CONFLICT (piece, to_sq) DO UPDATE SET score = history_moves.score + EXCLUDED.score;
```

During subsequent move ordering, this accumulated history score is retrieved via a simple `LEFT JOIN` and added to the ordering formula as the lowest-priority tiebreaker for quiet moves. Over many iterations, the history table organically learns to surface strong positional moves that no other heuristic would catch.

---

The heuristics above all serve a single purpose: deciding *in which order* to search moves. But once our move ordering is strong, we can go further and ask a more aggressive question: *can we skip searching certain moves entirely?* The following techniques are **lossy pruning strategies**—they risk missing a good move in exchange for massive search speed. Unlike Alpha-Beta (which is mathematically safe), these techniques can occasionally cause the engine to overlook a brilliant move. The trade-off is almost always worth it.

### Static Null Move Pruning (Reverse Futility Pruning)

Sometimes, a position's static evaluation is so overwhelmingly winning that even if we gave our opponent a completely "free turn" (a null move), they *still* couldn't bring the score back within the Alpha-Beta window.

**The Imperative Way:** Before generating any legal moves for a node, the engine takes a quick look at the static evaluation. If the `static_eval` minus a massive safety margin is *still* higher than the Beta cutoff, the engine simply declares the position a win and prunes the entire branch immediately without generating a single child!

```cpp
// Static NMP (Reverse Futility Pruning)
// Only safe if we aren't already at the very end of our search
if (ply < limit && !is_check) {
    int margin = 2000;
    if (static_eval - margin >= beta) {
        return static_eval; // Prune!
    }
}
```

**The SQL Way:** Quackmate executes this pruning natively across the entire `frontier_nodes` table (a temporary staging table holding the board states at the current search depth that are awaiting move generation) simultaneously, before triggering the expensive Move Generation JOINs. 

```sql
-- Instantly prune nodes that fail high statically
UPDATE search_tree 
SET minimax_eval = static_eval 
WHERE id IN (
    SELECT id FROM frontier_nodes
    WHERE is_check = 0 
    AND (
        (active_turn = 1 AND static_eval - 2000 >= loopBeta) OR
        (active_turn = -1 AND static_eval + 2000 <= loopAlpha)
    )
);

-- Delete them from the frontier so they never generate children!
DELETE FROM frontier_nodes WHERE ...
```

This single `DELETE` operation effortlessly vaporises thousands of branches from the tree before DuckDB ever has to calculate their complex pseudo-legal attacks. 

### Forward Futility Pruning

While *Reverse* Futility Pruning works on the parent nodes *before* generating moves, *Forward* Futility Pruning aggressively culls the resulting *children* right *after* they are born. You might wonder: couldn't both checks just happen at the same level? No, because the distinction is about *timing*. RFP's entire value lies in skipping the expensive move generation step altogether — in SQL terms, avoiding the massive JOINs. FFP, on the other hand, handles a subtler case: the parent position isn't overwhelmingly winning (so RFP didn't fire), but specific quiet children are individually hopeless. You can only know *which* children are hopeless after generating them.

If a newly generated quiet move (not a capture, check, or promotion) results in a static evaluation that is hopelessly far below our `alpha` threshold, we throw it away before ever pursuing it deeper.

**The Imperative Way:** Inside the main search loop, near the horizon (typically within 1-2 plies of the leaves), the engine calculates the new static evaluation of the resulting board. If it's terrible, it `continue`s to the next move, saving a recursive call. At greater remaining depths this heuristic is considered too risky, since hidden tactical combinations could invalidate a shallow static judgement.

```cpp
// Forward Futility Pruning (Child Nodes, near the limit)
if (ply + 2 >= limit && !is_capture && !is_check && !is_promo) {
    int child_eval = evaluate(child_node);
    if (child_eval + PRUNING_MARGIN < alpha) {
        continue; // Hopelessly bad move. Skip it!
    }
}
```

**The SQL Way:** Quack-Mate takes a more aggressive stance here: it applies FFP at *every* depth, not just near the horizon. This is a deliberate trade-off. In the SQL architecture, every surviving child row must be inserted into the `search_tree`, hashed, evaluated, and aggregated during minimax backpropagation — so the cost of keeping a useless row is proportionally much higher than in an imperative engine where skipping a recursive call is cheap. In Quackmate's massive Move Generation query, we compute the new `static_eval` for millions of child nodes incrementally, directly inside the `SELECT` clause using our loaded `pst_values` tables. We then use a simple `WHERE` filter at the absolute bottom of the CTE to block hopeless nodes from ever entering the `search_tree` table.

```sql
SELECT * FROM expanded_scored
WHERE is_legal_check = 0
-- White just moved. If the score is hopelessly below Alpha, prune it!
AND NOT (
    active_turn_parent = 1 
    AND static_eval < loopAlpha - 150
    AND is_check = 0
    AND is_promo = 0
    AND is_capture = 0
)
```

By adding this declarative `AND NOT (...)` filter, the relational engine effortlessly throws away millions of useless branches on the fly during the join projection.

### Late Move Reductions (LMR)

Forward Futility Pruning permanently discards moves based on their *static evaluation* — if the resulting position is hopelessly bad, throw it away. But what about quiet moves that survive all our pruning filters and don't *look* terrible, but simply ranked very low in the move ordering? They're probably useless, but we can't be sure enough to throw them away entirely. LMR takes a more cautious approach: instead of discarding these late-ranked moves, it gives them a *quick trial* by searching them at a reduced depth. If the shallow search confirms they're bad, we move on. If it surprisingly reveals the move is good, the engine re-searches it at full depth — no harm done.

**The Imperative Way:** Instead of searching this late-ranked move at the full depth, the engine intentionally searches it at a reduced depth. If this reduced-depth search surprisingly returns a score that beats Alpha, the engine is forced to admit it misjudged the move and re-searches it at the correct full depth.

```cpp
// If it's a quiet move deep in the sorted array
// and we have enough room left to bother reducing
if (is_quiet(m) && move_index > 4 && ply + 3 <= limit) {
    // Search with a reduced limit (testing only to limit - 1)
    score = -pvs(next, ply + 1, limit - 1, -alpha - 1, -alpha);
    if (score > alpha) {
        // We guessed wrong! Re-search at the full intended limit.
        score = -pvs(next, ply + 1, limit, -beta, -alpha);
    }
}
```

**The SQL Way:** In our BPVS loop, only Batch 0 (our PV and immediate Captures) is evaluated at full depth. For all subsequent batches, the Javascript orchestrator intentionally sends a SQL query asking DuckDB to calculate the board states with an artificially lower depth.

```javascript
// Orchestrator: If we are in a late batch, artificially reduce the depth horizon
let search_depth = target_depth;
if (batch_id > 0 && target_depth > 2) {
    search_depth = target_depth - 1; 
}

// Generate the SQL string with the reduced target depth
const sql = getExpandFromRawMovesSQL(..., search_depth, ...);
await db.query(sql);
```

If any rows mechanically evaluated in that bulk operation return a score that surprisingly beats our `alpha` threshold, they are flagged, routed back to the temporary `frontier_nodes` table, and expanded *again*—this time with the correct, full depth!

---

## The SQL Engine in Action

Before diving into the complexities of parallelisation, it is worth pausing to see the culmination of all these techniques. Here is the DuckDB native engine (using BPVS and 1 Thread at Depth 3) playing a game against itself through the browser interface:

![Quack-Mate UI demo in action: Two DuckDB engines playing each other.](/assets/videos/quackmate_demo.webp)

As the game unfolds, the Javascript orchestrator furiously fires perfectly bounded 1-ply SQL queries at the database, while the right-hand inspection panel streams the live execution logs. Even restricted to a single thread per engine, the performance is remarkably stable. Both sides evaluate their moves in an average of 1.4 seconds. More importantly, they each evaluate an average of only ~1,050 nodes per move—a massive reduction from the 9,300 un-pruned combinations mathematically possible at depth 3. The SQL-based Alpha-Beta pruning is actively saving the database from an avalanche of useless calculations.

## The Catch-22 of SQL Parallelisation

When I first envisioned Quack-Mate, my grandest hope was built on a naive assumption: if I represent move generation as a massive set-based `JOIN` operation, a modern analytical engine like DuckDB would automatically scale it across all available CPU cores. I imagined throwing 16 or 32 threads at the engine and watching it effortlessly obliterate the combinatorial explosion.

The reality was a harsh lesson in the fundamental differences between OLAP (Online Analytical Processing) workloads and adversarial game trees. Not only did adding cores fail to speed up Quack-Mate, but in many configurations, *more threads actually hurt performance*. This paradox breaks down into three core issues:

**1. The Vectorization Threshold & Synchronisation Barriers**
DuckDB is a vectorized database; it processes data in strict chunks (typically 2,048 rows at a time) and assigns these chunks to threads in its pool. At search depths of 1 or 2, there simply aren't enough valid chess moves to fill more than a single vector chunk. Even at depth 3 (roughly 9,300 states from the starting position), the engine only generates enough valid rows to fill 4 or 5 chunks. 

Crucially, DuckDB evaluates `WITH RECURSIVE` queries (and repeated BPVS queries) using step-by-step synchronisation barriers. The database must finish calculating an entire iteration (depth level), merge the delta into a temporary table, and force all threads to wait at a barrier before starting the next depth. Because calculating bitwise math on a small chunk of rows takes nanoseconds, assigning these microscopic workloads across multiple threads is wildly inefficient. The active threads spend significantly more time spinning up, acquiring locks, and waiting at these synchronisation barriers than they do actually evaluating the bitboards. This is why at depths 1 through 3, adding even 2 or 3 threads makes the engine actively slower than a single, sequential thread blasting through the vectors without any lock contention.

The natural thought is: *why not just search to depth 4, 5, or 6, where the tree explodes into millions of rows, to finally saturate all 16 cores and overcome the synchronisation overhead?*

The answer depends on the strategy you use, and both lead to failure:

**2. The Recursive CTE Memory Wall**
If you attempt to reach depth 4 or 5 using the single-query `WITH RECURSIVE` strategy, you will indeed generate enough rows to fully saturate the CPU. However, a recursive CTE fundamentally evaluates the tree "Breadth-First," meaning it is practically incapable of leveraging Alpha-Beta pruning. Because it explores every brilliant and terrible line equally, the tree mathematically explodes.

More importantly, a single recursive SQL query is an **atomic memory operation**. DuckDB must maintain the entire execution state, including all intermediate working tables for all depth levels, in its internal buffers until the query completes. At Depth 5, this represents millions of rows that cannot be cleared.

Even the simplest BPVS configuration (which is just Iterative Deepening without pruning) bypasses this wall. Because it uses a Javascript loop to fire discrete SQL queries, each query is a separate transaction. Between iterations, we physically `DELETE` rows from the `search_tree`, forcing the database to compact and reuse memory pages. This "sharded" lifecycle allows the engine to reach depths that would otherwise crash the database.

**3. The Alpha-Beta Sequential Bottleneck**
To make depth 4 and 5 actually reachable without crashing the database, I had to abandon the pure recursive approach for **BPVS**. This strategy relies heavily on Alpha-Beta pruning, which is inherently *sequential*. To structurally prune terrible branches, the engine must plunge *Depth-First* down the most promising paths to quickly establish an Alpha/Beta threshold score.

To mimic this in SQL, the BPVS orchestrator deliberately shards "sibling moves" into small, manageable batches (e.g., 256 moves at a time). We evaluate a batch, update the pruning threshold, and use that threshold to brutally discard the millions of useless descendants lurking in the *next* batch. 

This creates a nuanced scaling curve. Because a batch of 256 parent moves generating their immediate descendants in a single ply will only spawn roughly 5,000 to 8,000 new board states, it produces just enough vector chunks to satisfy a *handful* of threads. Testing confirms this: going from 1 thread to 2 threads in BPVS at Depth 5 does yield a modest speedup, and 3 or 4 threads may squeak out a marginal gain over 2. However, it quickly hits a brick wall. Pumping in 8 or 16 threads completely starves the pool again, causing the barrier synchronisation to overwhelm the bitwise processing logic. 

As a fun aside, initially forcing DuckDB to run multi-threaded BPVS natively ballooned its RAM footprint and crashed the browser. By default, DuckDB guarantees that output rows are returned in the exact order they were inserted. This means that if Thread 3 finishes calculating its chunk of the game tree faster than Thread 2, it *cannot* output the rows yet—it must stubbornly buffer them in memory until Thread 2 catches up. In a WebAssembly browser environment strictly constrained to a 4GB memory limit, this chaotic intermediate buffering overhead reliably causes the engine to suffer an Out-of-Memory crash when using exactly 3 threads (where the chunk distribution happens to mismatch badly) at depth 6. You must explicitly configure the database with `PRAGMA preserve_insertion_order=false;` to allow the threads to dump their arrays instantly!

**The Multi-Ply Compromise?**
This naturally begs another question: *what if we compromise and generate 2 or 3 plies per SQL query instead of just 1?* We could use nested `JOIN`s to generate deeper sub-trees for a batch, sacrificing some fine-grained pruning but finally generating enough rows to saturate 16 threads. 

The math, unfortunately, tells us that this is a losing trade. Adding CPU cores scales processing power *linearly* (e.g., a massive 16x boost in throughput). However, the branching factor of chess is roughly 30. Losing pruning granularity for just two plies means generating 30 × 30 = 900 times more nodes in that specific branch. A 16x linear boost in hardware throughput can *never* outrun a 900x exponential explosion in generated garbage. You end up relying on hardware to violently tear through millions of terrible positions that a 1-core engine, using tight 1-ply pruning queries, would have skipped entirely. 

This is the ultimate Catch-22 of SQL chess: to saturate modern analytical CPU cores, you must feed the engine massive, unpruned queries. But to survive the combinatorial explosion of chess, you absolutely *must* aggressively prune the tree, which forces the database into a microscopic, sequential, and highly "chatty" workload that leaves your extra threads starved and useless.

**How Do Classical Engines Solve This?**
It is worth noting that classical, imperative chess engines (written in C, C++, or Rust) face a similar conceptual challenge: Alpha-Beta pruning is inherently sequential. However, they bypass the parallelisation bottleneck using an architecture called **Lazy SMP** (Symmetric Multiprocessing). Instead of trying to parallelise the inner *loops* of move generation, classical engines simply spawn 16 entirely independent search threads. Each thread searches the exact same game tree simultaneously, but with slightly different random noise or move-ordering heuristics. They don't explicitly coordinate; instead, they asynchronously dump their evaluations into a massive, shared lockless hash map in RAM (the Transposition Table). If Thread A finds a brilliant pruning refutation, it drops it in the hash map, and Thread_B instantly reads it nanoseconds later to prune its own branch. 

Quack-Mate cannot replicate Lazy SMP because DuckDB (like most analytical databases) uses a strict concurrency model designed to protect data integrity: infinite concurrent readers, but heavily synchronised concurrent *writers*. If we spawned 16 massive independent BPVS searches simultaneously, they would aggressively bottleneck at the database's Write-Ahead Log (WAL) while attempting to `UPSERT` into the same Transposition Table. The threads would queue up at the database lock level, running no faster than 1 thread, but now saddled with crippling transaction overhead. Classical engines scale because they can directly mutate raw, lockless bytes in RAM—a luxury SQL databases structurally deny by design.

## Benchmarking the SQL Optimisations

To truly understand how Quack-Mate performs, we need to look at the numbers. The following benchmarks were run at **Depth 5** on a single thread (using an in-memory DuckDB instance on an Intel i9-12900T). We tested four positions selected from the well-known "Perft" suites, which are standard testing benchmarks widely used by the computer chess community to validate move generation and engine performance. They include the standard start position, the highly tactical "KiwiPete", a standard endgame, and a complex mid-game. 

For clarity, the configurations build upon each other cumulatively. The abbreviations used in the tables correspond to the following standard chess techniques:
- **ID**: Iterative Deepening
- **AB**: Alpha-Beta Pruning
- **LMP**: Late Move Pruning
- **BPVS**: Batched Principal Variation Search (it includes at least ID, AB, LMP)
- **MVVLVA**: Most Valuable Victim - Least Valuable Attacker (Capture sorting)
- **TT**: Transposition Table
- **PST**: Piece-Square Tables
- **Killers**: Killer Heuristic
- **History**: History Heuristic 
- **RFP**: Reverse Futility Pruning (also known as Static Null Move Pruning)
- **FFP**: Forward Futility Pruning
- **LMR**: Late Move Reduction

The metrics tracked are the chosen move, score (in centipawns), total nodes evaluated, time taken, Nodes Per Second (NPS), and the Peak Resident Set Size (RSS) memory footprint. A dash (`-`) indicates the configuration crashed by exhausting available memory (Out-Of-Memory).

### Board 1: Start Position
<small><code>rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1</code></small>

<img src="https://lichess1.org/export/fen.gif?fen=rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR" alt="Start Position" width="250" />

| Config | Move | Score | Nodes | Time (ms) | NPS | Peak RSS (MB) |
|---|---|---|---|---|---|---|
| Recursive (Exhaustive) | d2d4 | 110 | 5,071,234 | 186,450 | 27,199 | 49,607.0 |
| ID (Exhaustive) | d2d4 | 110 | 5,287,598 | 80,555 | 65,640 | 48,755.1 |
| BPVS<br>(ID + AB + LMP + Batches) | e2e4 | 110 | 834,440 | 19,693 | 42,373 | 12,406.1 |
| + MVVLVA | e2e4 | 110 | 834,440 | 18,718 | 44,579 | 3,963.9 |
| + TT | d2d4 | 110 | 860,024 | 20,468 | 42,017 | 3,998.3 |
| + PST | d2d4 | 100 | 761,339 | 16,201 | 46,993 | 3,998.3 |
| + Killers | e2e4 | 110 | 761,278 | 16,105 | 47,271 | 3,710.4 |
| + History | e2e4 | 110 | 761,273 | 16,122 | 47,219 | 3,758.2 |
| + RFP | d2d4 | 100 | 804,509 | 18,614 | 43,221 | 3,758.2 |
| + FFP | e2e4 | 110 | 283,934 | 9,754 | 29,111 | 3,344.5 |
| + LMR | e2e4 | 110 | 306,699 | 9,716 | 31,567 | 2,052.6 |

### Board 2: Complex Mid-game
<small><code>r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10</code></small>

<img src="https://lichess1.org/export/fen.gif?fen=r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1" alt="Complex Mid-game Position" width="250" />

| Config | Move | Score | Nodes | Time (ms) | NPS | Peak RSS (MB) |
|---|---|---|---|---|---|---|
| Recursive (Exhaustive) | - | - | - | - | - | OOM |
| ID (Exhaustive) | - | - | - | - | - | OOM |
| BPVS<br>(ID + AB + LMP + Batches) | c3d5 | 410 | 2,667,238 | 71,651 | 37,225 | 11,108.5 |
| + MVVLVA | c3d5 | 335 | 1,792,858 | 45,977 | 38,994 | 11,052.0 |
| + TT | c3d5 | 335 | 1,836,458 | 48,275 | 38,041 | 8,407.3 |
| + PST | c3d5 | 335 | 1,775,465 | 47,296 | 37,540 | 8,364.8 |
| + Killers | c3d5 | 335 | 1,676,612 | 45,807 | 36,601 | 7,997.8 |
| + History | c3d5 | 335 | 1,676,612 | 45,190 | 37,101 | 7,870.4 |
| + RFP | c3d5 | 335 | 212,065 | 14,315 | 14,814 | 7,870.2 |
| + FFP | c3d5 | 330 | 3,647,133 | 100,753 | 36,199 | 14,613.7 |
| + LMR | c3d5 | 330 | 3,800,686 | 99,543 | 38,181 | 15,155.1 |

### Board 3: "KiwiPete" (Highly Tactical)
<small><code>r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1</code></small>

<img src="https://lichess1.org/export/fen.gif?fen=r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R" alt="KiwiPete Position" width="250" />

| Config | Move | Score | Nodes | Time (ms) | NPS | Peak RSS (MB) |
|---|---|---|---|---|---|---|
| Recursive (Exhaustive) | - | - | - | - | - | OOM |
| ID (Exhaustive) | - | - | - | - | - | OOM |
| BPVS<br>(ID + AB + LMP + Batches) | e2a6 | 375 | 9,359,433 | 227,171 | 41,200 | 21,576.4 |
| + MVVLVA | e2a6 | 375 | 7,526,634 | 188,566 | 39,915 | 21,429.7 |
| + TT | e2a6 | 375 | 7,524,113 | 187,634 | 40,100 | 20,685.0 |
| + PST | e2a6 | 375 | 6,912,192 | 154,190 | 44,829 | 20,493.1 |
| + Killers | e2a6 | 375 | 6,912,008 | 155,012 | 44,590 | 20,400.0 |
| + History | e2a6 | 375 | 6,912,171 | 156,670 | 44,119 | 20,568.4 |
| + RFP | e2a6 | 170 | 468,312 | 16,762 | 27,939 | 20,440.6 |
| + FFP | e2a6 | 170 | 403,228 | 16,334 | 24,686 | 3,053.6 |
| + LMR | e2a6 | 170 | 412,643 | 16,661 | 24,768 | 2,950.3 |

### Board 4: Endgame
<small><code>8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1</code></small>

<img src="https://lichess1.org/export/fen.gif?fen=8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8" alt="Endgame Position" width="250" />

| Config | Move | Score | Nodes | Time (ms) | NPS | Peak RSS (MB) |
|---|---|---|---|---|---|---|
| Recursive (Exhaustive) | b4f4 | 110 | 716,960 | 24,158 | 29,678 | 7,598.5 |
| ID (Exhaustive) | b4f4 | 110 | 766,295 | 15,619 | 49,062 | 7,598.5 |
| BPVS<br>(ID + AB + LMP + Batches) | b4f4 | 110 | 183,780 | 6,819 | 26,950 | 3,158.0 |
| + MVVLVA | b4f4 | 110 | 191,927 | 7,175 | 26,748 | 1,367.4 |
| + TT | b4f4 | 110 | 164,969 | 6,532 | 25,257 | 1,367.4 |
| + PST | b4f4 | 110 | 140,247 | 6,276 | 22,345 | 1,259.7 |
| + Killers | b4f4 | 110 | 135,138 | 6,162 | 21,930 | 1,143.6 |
| + History | b4f4 | 110 | 135,138 | 6,148 | 21,980 | 1,104.2 |
| + RFP | b4f4 | 110 | 91,956 | 5,491 | 16,746 | 1,104.2 |
| + FFP | b4f4 | 110 | 105,394 | 5,913 | 17,825 | 1,002.6 |
| + LMR | b4f4 | 110 | 106,700 | 5,691 | 18,749 | 1,008.8 |

### Analysing the Results

The benchmark data highlights the fundamental differences between building a chess engine in SQL versus a classical systems language, particularly regarding memory allocation and heuristic overhead.

**Taming the Memory Wall with Batched Search**
Pure recursive or iterative deepening searches (ID) suffer from combinatorial explosion, keeping the entire unpruned breadth of the tree in memory simultaneously. The Batched Principal Variation Search (BPVS) solves this by integrating Alpha-Beta pruning with transactional chunking: memory is only held for the current batch being evaluated. By breaking the expansion into strict limits (evaluating exactly 4 moves per parent in the initial batch), BPVS definitively shatters the memory wall. 

On the Start Position, moving from the purely combinatorial `ID (Exhaustive)` down to `BPVS` cuts the memory footprint by **75%**, dropping it from a massive 49GB down to a manageable 12GB. In the Endgame position, the footprint drops from 7.5GB down to just 3.1GB, making the engine viable on standard hardware.

**The Overhead of Move Ordering in SQL**
In classical engines, lookups against Transposition Tables (TT) or Piece-Square Tables (PST) cost nanoseconds. In a relational database engine, they require explicit `LEFT JOIN` operations across large tables, introducing measurable query execution overhead.

The data shows this is a calculated trade-off. On highly tactical boards like "KiwiPete" (Board 3), the combined effect of TT, PST, and History heuristics provides massive structural benefits, reducing the node count from 9.3 million down to 6.9 million and shaving nearly 70 seconds off the compute time. Conversely, on simpler boards like the Start Position, the complex `ORDER BY` clauses required for these heuristics do not produce enough Alpha-Beta cutoffs to offset their SQL join overhead, occasionally resulting in fractionally slower times despite evaluating fewer nodes.

**The Dynamics of Pruning and Search Instability**
Aggressive pruning techniques—Reverse Futility Pruning (RFP), Forward Futility Pruning (FFP), and Late Move Reduction (LMR)—are absolute structural requirements to prevent the analytical database from drowning in its own tree generation. However, they demonstrate highly position-dependent behavior.

In the Complex Mid-game (Board 2), static pruning (`RFP`) is phenomenally effective, slashing the node count from 1.6M down to just 212K and completing the search in 14 seconds. Yet, when forward pruning (`FFP` and `LMR`) are added on top, the node count unexpectedly spikes back up to 3.8M. 

This behavior illustrates a concept known as "soft" search instability. Because the engine operates on a strict "Zero-Window" search (`[pvScore - 1, pvScore]`) during its batched evaluations, an aggressively reduced move that turns out to be tactically superior will fail high, breaking the narrow Alpha-Beta bounds. This forces the engine to discard the pruned batch and re-verify the branch at full depth. While this re-search mechanism causes localized spikes in node volume, it acts as a critical safety net: despite the aggressive SQL pruning, the engine correctly and consistently identifies powerful tactical sequences like the `c3d5` knight jump across all configurations, ensuring the tactical evaluation remains rock-solid.

## Some Database-Related Questions

If you've spent any time tuning analytical databases, a few critical questions are likely screaming at you by now. *Are you actually using DuckDB at its best? Have you analyzed your query plans? Have you profiled where the time goes? Can the queries be rewritten to trigger more efficient ones?*

Let's address the database experts directly:

**Why DuckDB?**
Why build this in DuckDB and not another SQL engine? The evidence is largely structural. Analytical giants like ClickHouse provide immense power (and native unsigned 64-bit integers), but they typically operate as distinct server instances. Passing millions of chess board states back and forth over a network socket introduces crippling latency. PostgreSQL, while beloved, fundamentally lacks native unsigned 64-bit integers; forcing it to evaluate 128-bit extensions or mask signed `bigint` columns destroys query performance. DuckDB hitting the exact sweet spot: native `UBIGINT` bitwise mathematics executed entirely in-process within the same memory space as the orchestration loop.

**Profiling: Where Does the Time Actually Go?**
When executing an `EXPLAIN ANALYZE` on the massive 1-ply expansion queries (which can exceed 500 lines of dynamically generated SQL), the profiling reveals exactly what you might expect for an engine that bridges scalars and relations: we are overwhelmingly Join-bound.

Here is a summarized, time-annotated snippet from DuckDB's native `query_tree` profiler showing the execution hierarchy of a pseudo-legal move generation query, summing to its total pipeline execution context:

```text
┌────────────────────────────────────────────────┐
│┌──────────────────────────────────────────────┐│
││    Query Profiling Information (Summary)     ││
│└──────────────────────────────────────────────┘│
└────────────────────────────────────────────────┘
...
┌─────────────┴─────────────┐
│         PROJECTION        │  <-- 3. Bitwise evaluations (capture/check flags)
│    ────────────────────   │
│         ~ 2% Time         │
└─────────────┬─────────────┘
┌─────────────┴─────────────┐
│      LEFT_DELIM_JOIN      │  <-- 2. Attack Detection (EXISTS subqueries)
│    ────────────────────   │
│        ~ 40% Time         │
└─────────────┬─────────────┘
┌─────────────┴─────────────┐
│          HASH_JOIN        │  <-- 1. Explodes active turn with mobility
│    ────────────────────   │
│         ~ 20% Time        │
└─────────────┬─────────────┘
┌─────────────┴─────────────┐┌─────────────┴─────────────┐
│         TABLE_SCAN        ││      RIGHT_DELIM_JOIN     │
│    ────────────────────   ││    ────────────────────   │
│    mobility_precomputed   ││     (Lateral Bitboard     │
│        ~ 2% Time          ││     Extraction/Joins)     │
│                           ││        ~ 20% Time         │
└───────────────────────────┘└───────────────────────────┘
```
This data tells a very compelling story. You might assume that computing dozens of chained `CASE WHEN` mathematical masks to figure out captures across thousands of rows (Step 3) would be the bottleneck. In reality, the `PROJECTION` and `FILTER` steps combined consume less than 10% of the total pipeline time. 

The overwhelming majority of the time (~80%) goes into the `DELIM_JOIN` and `HASH_JOIN` operators. 

Crucially, **the real bottleneck is the structural translation between vectors and relations**. To compute legal moves, Quack-Mate uses massive `JOIN LATERAL` calls to extract discrete base positions from the compressed `UBIGINT` bitboard strings (handled via `RIGHT_DELIM_JOIN`). Furthermore, checking if castling squares are under attack requires multiple correlated `EXISTS` subqueries, which DuckDB resolves as `LEFT_DELIM_JOIN`.

Initially, checking castling paths required 12 separate `EXISTS` subqueries per board state, which was a massive drain. To solve this, we moved to **Consolidated Attack Detection**. By grouping square checks into `IN (s1, s2, s3)` filters and using bitwise masks within our `attacks_precomputed` lookups, we reduced the subquery overhead significantly. While these still resolve as `DELIM_JOINs` in our engine today (consuming ~40% of the pipeline as shown in the diagram), they represent a significantly more efficient way to handle DuckDB's relational-to-vector translation compared to independent per-square lookups. This also allows us to correctly populate the `is_check` flag in the search tree (which was previously an expensive runtime check) without significant overhead.

**Indexes and Data Access**
DuckDB's optimizer is designed to convert joins into incredibly fast operators by building transient Hash Tables on the fly. However, because Quack-Mate evaluates millions of variations across discrete JS/SQL batches, we must guarantee immediate lookups where transient hash joins can't save us.

We explicitly instruct DuckDB to index our static piece arrays and cache tables:

```sql
-- 1. Accelerating pseudo-move block generation
CREATE INDEX idx_mobility_target ON mobility_precomputed(target_sq);
CREATE INDEX idx_mobility_from_piece ON mobility_precomputed(piece, from_sq);

-- 2. Accelerating History Heuristic lookups
CREATE INDEX idx_history ON history_moves(piece, to_sq);

-- 3. Accelerating Search Tree relational mapping
CREATE INDEX idx_st_parent ON search_tree(parent_id);
CREATE INDEX idx_st_depth ON search_tree(depth);
CREATE UNIQUE INDEX idx_st_hash ON search_tree(board_hash);
```
Without `idx_mobility_from_piece`, DuckDB would be forced to sequentially scan the entire 36,000-row `mobility_precomputed` table every time it needs to find where a Knight can jump. With the index, the query planner immediately routes the exploded `from_sq` and `piece` IDs into highly selective block lookups, massively cutting down the initial cartesian cross-product.

**Are the Query Plans Optimal? Can they be Rewritten?**
The query plans are as optimal as they can realistically be, but only because we mathematically forced the planner's hand. 
The DuckDB query optimizer is exceptionally smart, but it was designed for standard business intelligence, not for backwards-checking pseudo-legal chess attacks in an adversarial game tree. Early versions of Quack-Mate relied heavily on `OR` clauses during move validation. This completely confused the query planner, causing it to fall back into devastatingly slow Cartesian loops (Nested-Loop Joins). 
To trigger the optimal plan (where DuckDB builds the correct hash tables and streams the board states through them), the queries had to be carefully rewritten to explicitly separate pawn logic from sliding piece logic, utilizing strict `UNION ALL` statements. This mathematically forces the engine to evaluate the bitboards in distinct, parallelized blocks, avoiding the optimizer's fallback behavior.

**Exploiting SQL's Inherent Advantages**
The SQL approach absolutely imposes massive limitations (like the severe overhead of state buffering compared to classical engines). However, it does possess a few unique, native advantages over imperative languages, and Quack-Mate exploits them ruthlessly:
*   **Vectorized Execution without JIT Overhead:** By living entirely inside DuckDB's vectorized query engine, our complex bitwise evaluation pipelines (`XOR` shifts, popcounts, and mask evaluations) are natively executed in tight C++ vectors on the host machine.
*   **Dynamic Pruning Literals (Vs. Prepared Statements):** You might ask why we aren't using Prepared Statements to heavily reduce DuckDB's query planner overhead. The answer is pruning efficiency. Alpha and Beta thresholds update continuously between batches. By continuously injecting these updated thresholds as hardcoded literals straight into the SQL generation string, DuckDB's optimizer treats them as fixed constants rather than opaque parameterized variables. This allows the planner to aggressively push the pruning filters down to the lowest execution nodes, stripping useless variations via table scans before they ever hit the heavy hash-joins.
*   **Zero-Overhead Orchestration:** In the BPVS strategy, all intermediate working tables (`frontier_nodes`, `transposition_table`, `history_moves`) exist purely within the database's memory space. By leveraging `INSERT INTO tbl SELECT ...` operations exclusively, the JavaScript loop acts primarily as a remote control. Not a single byte of chess state crosses the boundary back into standard JS memory until the final scalar minimax bounds are returned at the very end of the batch.

## A Playable Conclusion

The final result speaks for itself. Though admittedly much slower than established engines written in C++ or Rust, the combination of DuckDB and the BPVS strategies makes Quack-Mate genuinely playable up to a depth of 5. For an engine written essentially entirely in SQL, dragging an analytical database kicking and screaming into the world of adversarial game trees, I consider that a tremendous achievement. 

Checkmate. Or rather, *Quack-Mate*.

