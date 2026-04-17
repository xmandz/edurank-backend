import express from 'express';
import { supabase } from '../supabaseClient.js';
const router = express.Router();

// ==========================================
// CÂU HỎI - Lấy theo môn, lớp, sách
// ==========================================
router.get('/questions', async (req, res) => {
  const { subject, grade, book, limit = 10 } = req.query;
  if (!subject || !grade) return res.status(400).json({ error: 'Missing subject or grade' });

  let { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('subject', subject)
    .eq('grade_level', parseInt(grade));

  if (error) return res.status(500).json({ error: error.message });

  const filtered = (data || []).filter(q => {
    let series = q.book_series;
    if (typeof series === 'string') {
      try { series = JSON.parse(series); } catch(e) { series = ['ALL']; }
    }
    if (!Array.isArray(series)) series = ['ALL'];
    return series.includes('ALL') || (book && series.includes(book));
  });

  const shuffled = filtered.sort(() => 0.5 - Math.random());
  res.json(shuffled.slice(0, parseInt(limit)));
});

// ==========================================
// KẾT QUẢ PvE + Cập nhật streak
// ==========================================
router.post('/results/pve', async (req, res) => {
  const { user_id, correct_count } = req.body;
  if (!user_id || correct_count === undefined) return res.status(400).json({ error: 'Missing data' });

  const { data: user, error: fetchError } = await supabase
    .from('users')
    .select('coins, streak_days, last_active_date')
    .eq('id', user_id)
    .single();

  if (fetchError) return res.status(500).json({ error: fetchError.message });

  // Tính streak
  const today = new Date().toISOString().split('T')[0];
  const lastDate = user.last_active_date;
  let newStreak = user.streak_days || 0;

  if (lastDate !== today) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (lastDate === yesterdayStr) {
      newStreak += 1; // Tiếp tục chuỗi
    } else {
      newStreak = 1; // Bắt đầu lại
    }
  }

  // Tính xu
  const earnedCoins = correct_count * 10;
  const streakBonus = newStreak >= 7 ? 20 : newStreak >= 3 ? 10 : 0;
  const totalEarned = earnedCoins + streakBonus;
  const newCoins = (user.coins || 0) + totalEarned;

  const { error: updateError } = await supabase
    .from('users')
    .update({
      coins: newCoins,
      streak_days: newStreak,
      last_active_date: today
    })
    .eq('id', user_id);

  if (updateError) return res.status(500).json({ error: updateError.message });

  res.json({ message: 'Success', earnedCoins: totalEarned, streakBonus, newCoins, newStreak });
});

// ==========================================
// STREAK - Cập nhật khi đăng nhập
// ==========================================
router.post('/streak/checkin', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

  const { data: user, error } = await supabase
    .from('users')
    .select('streak_days, last_active_date')
    .eq('id', user_id)
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const today = new Date().toISOString().split('T')[0];
  if (user.last_active_date === today) {
    return res.json({ streak: user.streak_days, message: 'Already checked in today' });
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  let newStreak = 1;
  if (user.last_active_date === yesterdayStr) {
    newStreak = (user.streak_days || 0) + 1;
  }

  await supabase.from('users').update({
    streak_days: newStreak,
    last_active_date: today
  }).eq('id', user_id);

  res.json({ streak: newStreak, message: newStreak > 1 ? `Chuỗi ${newStreak} ngày! 🔥` : 'Bắt đầu chuỗi mới!' });
});

// ==========================================
// ADMIN - Thêm câu hỏi
// ==========================================
router.post('/admin/questions', async (req, res) => {
  const { user_id, questions } = req.body;
  if (!user_id || !questions) return res.status(400).json({ error: 'Missing data' });

  // Kiểm tra quyền admin
  const { data: userData } = await supabase.from('users').select('is_admin').eq('id', user_id).single();
  if (!userData?.is_admin) return res.status(403).json({ error: 'Không có quyền Admin!' });

  // questions là mảng hoặc object đơn
  const toInsert = Array.isArray(questions) ? questions : [questions];

  const { data, error } = await supabase.from('questions').insert(toInsert).select();
  if (error) return res.status(500).json({ error: error.message });

  res.json({ message: `Đã thêm ${data.length} câu hỏi!`, count: data.length, data });
});

// ADMIN - Lấy tất cả câu hỏi (để quản lý)
router.get('/admin/questions', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

  const { data: userData } = await supabase.from('users').select('is_admin').eq('id', user_id).single();
  if (!userData?.is_admin) return res.status(403).json({ error: 'Không có quyền Admin!' });

  const { data, error } = await supabase.from('questions').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

// ADMIN - Xóa câu hỏi
router.delete('/admin/questions/:id', async (req, res) => {
  const { user_id } = req.query;
  const { id } = req.params;

  const { data: userData } = await supabase.from('users').select('is_admin').eq('id', user_id).single();
  if (!userData?.is_admin) return res.status(403).json({ error: 'Không có quyền Admin!' });

  const { error } = await supabase.from('questions').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ message: 'Đã xóa câu hỏi' });
});

export default router;
