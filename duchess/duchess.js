import { make_move, find_best_move, check_end_game } from './pkg/duchesslib.js';

var board = null
var $last_human = $('#last_human')
var $last_duchess = $('#last_duchess')

var last_fen = null
var last_human_fen = null
var last_duchess_fen = null

$('#new_game_as_white').on('click', function () {
  board.orientation('white')
  board.position('start')
  $last_duchess.html(null)
  $last_human.html(null)
  last_fen = board.fen() + ' w KQkq - 0 1'
  last_human_fen = last_fen
  last_duchess_fen = last_fen
})

$('#new_game_as_black').on('click', function () {
  board.orientation('black')
  board.position('start')
  $last_duchess.html(null)
  $last_human.html(null)
  last_fen = board.fen() + ' w KQkq - 0 1'
  last_human_fen = last_fen
  last_duchess_fen = last_fen

  window.setTimeout(duchessMove, 1000, last_human_fen)
})

function panic() {
  alert("Unexpected failure. Click OK to reload the page.")
  location.reload()
}

function check_panic_reply(reply) {
  if(reply == 'illegal_input') {
    panic()
  }
}

function handle_end_game(fen) {
  var reply = check_end_game(fen)
  check_panic_reply(reply)
  if (reply == "none") {
    return
  }
  if (reply == "draw") {
    alert("The game has ended with a draw. Please start a new game.")
  } else {
    var res = reply.match(/^checkmate (white|black)$/)
    if (res) {
      alert("The game has ended with " + res[1] + " in checkmate. Please start a new game.")
    } else {
      panic()
    }
  }
}

function duchessMove(fromFEN) {
  var reply = find_best_move(fromFEN)
  check_panic_reply(reply)
  last_fen = last_duchess_fen = reply
  board.position(last_duchess_fen)
  $last_duchess.html(last_duchess_fen)
}

function onDrop (source, target, piece, newPos, oldPos, orientation) {
  // make  move returns a new FEN, or 'illegal'
  var reply = make_move(last_duchess_fen, source, target)
  check_panic_reply(reply)
  if(reply == 'illegal') {
    return 'snapback'
  }
  last_fen = last_human_fen = reply
  // Re-draw the board according to the received FEN
  // because there might have been a promotion or a castling
  // Do it with a delay, so that the standard redraw after the drop is overwritten
  window.setTimeout(board.position, 100, last_human_fen)
  $last_human.html(last_human_fen)
  window.setTimeout(duchessMove, 100, last_human_fen)
}

function onMoveEnd(oldPos, newPos) {
  handle_end_game(last_fen)
}

export function duchess () {
  var config = {
    draggable: true,
    position: 'start',
    orientation: 'white',
    onDrop: onDrop,
    onMoveEnd: onMoveEnd,
  }
  board = Chessboard('board1', config)
  last_fen = board.fen() + ' w KQkq - 0 1'
  last_human_fen = last_fen
  last_duchess_fen = last_fen
}
