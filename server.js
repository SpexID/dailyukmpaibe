const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ✅ CORS — izinkan frontend lokal + production kamu
// Ganti array `origin` sesuai domain frontend production nanti
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
];

app.use(cors({
  origin: (origin, callback) => {
    // allow request tanpa Origin (misal curl, Postman, mobile app)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(bodyParser.json());

// ✅ Pool dengan timeout — hindari hang kalau pool penuh
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ═════════════════════════════════════════════════════════════
// ✅ ROUTE SPESIFIK (HARUS DI ATAS)
// ═════════════════════════════════════════════════════════════

// ── GET /dailyquiz/result?name=gh ──
app.get('/dailyquiz/result', async (req, res) => {
  const { name: nameParam } = req.query;

  if (!nameParam || typeof nameParam !== 'string' || nameParam.trim() === '') {
    return res.status(400).json({ error: 'Parameter "name" wajib diisi' });
  }
  const cleanName = nameParam.trim();

  try {
    const dateResult = await pool.query(
      `SELECT MAX(quiz_date)::text AS active_date FROM daily_answers`
    );
    const quizDate = dateResult.rows[0]?.active_date;
    if (!quizDate) {
      return res.status(404).json({ error: 'Belum ada data quiz' });
    }

    const totalRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM dailyquiz WHERE quiz_date = $1`,
      [quizDate]
    );
    const totalQuestions = totalRes.rows[0]?.total ?? 0;
    if (totalQuestions === 0) {
      return res.status(404).json({ error: 'Quiz tidak ditemukan' });
    }

    const playerExistsRes = await pool.query(
      `SELECT 1 FROM daily_answers
       WHERE LOWER(user_id) = LOWER($1) AND quiz_date = $2
       LIMIT 1`,
      [cleanName, quizDate]
    );
    const playerExists = playerExistsRes.rows.length > 0;

    const lbRes = await pool.query(
      `WITH ordered AS (
         SELECT
           user_id,
           is_correct,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY question_order) AS rn
         FROM daily_answers
         WHERE quiz_date = $1
       ),
       grouped AS (
         SELECT
           user_id,
           rn - ROW_NUMBER() OVER (PARTITION BY user_id, is_correct ORDER BY rn) AS grp,
           is_correct
         FROM ordered
       ),
       streak_calc AS (
         SELECT user_id, grp, COUNT(*) AS streak_len
         FROM grouped
         WHERE is_correct = true
         GROUP BY user_id, grp
       ),
       max_streak AS (
         SELECT user_id, MAX(streak_len)::int AS best_streak
         FROM streak_calc
         GROUP BY user_id
       )
       SELECT
         da.user_id AS name,
         SUM(CASE WHEN da.is_correct THEN 1 ELSE 0 END)::int AS score,
         COALESCE(ms.best_streak, 0) AS streak,
         MAX(da.answered_at) AS last_answered
       FROM daily_answers da
       LEFT JOIN max_streak ms ON ms.user_id = da.user_id
       WHERE da.quiz_date = $1
       GROUP BY da.user_id, ms.best_streak
       ORDER BY score DESC, streak DESC, last_answered ASC`,
      [quizDate]
    );

    const leaderboard = lbRes.rows.map((row, idx) => ({
      id: `p${idx + 1}`,
      name: row.name,
      score: row.score,
      streak: row.streak,
      isPlayer: row.name.toLowerCase() === cleanName.toLowerCase(),
    }));

    const playerIdx = leaderboard.findIndex(
      (e) => e.name.toLowerCase() === cleanName.toLowerCase()
    );
    const playerRow =
      playerIdx >= 0
        ? {
            name: leaderboard[playerIdx].name,
            score: leaderboard[playerIdx].score,
            streak: leaderboard[playerIdx].streak,
            rank: playerIdx + 1,
            in_top_10: playerIdx < 10,
          }
        : null;

    res.json({
      quiz_date: quizDate,
      total_questions: totalQuestions,
      player_exists: playerExists,
      leaderboard,
      player: playerRow,
    });
  } catch (error) {
    console.error('Error fetching result data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dailyquiz/leaderboard-today ──
// Leaderboard HARI INI (WIB). Kalau belum ada attempt hari ini → kosong.
app.get('/dailyquiz/leaderboard-today', async (req, res) => {
  try {
    // 1) Hari ini WIB
    const todayResult = await pool.query(
      `SELECT (NOW() AT TIME ZONE 'Asia/Jakarta')::date::text AS today`
    );
    const today = todayResult.rows[0]?.today;
    if (!today) {
      return res.json({ quiz_date: null, total_questions: 0, leaderboard: [] });
    }

    // 2) Apakah ada attempt hari ini?
    const todayAttemptsRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM daily_answers WHERE quiz_date = $1`,
      [today]
    );
    const todayAttempts = todayAttemptsRes.rows[0]?.cnt ?? 0;

    if (todayAttempts === 0) {
      return res.json({
        quiz_date: today,
        total_questions: 0,
        leaderboard: [],
      });
    }

    // 3) Total soal hari ini
    const totalRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM dailyquiz WHERE quiz_date = $1`,
      [today]
    );
    const totalQuestions = totalRes.rows[0]?.total ?? 0;

    // 4) Leaderboard hari ini
    const lbRes = await pool.query(
      `WITH ordered AS (
         SELECT
           user_id,
           is_correct,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY question_order) AS rn
         FROM daily_answers
         WHERE quiz_date = $1
       ),
       grouped AS (
         SELECT
           user_id,
           rn - ROW_NUMBER() OVER (PARTITION BY user_id, is_correct ORDER BY rn) AS grp,
           is_correct
         FROM ordered
       ),
       streak_calc AS (
         SELECT user_id, grp, COUNT(*) AS streak_len
         FROM grouped
         WHERE is_correct = true
         GROUP BY user_id, grp
       ),
       max_streak AS (
         SELECT user_id, MAX(streak_len)::int AS best_streak
         FROM streak_calc
         GROUP BY user_id
       )
       SELECT
         da.user_id AS name,
         SUM(CASE WHEN da.is_correct THEN 1 ELSE 0 END)::int AS score,
         COALESCE(ms.best_streak, 0) AS streak,
         MAX(da.answered_at) AS last_answered
       FROM daily_answers da
       LEFT JOIN max_streak ms ON ms.user_id = da.user_id
       WHERE da.quiz_date = $1
       GROUP BY da.user_id, ms.best_streak
       ORDER BY score DESC, streak DESC, last_answered ASC`,
      [today]
    );

    const leaderboard = lbRes.rows.map((row, idx) => ({
      id: `p${idx + 1}`,
      name: row.name,
      score: row.score,
      streak: row.streak,
    }));

    res.json({
      quiz_date: today,
      total_questions: totalQuestions,
      leaderboard,
    });
  } catch (error) {
    console.error('Error fetching leaderboard-today:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dailyquiz/active ──
app.get('/dailyquiz/active', async (req, res) => {
  try {
    const dateResult = await pool.query(
      `SELECT MAX(quiz_date)::text AS active_date
       FROM dailyquiz
       WHERE quiz_date <= (NOW() AT TIME ZONE 'Asia/Jakarta')::date`
    );

    const activeDate = dateResult.rows[0]?.active_date;
    if (!activeDate) {
      return res.status(404).json({ error: 'No quiz available yet' });
    }

    const result = await pool.query(
      `SELECT id, quiz_date::text AS quiz_date, question_order, question_text,
              option_a, option_b, option_c, option_d,
              answer_key, explanation, quiz_batch_id
       FROM dailyquiz
       WHERE quiz_date = $1
       ORDER BY question_order ASC`,
      [activeDate]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No quiz available yet' });
    }

    const questions = result.rows.map((row) => ({
      id: row.question_order,
      text: row.question_text,
      options: [
        { id: 1, label: 'a', text: row.option_a },
        { id: 2, label: 'b', text: row.option_b },
        { id: 3, label: 'c', text: row.option_c },
        { id: 4, label: 'd', text: row.option_d },
      ],
    }));

    const answers = {};
    result.rows.forEach((row) => {
      answers[row.question_order] = {
        answer_key: row.answer_key,
        explanation: row.explanation,
      };
    });

    res.json({
      quiz_date: result.rows[0].quiz_date,
      quiz_batch_id: result.rows[0].quiz_batch_id,
      total_questions: questions.length,
      questions,
      answers,
    });
  } catch (error) {
    console.error('Error fetching active quiz:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dailyquiz/today (LEGACY) ──
app.get('/dailyquiz/today', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, quiz_date::text AS quiz_date, question_order, question_text,
              option_a, option_b, option_c, option_d
       FROM dailyquiz
       WHERE quiz_date = (SELECT MAX(quiz_date) FROM dailyquiz
                          WHERE quiz_date <= (NOW() AT TIME ZONE 'Asia/Jakarta')::date)
       ORDER BY question_order ASC`
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No quiz available for today yet' });
    }

    const questions = result.rows.map((row) => ({
      id: row.question_order,
      text: row.question_text,
      options: [
        { id: 1, label: 'a', text: row.option_a },
        { id: 2, label: 'b', text: row.option_b },
        { id: 3, label: 'c', text: row.option_c },
        { id: 4, label: 'd', text: row.option_d },
      ],
    }));

    res.json({
      quiz_date: result.rows[0].quiz_date,
      total_questions: result.rows.length,
      questions,
    });
  } catch (error) {
    console.error("Error fetching today's quiz:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═════════════════════════════════════════════════════════════
// ❌ ROUTE DENGAN PARAMETER (HARUS DI BAWAH)
// ═════════════════════════════════════════════════════════════

// ── GET /dailyquiz/:date/answers (LEGACY) ──
app.get('/dailyquiz/:date/answers', async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(
      `SELECT question_order, answer_key, explanation
       FROM dailyquiz
       WHERE quiz_date = $1
       ORDER BY question_order ASC`,
      [date]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No quiz found for this date' });
    }

    const answers = {};
    result.rows.forEach((r) => {
      answers[r.question_order] = {
        answer_key: r.answer_key,
        explanation: r.explanation,
      };
    });

    res.json({ quiz_date: date, answers });
  } catch (error) {
    console.error('Error fetching answers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dailyquiz/:date/:order/answer (LEGACY) ──
app.get('/dailyquiz/:date/:order/answer', async (req, res) => {
  const { date, order } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }
  const orderNum = parseInt(order, 10);
  if (Number.isNaN(orderNum)) {
    return res.status(400).json({ error: 'Invalid question order' });
  }

  try {
    const result = await pool.query(
      `SELECT answer_key, explanation
       FROM dailyquiz
       WHERE quiz_date = $1 AND question_order = $2`,
      [date, orderNum]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching answer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dailyquiz/leaderboard/:date (LEGACY) ──
app.get('/dailyquiz/leaderboard/:date', async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(
      `SELECT user_id AS name,
              SUM(CASE WHEN is_correct THEN 1 ELSE 0 END)::int AS total_correct,
              COUNT(*)::int AS total_answered,
              MAX(answered_at) AS last_answered
       FROM daily_answers
       WHERE quiz_date = $1
       GROUP BY user_id
       ORDER BY total_correct DESC, last_answered ASC`,
      [date]
    );
    res.json({ quiz_date: date, leaderboard: result.rows });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dailyquiz/:date (LEGACY) ──
app.get('/dailyquiz/:date', async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  try {
    const result = await pool.query(
      `SELECT id, quiz_date::text AS quiz_date, question_order, question_text,
              option_a, option_b, option_c, option_d
       FROM dailyquiz
       WHERE quiz_date = $1
       ORDER BY question_order ASC`,
      [date]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No quiz found for this date' });
    }

    const questions = result.rows.map((row) => ({
      id: row.question_order,
      text: row.question_text,
      options: [
        { id: 1, label: 'a', text: row.option_a },
        { id: 2, label: 'b', text: row.option_b },
        { id: 3, label: 'c', text: row.option_c },
        { id: 4, label: 'd', text: row.option_d },
      ],
    }));

    res.json({
      quiz_date: result.rows[0].quiz_date,
      total_questions: result.rows.length,
      questions,
    });
  } catch (error) {
    console.error('Error fetching quiz by date:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═════════════════════════════════════════════════════════════
// 📥 POST ROUTES
// ═════════════════════════════════════════════════════════════

// ── POST /dailyquiz/submit (LEGACY) ──
app.post('/dailyquiz/submit', async (req, res) => {
  const { quiz_date, answers } = req.body;
  if (!quiz_date || !answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'quiz_date and answers are required' });
  }

  try {
    const result = await pool.query(
      `SELECT question_order, answer_key, explanation
       FROM dailyquiz
       WHERE quiz_date = $1
       ORDER BY question_order ASC`,
      [quiz_date]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Quiz not found for this date' });
    }

    let score = 0;
    const review = result.rows.map((q) => {
      const yourAnswer = (answers[q.question_order] || '').toLowerCase();
      const isCorrect = yourAnswer === q.answer_key;
      if (isCorrect) score++;
      return {
        question_order: q.question_order,
        your_answer: yourAnswer || null,
        correct_answer: q.answer_key,
        is_correct: isCorrect,
        explanation: q.explanation,
      };
    });

    res.json({
      quiz_date,
      score,
      total: result.rows.length,
      percentage: Math.round((score / result.rows.length) * 100),
      review,
    });
  } catch (error) {
    console.error('Error submitting quiz:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dailyquiz/complete ──
app.post('/dailyquiz/complete', async (req, res) => {
  const { name, quiz_date, answers } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Nama wajib diisi' });
  }
  if (!quiz_date || !/^\d{4}-\d{2}-\d{2}$/.test(quiz_date)) {
    return res.status(400).json({ error: 'quiz_date tidak valid (YYYY-MM-DD)' });
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ error: 'answers tidak boleh kosong' });
  }

  const cleanName = name.trim();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1) Cek nama sudah dipakai untuk tanggal ini atau belum
    const existing = await client.query(
      `SELECT 1 FROM daily_answers
       WHERE LOWER(user_id) = LOWER($1) AND quiz_date = $2
       LIMIT 1`,
      [cleanName, quiz_date]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res
        .status(409)
        .json({ error: 'Nama sudah digunakan hari ini, silakan pilih nama lain.' });
    }

    // 2) Ambil kunci jawaban + batch id
    const quizResult = await client.query(
      `SELECT question_order, answer_key, quiz_batch_id
       FROM dailyquiz
       WHERE quiz_date = $1`,
      [quiz_date]
    );
    if (quizResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ error: 'Quiz tidak ditemukan untuk tanggal tersebut' });
    }

    const quizMap = {};
    quizResult.rows.forEach((row) => {
      quizMap[row.question_order] = row;
    });

    // 3) Simpan jawaban + hitung streak
    const sortedAnswers = [...answers].sort(
      (a, b) => a.question_order - b.question_order
    );

    const inserted = [];
    let totalCorrect = 0;
    let currentStreak = 0;
    let trailingStreak = 0;

    for (const ans of sortedAnswers) {
      const q = quizMap[ans.question_order];
      if (!q) continue;

      const userAnswer = String(ans.user_answer || '').toLowerCase();
      if (!['a', 'b', 'c', 'd'].includes(userAnswer)) continue;

      const isCorrect = userAnswer === q.answer_key;

      if (isCorrect) {
        totalCorrect++;
        currentStreak++;
        trailingStreak = currentStreak;
      } else {
        currentStreak = 0;
        trailingStreak = 0;
      }

      const insertResult = await client.query(
        `INSERT INTO daily_answers
           (user_id, quiz_date, question_order, quiz_batch_id,
            user_answer, is_correct)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, question_order, user_answer, is_correct, answered_at`,
        [cleanName, quiz_date, ans.question_order, q.quiz_batch_id, userAnswer, isCorrect]
      );
      inserted.push(insertResult.rows[0]);
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Skor berhasil disimpan',
      user: { name: cleanName },
      quiz_date,
      score: trailingStreak,
      total_correct: totalCorrect,
      total_questions: quizResult.rows.length,
      answers: inserted,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving score:', error);
    if (error.code === '23505') {
      return res
        .status(409)
        .json({ error: 'Nama sudah digunakan hari ini, silakan pilih nama lain.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ═════════════════════════════════════════════════════════════
// 🚀 START SERVER — WAJIB 0.0.0.0:8080 untuk Fly.io
// ═════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});