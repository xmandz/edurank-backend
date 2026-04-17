export default function setupSocket(io) {
  let waitingPlayers = [];

  io.on('connection', (socket) => {
    console.log(`Người dùng kết nối: ${socket.id}`);

    // Sự kiện 1: Học sinh bấm "Thách đấu"
    socket.on('find_match', (playerData) => {
      console.log(`Đang tìm trận cho:`, playerData.name);
      
      const player = { id: socket.id, ...playerData };
      
      // Thuật toán: Tìm người đang chờ có cùng môn, lớp và bộ sách (hoặc bỏ qua bộ sách nếu không cần)
      if (waitingPlayers.length > 0) {
        const opponentIndex = waitingPlayers.findIndex(p => 
          p.grade === player.grade && 
          p.subject === player.subject && 
          p.book === player.book
        );
        
        if (opponentIndex > -1) {
          const opponent = waitingPlayers.splice(opponentIndex, 1)[0];
          const roomId = `match_${opponent.id}_${player.id}`;
        
        // Cho cả 2 vào chung 1 phòng (Room)
        socket.join(roomId);
        io.sockets.sockets.get(opponent.id)?.join(roomId);

        // Phát tín hiệu "Tìm thấy trận" cho cả 2 người
        io.to(roomId).emit('match_found', {
          roomId,
          players: [player, opponent],
          questions: [] // Ở bản thật, bạn gọi Supabase để random 10 câu hỏi nhét vào đây
        });
        
        console.log(`Đã ghép trận: ${player.name} VS ${opponent.name}`);
        } else {
           waitingPlayers.push(player);
        }
      } else {
        // Chưa có ai -> Đưa vào danh sách chờ
        waitingPlayers.push(player);
      }
    });

    // Sự kiện 2: Cập nhật tiến độ trong lúc thi
    socket.on('submit_answer', ({ roomId, currentScore }) => {
      // Bắn tiến độ của mình cho đối thủ trong cùng phòng (dùng broadcast)
      socket.to(roomId).emit('opponent_progress', { opponentScore: currentScore });
    });

    // Sự kiện 3: Ngắt kết nối
    socket.on('disconnect', () => {
      waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
      console.log(`Người dùng ngắt kết nối: ${socket.id}`);
    });
  });
}
