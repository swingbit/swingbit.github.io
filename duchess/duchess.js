import { make_move, best_move } from './pkg/duchesslib.js';

var board = null
var $last_human = $('#last_human')
var $last_duchess = $('#last_duchess')

var last_human_fen = null
var last_duchess_fen = null

$('#new_game_as_white').on('click', function () {
  board.orientation('white')
  board.position('start')
  $last_duchess.html(null)
  $last_human.html(null)
  last_human_fen = board.fen() + ' w KQkq - 0 1'
  last_duchess_fen = board.fen() + ' w KQkq - 0 1'
})

$('#new_game_as_black').on('click', function () {
  board.orientation('black')
  board.position('start')
  $last_duchess.html(null)
  $last_human.html(null)
  last_human_fen = board.fen() + ' w KQkq - 0 1'
  last_duchess_fen = board.fen() + ' w KQkq - 0 1'

  window.setTimeout(duchessMove, 1000, last_human_fen)
})

function duchessMove(fromFEN) {
  last_duchess_fen = best_move(fromFEN)
  board.position(last_duchess_fen)
  $last_duchess.html(last_duchess_fen)
}

function onDrop (source, target, piece, newPos, oldPos, orientation) {
  // make  move returns a new FEN, or 'illegal'
  var fen = make_move(last_duchess_fen, source, target)
  if(fen == 'illegal') {
    return 'snapback'
  }
  last_human_fen = fen
  // Re-draw the board according to the received FEN
  // because there might have been a promotion or a castling
  // Do it with a delay, so that the standard redraw after the drop is overwritten
  window.setTimeout(board.position, 100, last_human_fen)
  $last_human.html(last_human_fen)
  window.setTimeout(duchessMove, 100, last_human_fen)
}


export function duchess () {
  var config = {
    draggable: true,
    position: 'start',
    orientation: 'white',
    onDrop: onDrop,
  }
  board = Chessboard('board1', config)
  last_human_fen = board.fen() + ' w KQkq - 0 1'
  last_duchess_fen = board.fen() + ' w KQkq - 0 1'
}
