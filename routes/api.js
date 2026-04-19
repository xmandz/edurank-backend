import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../supabaseClient.js';
const router = express.Router();

const requireAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.userId = user.id;
  next();
};

const requireAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  
  // Create a scoped client with the user's JWT to bypass RLS
  const scopedClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  
  const { data: userData } = await scopedClient.from('users').select('is_admin').eq('id', user.id).single();
  if (!userData?.is_admin) return res.status(403).json({ error: 'Lỗi: Không có quyền Admin trên cơ sở dữ liệu!' });
  
  req.adminId = user.id;
  req.supabase = scopedClient;
  next();
};

const shuffleArray = (array) => {
  let arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

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

  const shuffled = shuffleArray(filtered);
  res.json(shuffled.slice(0, parseInt(limit)));
});

router.post('/results/pve', requireAuth, async (req, res) => {
  const { correct_count } = req.body;
  const user_id = req.userId;
  if (correct_count === undefined) return res.status(400).json({ error: 'Missing data' });

  const { data: user, error: fetchError } = await supabase
    .from('users')
    .select('coins, streak_days, last_active_date')
    .eq('id', user_id)
    .single();

  if (fetchError) return res.status(500).json({ error: fetchError.message });

  const today = new Date().toISOString().split('T')[0];
  const lastDate = user.last_active_date;
  let newStreak = user.streak_days || 0;

  if (lastDate !== today) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (lastDate === yesterdayStr) {
      newStreak += 1;
    } else {
      newStreak = 1;
    }
  }

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

router.post('/streak/checkin', requireAuth, async (req, res) => {
  const user_id = req.userId;

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

  // Update but only if last_active_date is not today (prevent race conditions)
  const { error: updateErr } = await supabase.from('users').update({
    streak_days: newStreak,
    last_active_date: today
  }).eq('id', user_id).neq('last_active_date', today);

  if (updateErr) return res.status(500).json({ error: 'Check-in failed due to concurrency' });

  res.json({ streak: newStreak, message: newStreak > 1 ? `Chuỗi ${newStreak} ngày! 🔥` : 'Bắt đầu chuỗi mới!' });
});

router.post('/admin/questions', requireAdmin, async (req, res) => {
  const { questions } = req.body;
  if (!questions) return res.status(400).json({ error: 'Missing data' });

  const toInsert = Array.isArray(questions) ? questions : [questions];
  
  // Validate JSON format for book_series
  for (let q of toInsert) {
    if (typeof q.book_series === 'string') {
      try {
        const parsed = JSON.parse(q.book_series);
        if (!Array.isArray(parsed)) throw new Error('Not an array');
        q.book_series = parsed; // Convert string to proper JSONB array before inserting
      } catch (e) {
        return res.status(400).json({ error: `Invalid JSON for book_series in question: ${q.content}` });
      }
    }
  }

  const { data, error } = await req.supabase.from('questions').insert(toInsert).select();
  if (error) return res.status(500).json({ error: error.message });

  res.json({ message: `Đã thêm ${data.length} câu hỏi!`, count: data.length, data });
});

router.get('/admin/questions', requireAdmin, async (req, res) => {
  const { data, error } = await req.supabase.from('questions').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/admin/questions/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { error } = await req.supabase.from('questions').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đã xóa câu hỏi' });
});

// --- NEW FEATURES ---

// 1. Leaderboard
router.get('/leaderboard', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, avatar_url, avatar_frame, rating, streak_days')
    .order('rating', { ascending: false })
    .limit(10);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 2. Mistake Review
router.get('/mistakes', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });

  // Fetch mistakes with question details
  const { data, error } = await supabase
    .from('user_mistakes')
    .select(`
      question_id,
      failed_count,
      questions (
        id, grade_level, subject, content, options, correct_answer, explanation
      )
    `)
    .eq('user_id', user_id)
    .order('last_failed_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/mistakes', async (req, res) => {
  const { user_id, question_id } = req.body;
  if (!user_id || !question_id) return res.status(400).json({ error: 'Missing data' });

  // Upsert mistake: if exists, increment failed_count, else insert
  // We'll use a transaction logic or simple check since it's small
  const { data: existing } = await supabase
    .from('user_mistakes')
    .select('failed_count')
    .eq('user_id', user_id)
    .eq('question_id', question_id)
    .single();

  if (existing) {
    await supabase
      .from('user_mistakes')
      .update({ failed_count: existing.failed_count + 1, last_failed_at: new Date().toISOString() })
      .eq('user_id', user_id)
      .eq('question_id', question_id);
  } else {
    await supabase
      .from('user_mistakes')
      .insert({ user_id, question_id, failed_count: 1 });
  }

  res.json({ message: 'Recorded mistake' });
});

router.delete('/mistakes', async (req, res) => {
  const { user_id, question_id } = req.body;
  const { error } = await supabase
    .from('user_mistakes')
    .delete()
    .eq('user_id', user_id)
    .eq('question_id', question_id);
    
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Mistake cleared' });
});

// 3. Shop / Cosmetics
router.post('/user/equip-frame', async (req, res) => {
  const { user_id, frame_id } = req.body;
  if (!user_id || !frame_id) return res.status(400).json({ error: 'Missing data' });

  const { error } = await supabase
    .from('users')
    .update({ avatar_frame: frame_id })
    .eq('id', user_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Frame equipped', frame_id });
});

export default router;
