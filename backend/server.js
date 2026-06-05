require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initPool, getPool, initDB } = require('./db');
const brawlhalla = require('./brawlhalla');
const { generateFixture } = require('./fixture');

const app = express();
app.use(cors());
app.use(express.json());

const path = require('path');
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ─── AUTH ───

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, brawlhalla_id } = req.body;
    if (!username || !password || !brawlhalla_id) return res.status(400).json({ error: 'Username, password and brawlhalla_id required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existingUser = await getPool().query('SELECT id FROM users WHERE username = $1', [username]);
    if (existingUser.rows.length > 0) return res.status(400).json({ error: 'Username already taken' });

    const existingPlayer = await getPool().query('SELECT id FROM players WHERE brawlhalla_id = $1', [brawlhalla_id]);
    if (existingPlayer.rows.length > 0) return res.status(400).json({ error: 'Brawlhalla ID already registered' });

    const verified = await brawlhalla.verifyPlayerExists(brawlhalla_id);
    if (!verified) return res.status(400).json({ error: 'Brawlhalla ID not found in game' });

    const passwordHash = await bcrypt.hash(password, 10);

    const userResult = await getPool().query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [username, passwordHash, 'player']
    );
    const userId = userResult.rows[0].id;

    await getPool().query(
      `INSERT INTO players (user_id, brawlhalla_id, brawlhalla_name, tier, rating, damage_dealt, damage_taken, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [userId, brawlhalla_id, verified.name, verified.tier || 'Unranked', verified.rating || 0,
       verified.total_damage_dealt || 0, verified.total_damage_taken || 0]
    );

    res.json({ message: 'Registration submitted for admin approval' });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const brawlhallaIdNum = parseInt(username, 10);
    let userResult;
    if (!isNaN(brawlhallaIdNum)) {
      userResult = await getPool().query(`
        SELECT u.id, u.username, u.password_hash, u.role, p.brawlhalla_id
        FROM users u JOIN players p ON p.user_id = u.id
        WHERE p.brawlhalla_id = $1
      `, [brawlhallaIdNum]);
    } else {
      userResult = await getPool().query(`
        SELECT u.id, u.username, u.password_hash, u.role, p.brawlhalla_id
        FROM users u LEFT JOIN players p ON p.user_id = u.id
        WHERE u.username = $1
      `, [username]);
    }
    if (userResult.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = userResult.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, role: user.role, brawlhalla_id: user.brawlhalla_id });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const userResult = await getPool().query('SELECT id, username, role, created_at FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const playerResult = await getPool().query('SELECT id, brawlhalla_id, brawlhalla_name, tier, rating, status FROM players WHERE user_id = $1', [req.user.id]);
    const user = userResult.rows[0];
    const player = playerResult.rows[0] || null;

    res.json({ ...user, player });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── BRAWLHALLA PROXY ───

app.get('/api/brawlhalla/search/:name', async (req, res) => {
  try {
    const results = await brawlhalla.searchPlayer(req.params.name);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: 'Error searching Brawlhalla' });
  }
});

app.get('/api/brawlhalla/player/:id', async (req, res) => {
  try {
    const stats = await brawlhalla.getPlayerStats(req.params.id);
    if (!stats) return res.status(404).json({ error: 'Player not found' });
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: 'Error fetching player stats' });
  }
});

// ─── PLAYERS ───

app.get('/api/players', async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT p.id, p.brawlhalla_id, p.brawlhalla_name, p.tier, p.rating, p.status, p.created_at, u.username
      FROM players p JOIN users u ON u.id = p.user_id
      WHERE p.status = 'approved' AND p.brawlhalla_id IS NOT NULL
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/players/pending', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT p.id, p.brawlhalla_id, p.brawlhalla_name, p.tier, p.rating, p.status, p.created_at, u.username
      FROM players p JOIN users u ON u.id = p.user_id
      WHERE p.status = 'pending'
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/players/:id', async (req, res) => {
  try {
    const playerResult = await getPool().query(`
      SELECT p.id, p.brawlhalla_id, p.brawlhalla_name, p.tier, p.rating, p.damage_dealt, p.damage_taken, p.status, u.username
      FROM players p JOIN users u ON u.id = p.user_id
      WHERE p.id = $1
    `, [req.params.id]);

    if (playerResult.rows.length === 0) return res.status(404).json({ error: 'Player not found' });

    const player = playerResult.rows[0];

    const matchStats = await getPool().query(`
      SELECT
        COUNT(*) FILTER (WHERE m.status = 'completed' AND (m.player1_id = $1 OR m.player2_id = $1)) AS total_matches,
        COUNT(*) FILTER (WHERE m.status = 'completed' AND m.winner_id = $1) AS wins,
        COUNT(*) FILTER (WHERE m.status = 'completed' AND m.winner_id IS NOT NULL AND m.winner_id != $1 AND (m.player1_id = $1 OR m.player2_id = $1)) AS losses
      FROM matches m
      JOIN rounds r ON r.id = m.round_id
      WHERE r.status = 'active' OR m.status = 'completed'
    `, [req.params.id]);

    const standings = await getPool().query(`
      SELECT COALESCE(SUM(CASE WHEN m.winner_id = $1 THEN 3 ELSE 0 END), 0) AS points
      FROM matches m
      JOIN rounds r ON r.id = m.round_id
      WHERE m.status = 'completed' AND (m.player1_id = $1 OR m.player2_id = $1)
    `, [req.params.id]);

    res.json({
      ...player,
      stats: matchStats.rows[0],
      points: parseInt(standings.rows[0].points) || 0
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/players/:id/matches', async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT m.id, m.round_id, r.round_number, m.player1_id, m.player2_id, m.winner_id,
             m.legend1, m.legend2, m.score, m.status, m.played_date, m.scheduled_date, m.rescheduled,
             p1.brawlhalla_name AS player1_name, p2.brawlhalla_name AS player2_name,
             u1.username AS player1_username, u2.username AS player2_username
      FROM matches m
      JOIN rounds r ON r.id = m.round_id
      JOIN players p1 ON p1.id = m.player1_id
      JOIN players p2 ON p2.id = m.player2_id
      JOIN users u1 ON u1.id = p1.user_id
      JOIN users u2 ON u2.id = p2.user_id
      WHERE (m.player1_id = $1 OR m.player2_id = $1)
      ORDER BY m.played_date DESC, m.id DESC
      LIMIT 20
    `, [req.params.id]);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/players/h2h/:player1Id/:player2Id', async (req, res) => {
  try {
    const { player1Id, player2Id } = req.params;
    const p1 = parseInt(player1Id);
    const p2 = parseInt(player2Id);
    const matches = await getPool().query(`
      SELECT m.id, m.round_id, r.round_number, m.player1_id, m.player2_id, m.winner_id,
             m.legend1, m.legend2, m.score, m.status, m.played_date, m.scheduled_date, m.rescheduled,
             p1.brawlhalla_name AS player1_name, p2.brawlhalla_name AS player2_name,
             u1.username AS player1_username, u2.username AS player2_username
      FROM matches m
      JOIN rounds r ON r.id = m.round_id
      JOIN players p1 ON p1.id = m.player1_id
      JOIN players p2 ON p2.id = m.player2_id
      JOIN users u1 ON u1.id = p1.user_id
      JOIN users u2 ON u2.id = p2.user_id
      WHERE (m.player1_id = $1 AND m.player2_id = $2) OR (m.player1_id = $3 AND m.player2_id = $4)
      ORDER BY m.played_date ASC
    `, [p1, p2, p2, p1]);

    const completed = matches.rows.filter(m => m.status === 'completed');
    const p1Wins = completed.filter(m => m.winner_id === parseInt(player1Id)).length;
    const p2Wins = completed.filter(m => m.winner_id === parseInt(player2Id)).length;

    res.json({
      player1_id: parseInt(player1Id),
      player2_id: parseInt(player2Id),
      player1_wins: p1Wins,
      player2_wins: p2Wins,
      total_matches: completed.length,
      matches: matches.rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN ───

app.patch('/api/admin/players/:id/verify', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { action } = req.body; // 'approved' or 'rejected'
    if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    await getPool().query('UPDATE players SET status = $1 WHERE id = $2', [action, req.params.id]);
    res.json({ message: `Player ${action}` });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/players/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const playerResult = await getPool().query('SELECT user_id FROM players WHERE id = $1', [req.params.id]);
    if (playerResult.rows.length === 0) return res.status(404).json({ error: 'Player not found' });

    const userId = playerResult.rows[0].user_id;
    await getPool().query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ message: 'Player removed' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/players/:id/expel', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const playerResult = await getPool().query('SELECT id FROM players WHERE id = $1', [req.params.id]);
    if (playerResult.rows.length === 0) return res.status(404).json({ error: 'Player not found' });

    const activeSeason = await getPool().query("SELECT id FROM seasons WHERE status = 'active' LIMIT 1");
    if (activeSeason.rows.length > 0) {
      await getPool().query(
        'DELETE FROM season_players WHERE season_id = $1 AND player_id = $2',
        [activeSeason.rows[0].id, req.params.id]
      );
    }

    await getPool().query("UPDATE players SET status = 'rejected' WHERE id = $1", [req.params.id]);
    res.json({ message: 'Player expelled from league' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/players/approved', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT p.id, p.brawlhalla_id, p.brawlhalla_name, p.tier, p.rating, p.damage_dealt, p.damage_taken, p.created_at, u.username
      FROM players p JOIN users u ON u.id = p.user_id
      WHERE p.status = 'approved' AND p.brawlhalla_id IS NOT NULL
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/matches/pending', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT m.id, m.round_id, r.round_number, m.scheduled_date, m.rescheduled,
             p1.brawlhalla_name AS player1_name, p2.brawlhalla_name AS player2_name,
             u1.username AS player1_username, u2.username AS player2_username,
             p1.id AS player1_id, p2.id AS player2_id
      FROM matches m
      JOIN rounds r ON r.id = m.round_id
      JOIN players p1 ON p1.id = m.player1_id
      JOIN players p2 ON p2.id = m.player2_id
      JOIN users u1 ON u1.id = p1.user_id
      JOIN users u2 ON u2.id = p2.user_id
      WHERE m.status = 'pending'
      ORDER BY r.round_number ASC, m.id ASC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const existing = await getPool().query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);
    const userResult = await getPool().query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [username, hash, role || 'admin']);
    const userId = userResult.rows[0].id;

    await getPool().query(
      `INSERT INTO players (user_id, brawlhalla_id, brawlhalla_name, status)
       VALUES ($1, NULL, $2, 'approved')`,
      [userId, username]
    );

    res.json({ message: 'Admin user created' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/profile', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT p.id, p.brawlhalla_id, p.brawlhalla_name, p.tier, p.rating, p.damage_dealt, p.damage_taken, p.status
      FROM players p WHERE p.user_id = $1
    `, [req.user.id]);
    if (result.rows.length === 0) return res.json(null);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/admin/profile', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { brawlhalla_id } = req.body;
    if (!brawlhalla_id) return res.status(400).json({ error: 'brawlhalla_id required' });

    const verified = await brawlhalla.verifyPlayerExists(brawlhalla_id);
    if (!verified) return res.status(400).json({ error: 'Brawlhalla ID not found in game' });

    await getPool().query(`
      UPDATE players
      SET brawlhalla_id = $1, brawlhalla_name = $2, tier = $3, rating = $4, damage_dealt = $5, damage_taken = $6
      WHERE user_id = $7
    `, [brawlhalla_id, verified.name, verified.tier || 'Unranked', verified.rating || 0,
        verified.total_damage_dealt || 0, verified.total_damage_taken || 0, req.user.id]);

    res.json({ message: 'Profile updated' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── SEASONS ───

app.post('/api/seasons', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Season name required' });

    const activeSeason = await getPool().query("SELECT id FROM seasons WHERE status = 'active'");
    if (activeSeason.rows.length > 0) return res.status(400).json({ error: 'An active season already exists' });

    const approvedPlayers = await getPool().query("SELECT id FROM players WHERE status = 'approved' AND brawlhalla_id IS NOT NULL");
    if (approvedPlayers.rows.length < 2) return res.status(400).json({ error: 'Need at least 2 approved players' });

    const seasonResult = await getPool().query('INSERT INTO seasons (name) VALUES ($1) RETURNING id', [name]);
    const seasonId = seasonResult.rows[0].id;

    const playerIds = approvedPlayers.rows.map(r => r.id);
    const shuffled = [...playerIds].sort(() => Math.random() - 0.5);

    for (let i = 0; i < shuffled.length; i++) {
      await getPool().query(
        'INSERT INTO season_players (season_id, player_id, initial_position) VALUES ($1, $2, $3)',
        [seasonId, shuffled[i], i + 1]
      );
    }

    const fixture = generateFixture(playerIds);

    const pad = n => n.toString().padStart(2, '0');
    const toLocalStr = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysToSat = (6 - dayOfWeek + 7) % 7 || 7;
    const firstSat = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToSat, 16, 0, 0, 0);

    for (const round of fixture) {
      const isEven = round.round_number % 2 === 0;
      const ri = round.round_number - 1;
      const weeks = Math.floor(ri / 2);
      const extra = isEven ? 1 : 0;

      const roundDate = new Date(firstSat);
      roundDate.setDate(firstSat.getDate() + weeks * 7 + extra);

      const roundResult = await getPool().query(
        'INSERT INTO rounds (season_id, round_number, status) VALUES ($1, $2, $3) RETURNING id',
        [seasonId, round.round_number, round.round_number === 1 ? 'active' : 'pending']
      );
      const roundId = roundResult.rows[0].id;

      let hour = 16;
      for (const pair of round.pairs) {
        const matchDate = new Date(roundDate);
        matchDate.setHours(hour, 0, 0, 0);
        const dateStr = toLocalStr(matchDate);
        await getPool().query(
          'INSERT INTO matches (round_id, player1_id, player2_id, status, scheduled_date) VALUES ($1, $2, $3, $4, $5)',
          [roundId, pair[0], pair[1], 'pending', dateStr]
        );
        hour += 1;
      }
    }

    res.json({ message: 'Season started', season_id: seasonId, total_rounds: fixture.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/seasons/active', async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM season_players sp WHERE sp.season_id = s.id) AS player_count,
        (SELECT COUNT(*) FROM rounds r WHERE r.season_id = s.id) AS total_rounds,
        (SELECT COUNT(*) FROM rounds r WHERE r.season_id = s.id AND r.status = 'completed') AS completed_rounds
      FROM seasons s WHERE s.status = 'active' ORDER BY s.id DESC LIMIT 1
    `);
    if (result.rows.length === 0) return res.json(null);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/seasons/:id/end', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const now = new Date().toISOString();
    await getPool().query("UPDATE seasons SET status = 'completed', ended_at = $1 WHERE id = $2", [now, req.params.id]);
    res.json({ message: 'Season ended' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── MATCHES ───

app.get('/api/matches', async (req, res) => {
  try {
    const statusFilter = req.query.status;
    const validStatuses = ['pending', 'completed', 'cancelled'];
    let query = `
      SELECT m.id, m.player1_id, m.player2_id, m.winner_id, m.legend1, m.legend2, m.score, m.status, m.scheduled_date, m.played_date, m.rescheduled,
             r.round_number, r.id AS round_id,
             p1.brawlhalla_name AS player1_name, p1.tier AS player1_tier,
             p2.brawlhalla_name AS player2_name, p2.tier AS player2_tier,
             u1.username AS player1_username, u2.username AS player2_username
      FROM matches m
      JOIN rounds r ON r.id = m.round_id
      JOIN players p1 ON p1.id = m.player1_id
      JOIN players p2 ON p2.id = m.player2_id
      JOIN users u1 ON u1.id = p1.user_id
      JOIN users u2 ON u2.id = p2.user_id
    `;

    if (statusFilter && validStatuses.includes(statusFilter)) {
      query += ` WHERE m.status = '${statusFilter}'`;
    }

    query += ' ORDER BY r.round_number ASC, m.id ASC';
    const result = await getPool().query(query);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/matches/round/:roundId', async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT m.id, m.round_id, m.player1_id, m.player2_id, m.winner_id, m.legend1, m.legend2, m.score, m.status, m.scheduled_date, m.rescheduled, m.played_date, p1.brawlhalla_name AS player1_name, p2.brawlhalla_name AS player2_name,
             u1.username AS player1_username, u2.username AS player2_username
      FROM matches m
      JOIN players p1 ON p1.id = m.player1_id
      JOIN players p2 ON p2.id = m.player2_id
      JOIN users u1 ON u1.id = p1.user_id
      JOIN users u2 ON u2.id = p2.user_id
      WHERE m.round_id = $1
    `, [req.params.roundId]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/rounds', async (req, res) => {
  try {
    const seasonResult = await getPool().query("SELECT id FROM seasons WHERE status = 'active' LIMIT 1");
    if (seasonResult.rows.length === 0) return res.json([]);

    const result = await getPool().query(`
      SELECT r.*,
        (SELECT COUNT(*) FROM matches m WHERE m.round_id = r.id) AS match_count,
        (SELECT COUNT(*) FROM matches m WHERE m.round_id = r.id AND m.status = 'completed') AS completed_count
      FROM rounds r WHERE r.season_id = $1 ORDER BY r.round_number ASC
    `, [seasonResult.rows[0].id]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/matches/:id/result', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { winner_id, legend1, legend2, score, format } = req.body;
    if (!winner_id) return res.status(400).json({ error: 'winner_id required' });

    const matchResult = await getPool().query('SELECT round_id, player1_id, player2_id FROM matches WHERE id = $1', [req.params.id]);
    if (matchResult.rows.length === 0) return res.status(404).json({ error: 'Match not found' });

    const match = matchResult.rows[0];
    if (winner_id !== match.player1_id && winner_id !== match.player2_id) {
      return res.status(400).json({ error: 'Winner must be one of the players' });
    }

    const isBo5 = format === 'bo5';
    const validScores = isBo5
      ? ['3-0', '3-1', '3-2', '0-3', '1-3', '2-3']
      : ['2-0', '2-1', '0-2', '1-2'];
    if (score && !validScores.includes(score)) {
      return res.status(400).json({
        error: isBo5
          ? 'Invalid Bo5 score. Valid: 3-0, 3-1, 3-2, 0-3, 1-3, 2-3'
          : 'Invalid Bo3 score. Valid: 2-0, 2-1, 0-2, 1-2'
      });
    }

    const pad = n => n.toString().padStart(2, '0');
    const nd = new Date();
    const playedDateStr = `${nd.getFullYear()}-${pad(nd.getMonth()+1)}-${pad(nd.getDate())} ${pad(nd.getHours())}:${pad(nd.getMinutes())}`;

    await getPool().query(
      `UPDATE matches SET winner_id = $1, legend1 = $2, legend2 = $3, score = $4, status = 'completed', played_date = $5
       WHERE id = $6`,
      [winner_id, legend1 || null, legend2 || null, score || null, playedDateStr, req.params.id]
    );

    const roundResult = await getPool().query(
      `UPDATE rounds SET status = 'completed'
       WHERE id = $1 AND (
         SELECT COUNT(*) FROM matches WHERE round_id = $1 AND status = 'pending'
       ) = 0`, [match.round_id]
    );

    const hasMoreRounds = await getPool().query(`
      SELECT COUNT(*) AS pending FROM rounds WHERE season_id = (
        SELECT season_id FROM rounds WHERE id = $1
      ) AND status = 'pending'
    `, [match.round_id]);

    if (parseInt(hasMoreRounds.rows[0].pending) > 0) {
      await getPool().query(`
        UPDATE rounds SET status = 'active'
        WHERE id = (
          SELECT id FROM rounds WHERE season_id = (
            SELECT season_id FROM rounds WHERE id = $1
          ) AND status = 'pending' ORDER BY round_number ASC LIMIT 1
        )
      `, [match.round_id]);
    } else {
      const now2 = new Date().toISOString();
      await getPool().query(`
        UPDATE seasons SET status = 'completed', ended_at = $1
        WHERE id = (SELECT season_id FROM rounds WHERE id = $2)
      `, [now2, match.round_id]);
    }

    res.json({ message: 'Match result recorded' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: PARTIDAS COMPLETADAS ───

app.get('/api/admin/matches/completed', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT m.id, m.round_id, r.round_number, m.player1_id, m.player2_id, m.winner_id,
             m.legend1, m.legend2, m.score, m.status, m.played_date, m.scheduled_date, m.rescheduled,
             p1.brawlhalla_name AS player1_name, p2.brawlhalla_name AS player2_name,
             u1.username AS player1_username, u2.username AS player2_username
      FROM matches m
      JOIN rounds r ON r.id = m.round_id
      JOIN players p1 ON p1.id = m.player1_id
      JOIN players p2 ON p2.id = m.player2_id
      JOIN users u1 ON u1.id = p1.user_id
      JOIN users u2 ON u2.id = p2.user_id
      WHERE m.status = 'completed'
      ORDER BY m.played_date DESC, m.id DESC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: EDITAR RESULTADO ───

app.put('/api/admin/matches/:id/result', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { winner_id, legend1, legend2, score, format } = req.body;
    if (!winner_id) return res.status(400).json({ error: 'winner_id required' });

    const matchResult = await getPool().query('SELECT round_id, player1_id, player2_id, status FROM matches WHERE id = $1', [req.params.id]);
    if (matchResult.rows.length === 0) return res.status(404).json({ error: 'Match not found' });

    const match = matchResult.rows[0];
    if (winner_id !== match.player1_id && winner_id !== match.player2_id) {
      return res.status(400).json({ error: 'Winner must be one of the players' });
    }

    const isBo5 = format === 'bo5';
    const validScores = isBo5
      ? ['3-0', '3-1', '3-2', '0-3', '1-3', '2-3']
      : ['2-0', '2-1', '0-2', '1-2'];
    if (score && !validScores.includes(score)) {
      return res.status(400).json({
        error: isBo5
          ? 'Invalid Bo5 score. Valid: 3-0, 3-1, 3-2, 0-3, 1-3, 2-3'
          : 'Invalid Bo3 score. Valid: 2-0, 2-1, 0-2, 1-2'
      });
    }

    await getPool().query(
      `UPDATE matches SET winner_id = $1, legend1 = $2, legend2 = $3, score = $4, status = 'completed'
       WHERE id = $5`,
      [winner_id, legend1 || null, legend2 || null, score || null, req.params.id]
    );

    res.json({ message: 'Match result updated' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: REVERTIR A PENDIENTE ───

app.post('/api/admin/matches/:id/revert', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const matchResult = await getPool().query('SELECT round_id, status FROM matches WHERE id = $1', [req.params.id]);
    if (matchResult.rows.length === 0) return res.status(404).json({ error: 'Match not found' });
    if (matchResult.rows[0].status !== 'completed') return res.status(400).json({ error: 'Match is not completed' });

    const roundId = matchResult.rows[0].round_id;

    await getPool().query(
      `UPDATE matches SET winner_id = NULL, score = NULL, legend1 = NULL, legend2 = NULL,
       status = 'pending', played_date = NULL
       WHERE id = $1`,
      [req.params.id]
    );

    await getPool().query(
      "UPDATE rounds SET status = 'active' WHERE id = $1",
      [roundId]
    );

    res.json({ message: 'Match reverted to pending' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/matches/:id/reschedule', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { scheduled_date } = req.body;
    if (!scheduled_date) return res.status(400).json({ error: 'scheduled_date required' });

    const matchResult = await getPool().query('SELECT id FROM matches WHERE id = $1', [req.params.id]);
    if (matchResult.rows.length === 0) return res.status(404).json({ error: 'Match not found' });

    await getPool().query(
      'UPDATE matches SET scheduled_date = $1, rescheduled = 1 WHERE id = $2',
      [scheduled_date, req.params.id]
    );
    res.json({ message: 'Match rescheduled' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── SEASONS HISTORY ───

app.get('/api/seasons/all', async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT s.*,
        (SELECT p.brawlhalla_name FROM season_players sp
         JOIN players p ON p.id = sp.player_id
         JOIN matches m ON (m.player1_id = p.id OR m.player2_id = p.id)
         WHERE sp.season_id = s.id
         GROUP BY p.id, p.brawlhalla_name
         ORDER BY COUNT(*) FILTER (WHERE m.winner_id = p.id) DESC
         LIMIT 1
        ) AS champion_name
      FROM seasons s
      ORDER BY s.started_at DESC
    `);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── STANDINGS ───

async function computeStandings(seasonId, res) {
  try {
    const result = await getPool().query(`
      SELECT p.id, p.brawlhalla_name, p.tier, u.username,
        COALESCE(SUM(CASE WHEN m.winner_id = p.id THEN 3 ELSE 0 END), 0) AS points,
        COUNT(*) FILTER (WHERE m.status = 'completed' AND m.winner_id = p.id) AS wins,
        COUNT(*) FILTER (WHERE m.status = 'completed' AND m.winner_id IS NOT NULL AND m.winner_id != p.id AND (m.player1_id = p.id OR m.player2_id = p.id)) AS losses,
        COUNT(*) FILTER (WHERE m.status = 'completed' AND m.winner_id = p.id) - COUNT(*) FILTER (WHERE m.status = 'completed' AND m.winner_id IS NOT NULL AND m.winner_id != p.id AND (m.player1_id = p.id OR m.player2_id = p.id)) AS difference,
        COUNT(*) FILTER (WHERE m.status = 'completed' AND (m.player1_id = p.id OR m.player2_id = p.id)) AS matches_played,
        CASE
          WHEN COUNT(*) FILTER (WHERE m.status = 'completed' AND (m.player1_id = p.id OR m.player2_id = p.id)) > 0
          THEN ROUND(
            CAST(COUNT(*) FILTER (WHERE m.status = 'completed' AND m.winner_id = p.id) AS REAL) /
            CAST(COUNT(*) FILTER (WHERE m.status = 'completed' AND (m.player1_id = p.id OR m.player2_id = p.id)) AS REAL) * 100, 2
          )
          ELSE 0
        END AS winrate,
        sp.initial_position
      FROM season_players sp
      JOIN players p ON p.id = sp.player_id
      JOIN users u ON u.id = p.user_id
      LEFT JOIN matches m ON (m.player1_id = p.id OR m.player2_id = p.id)
        AND m.round_id IN (SELECT id FROM rounds WHERE season_id = $1)
      WHERE sp.season_id = $1
      GROUP BY p.id, p.brawlhalla_name, p.tier, u.username, sp.initial_position
      ORDER BY points DESC, difference DESC, wins DESC, sp.initial_position ASC
    `, [seasonId]);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
}

app.get('/api/standings', async (req, res) => {
  try {
    const requestedSeasonId = req.query.season_id ? parseInt(req.query.season_id) : null;

    if (requestedSeasonId) {
      const seasonCheck = await getPool().query('SELECT id, status FROM seasons WHERE id = $1', [requestedSeasonId]);
      if (seasonCheck.rows.length === 0) return res.status(404).json({ error: 'Season not found' });
      await computeStandings(requestedSeasonId, res);
      return;
    }

    const seasonResult = await getPool().query("SELECT id FROM seasons WHERE status = 'active' LIMIT 1");
    if (seasonResult.rows.length === 0) {
      const allPlayers = await getPool().query(`
        SELECT p.id, p.brawlhalla_name, p.tier, u.username, 0 AS points, 0 AS wins, 0 AS losses, 0 AS matches_played, 0 AS difference, 0.00 AS winrate
        FROM players p JOIN users u ON u.id = p.user_id WHERE p.status = 'approved' AND p.brawlhalla_id IS NOT NULL ORDER BY p.created_at ASC
      `);
      return res.json(allPlayers.rows);
    }

    await computeStandings(seasonResult.rows[0].id, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── SEED ADMIN ───

async function seedAdmin() {
  const { rows } = await getPool().query('SELECT id FROM users WHERE role = $1 LIMIT 1', ['admin']);
  if (rows.length === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
    const userResult = await getPool().query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [process.env.ADMIN_USERNAME || 'admin', hash, 'admin']);
    const userId = userResult.rows[0].id;
    await getPool().query(
      `INSERT INTO players (user_id, brawlhalla_id, brawlhalla_name, status)
       VALUES ($1, NULL, $2, 'approved')`,
      [userId, process.env.ADMIN_USERNAME || 'admin']
    );
    console.log('Admin user created');
  }
}

// ─── START ───

async function start() {
  await initPool();
  await initDB();
  await seedAdmin();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();
