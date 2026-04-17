import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

// Load biến môi trường
dotenv.config();

// Khởi tạo Express & Socket.io
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// API Routes
import apiRoutes from './routes/api.js';
app.use('/api', apiRoutes);

// Khởi tạo Socket Matchmaking
import setupSocket from './socket.js';
setupSocket(io);

// API Test
app.get('/', (req, res) => {
  res.send('EduRank Backend & Socket.io is running!');
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
