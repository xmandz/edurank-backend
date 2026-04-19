import { supabase } from './supabaseClient.js';

export default function setupSocket(io) {
  let waitingPlayers = [];

  // Helper: Fisher-Yates Shuffle
  const shuffleArray = (array) => {
    let arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  const activeMatches = new Map(); // Store room state

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('find_match', async (playerData) => {
      const player = { id: socket.id, ...playerData, status: 'playing', score: 0 };

      if (waitingPlayers.length > 0) {
        const opponentIndex = waitingPlayers.findIndex(p =>
          p.grade === player.grade &&
          p.subject === player.subject &&
          p.book === player.book
        );

        if (opponentIndex > -1) {
          const opponent = waitingPlayers.splice(opponentIndex, 1)[0];
          const roomId = `match_${opponent.id}_${player.id}`;

          // Lắp ghép câu hỏi từ DB 
          let query = supabase.from('questions').select('*').eq('subject', player.subject).eq('grade_level', player.grade);
          const { data, error } = await query;
          
          let filtered = [];
          if (!error && data) {
            filtered = data.filter(q => {
              let series = q.book_series;
              if (typeof series === 'string') {
                try { series = JSON.parse(series); } catch(e) { series = ['ALL']; }
              }
              if (!Array.isArray(series)) series = ['ALL'];
              return series.includes('ALL') || (player.book && series.includes(player.book));
            });
          }
          
          // Fallback if no questions found
          if (filtered.length < 5) {
            socket.emit('match_error', { message: 'Không đủ bộ câu hỏi cho tùy chọn này hoặc CSDL đang trống!' });
            io.sockets.sockets.get(opponent.id)?.emit('match_error', { message: 'Không đủ bộ câu hỏi cho tùy chọn này!' });
            return;
          }

          const shuffled = shuffleArray(filtered).slice(0, 5);

          socket.join(roomId);
          io.sockets.sockets.get(opponent.id)?.join(roomId);

          activeMatches.set(roomId, {
            players: {
              [player.id]: player,
              [opponent.id]: opponent
            },
            questions: shuffled,
            finishedCount: 0
          });

          io.to(roomId).emit('match_found', {
            roomId,
            players: [player, opponent],
            questions: shuffled
          });
        } else {
          waitingPlayers.push(player);
        }
      } else {
        waitingPlayers.push(player);
      }
    });

    socket.on('submit_answer', ({ roomId, currentScore }) => {
      const match = activeMatches.get(roomId);
      if (match && match.players[socket.id]) match.players[socket.id].score = currentScore;
      socket.to(roomId).emit('opponent_progress', { opponentScore: currentScore });
    });

    socket.on('match_end', async ({ roomId }) => {
      const match = activeMatches.get(roomId);
      if (!match) return;

      const player = match.players[socket.id];
      if (player && player.status !== 'finished') {
        player.status = 'finished';
        match.finishedCount += 1;

        if (match.finishedCount === 2) {
          // Calculate winner and rating
          const pIds = Object.keys(match.players);
          const p1 = match.players[pIds[0]];
          const p2 = match.players[pIds[1]];

          let p1Diff = 0; let p2Diff = 0;
          if (p1.score > p2.score) { p1Diff = 10; p2Diff = -5; }
          else if (p2.score > p1.score) { p1Diff = -5; p2Diff = 10; }
          else { p1Diff = 2; p2Diff = 2; } // Draw

          // Update DB for both users
          const updateRating = async (usr, diff) => {
            if (!usr.user_id) return; // in case guest
             const { data: dbUser } = await supabase.from('users').select('rating').eq('id', usr.user_id).single();
             if (dbUser) {
               const newRating = Math.max(0, (dbUser.rating || 0) + diff);
               await supabase.from('users').update({ rating: newRating }).eq('id', usr.user_id);
               usr.newRating = newRating;
             }
          };

          await Promise.all([updateRating(p1, p1Diff), updateRating(p2, p2Diff)]);

          io.to(roomId).emit('match_result', {
            [p1.id]: { score: p1.score, ratingDiff: p1Diff, newRating: p1.newRating },
            [p2.id]: { score: p2.score, ratingDiff: p2Diff, newRating: p2.newRating }
          });

          activeMatches.delete(roomId);
        }
      }
    });

    socket.on('disconnect', async () => {
      waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
      
      // Auto-win logic for active matches when one disconnects
      for (const [roomId, match] of activeMatches.entries()) {
        if (match.players[socket.id]) {
          const opponentId = Object.keys(match.players).find(id => id !== socket.id);
          if (opponentId) {
            const opp = match.players[opponentId];
            const disconnectedPlayer = match.players[socket.id];
            
            // Inform opponent of abandon
            io.to(roomId).emit('opponent_abandoned');
            
            // Update Rating: Opponent wins, disconnected loses
            if (opp.user_id) {
               const { data: dbUser } = await supabase.from('users').select('rating').eq('id', opp.user_id).single();
               if (dbUser) await supabase.from('users').update({ rating: (dbUser.rating || 0) + 10 }).eq('id', opp.user_id);
            }
            if (disconnectedPlayer.user_id) {
               const { data: dbUser } = await supabase.from('users').select('rating').eq('id', disconnectedPlayer.user_id).single();
               if (dbUser) await supabase.from('users').update({ rating: Math.max(0, (dbUser.rating || 0) - 10) }).eq('id', disconnectedPlayer.user_id);
            }
          }
          activeMatches.delete(roomId);
        }
      }

      console.log(`User disconnected: ${socket.id}`);
    });
  });
}
