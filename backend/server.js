require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, initDB } = require('./db');
const brawlhalla = require('./brawlhalla');
const { generateFixture } = require('./fixture');
const { parseReplay, extractMatchData } = require('./replay_parser');

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

    const existingUser = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existingUser.rows.length > 0) return res.status(400).json({ error: 'Username already taken' });

    const existingPlayer = await pool.query('SELECT id FROM players WHERE brawlhalla_id = $1', [brawlhalla_id]);
    if (existingPlayer.rows.length > 0) return res.status(400).json({ error: 'Brawlhalla ID already registered' });

    const verified = await brawlhalla.verifyPlayerExists(brawlhalla_id);
    if (!verified) return res.status(400).json({ error: 'Brawlhalla ID not found in game' });

    const passwordHash = await bcrypt.hash(password, 10);

    const userResult = await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [username, passwordHash, 'player']
    );
    const userId = userResult.rows[0].id;

    await pool.query(
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
      userResult = await pool.query(`
        SELECT u.id, u.username, u.password_hash, u.role, p.id AS player_id, p.brawlhalla_id
        FROM users u JOIN players p ON p.user_id = u.id
        WHERE p.brawlhalla_id = $1
      `, [brawlhallaIdNum]);
    } else {
      userResult = await pool.query(`
        SELECT u.id, u.username, u.password_hash, u.role, p.id AS player_id, p.brawlhalla_id
        FROM users u LEFT JOIN players p ON p.user_id = u.id
        WHERE u.username = $1
      `, [username]);
    }
    if (userResult.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = userResult.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.role !== 'admin') {
      const playerCheck = await pool.query('SELECT status FROM players WHERE user_id = $1', [user.id]);
      if (playerCheck.rows.length > 0 && playerCheck.rows[0].status !== 'approved') {
        return res.status(403).json({ error: 'Tu cuenta aún no ha sido aprobada por un administrador' });
      }
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, role: user.role, player_id: user.player_id, brawlhalla_id: user.brawlhalla_id });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT id, username, role, created_at FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const playerResult = await pool.query('SELECT id, brawlhalla_id, brawlhalla_name, tier, rating, status FROM players WHERE user_id = $1', [req.user.id]);
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
    const result = await pool.query(`
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
    const result = await pool.query(`
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
    const playerResult = await pool.query(`
      SELECT p.id, p.brawlhalla_id, p.brawlhalla_name, p.tier, p.rating, p.damage_dealt, p.damage_taken, p.status, u.username
      FROM players p JOIN users u ON u.id = p.user_id
      WHERE p.id = $1
    `, [req.params.id]);

    if (playerResult.rows.length === 0) return res.status(404).json({ error: 'Player not found' });

    const player = playerResult.rows[0];

    const matchStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE m.status = 'completed' AND (m.player1_id = $1 OR m.player2_id = $1)) AS total_matches,
        COUNT(*) FILTER (WHERE m.status = 'completed' AND m.winner_id = $1) AS wins,
        COUNT(*) FILTER (WHERE m.status = 'completed' AND m.winner_id IS NOT NULL AND m.winner_id != $1 AND (m.player1_id = $1 OR m.player2_id = $1)) AS losses
      FROM matches m
      JOIN rounds r ON r.id = m.round_id
      WHERE r.status = 'active' OR m.status = 'completed'
    `, [req.params.id]);

    const standings = await pool.query(`
      SELECT COALESCE(SUM(CASE WHEN m.winner_id = $1 THEN 1 ELSE 0 END), 0) AS points
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
    const result = await pool.query(`
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
    const matches = await pool.query(`
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

    await pool.query('UPDATE players SET status = $1 WHERE id = $2', [action, req.params.id]);
    res.json({ message: `Player ${action}` });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/players/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const playerResult = await pool.query('SELECT user_id FROM players WHERE id = $1', [req.params.id]);
    if (playerResult.rows.length === 0) return res.status(404).json({ error: 'Player not found' });

    const userId = playerResult.rows[0].user_id;
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ message: 'Player removed' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/players/:id/expel', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const playerResult = await pool.query('SELECT id FROM players WHERE id = $1', [req.params.id]);
    if (playerResult.rows.length === 0) return res.status(404).json({ error: 'Player not found' });

    const activeSeason = await pool.query("SELECT id FROM seasons WHERE status = 'active' LIMIT 1");
    if (activeSeason.rows.length > 0) {
      await pool.query(
        'DELETE FROM season_players WHERE season_id = $1 AND player_id = $2',
        [activeSeason.rows[0].id, req.params.id]
      );
    }

    await pool.query("UPDATE players SET status = 'rejected' WHERE id = $1", [req.params.id]);
    res.json({ message: 'Player expelled from league' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/players/approved', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
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

app.post('/api/admin/players/reverify-tiers', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const players = await pool.query(
      "SELECT id, brawlhalla_id FROM players WHERE status = 'approved' AND brawlhalla_id IS NOT NULL"
    );
    let updated = 0;
    let failed = 0;
    for (const p of players.rows) {
      try {
        const verified = await brawlhalla.verifyPlayerExists(p.brawlhalla_id);
        if (verified) {
          await pool.query(
            'UPDATE players SET brawlhalla_name = $1, tier = $2, rating = $3 WHERE id = $4',
            [verified.name, verified.tier || 'Unranked', verified.rating || 0, p.id]
          );
          updated++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
    res.json({ message: `Re-verificación completada: ${updated} actualizados, ${failed} fallaron` });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.get('/api/admin/matches/pending', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    let seasonId = null;
    const activeSeason = await pool.query("SELECT id FROM seasons WHERE status = 'active' LIMIT 1");
    if (activeSeason.rows.length > 0) {
      seasonId = activeSeason.rows[0].id;
    } else {
      const lastSeason = await pool.query("SELECT id FROM seasons ORDER BY id DESC LIMIT 1");
      if (lastSeason.rows.length > 0) {
        seasonId = lastSeason.rows[0].id;
      }
    }

    if (!seasonId) return res.json([]);

    const result = await pool.query(`
      SELECT m.id, m.round_id, r.round_number, m.scheduled_date, m.rescheduled, m.match_code,
             p1.brawlhalla_name AS player1_name, p2.brawlhalla_name AS player2_name,
             u1.username AS player1_username, u2.username AS player2_username,
             p1.id AS player1_id, p2.id AS player2_id
      FROM matches m
      JOIN rounds r ON r.id = m.round_id
      JOIN players p1 ON p1.id = m.player1_id
      JOIN players p2 ON p2.id = m.player2_id
      JOIN users u1 ON u1.id = p1.user_id
      JOIN users u2 ON u2.id = p2.user_id
      WHERE m.status = 'pending' AND r.season_id = $1
      ORDER BY r.round_number ASC, m.id ASC
    `, [seasonId]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);
    const userResult = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [username, hash, role || 'admin']);
    const userId = userResult.rows[0].id;

    await pool.query(
      `INSERT INTO players (user_id, brawlhalla_id, brawlhalla_name, status)
       VALUES ($1, NULL, $2, 'approved')`,
      [userId, username]
    );

    res.json({ message: 'Admin user created' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: LIST USERS ───

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.role, u.created_at,
        p.brawlhalla_name, p.brawlhalla_id
      FROM users u
      LEFT JOIN players p ON p.user_id = u.id
      ORDER BY u.role ASC, u.username ASC
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: RESET USER PASSWORD ───

app.patch('/api/admin/users/:id/password', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const userResult = await pool.query('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    res.json({ message: 'Password updated' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/profile', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
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

    await pool.query(`
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

    const activeSeason = await pool.query("SELECT id FROM seasons WHERE status = 'active'");
    if (activeSeason.rows.length > 0) return res.status(400).json({ error: 'An active season already exists' });

    // Check for tournament qualifiers first
    const qualifiers = await pool.query(
      'SELECT DISTINCT player_id, position FROM tournament_qualifiers ORDER BY position ASC'
    );

    let playerIds;
    if (qualifiers.rows.length >= 2) {
      // Use qualified tournament players
      playerIds = qualifiers.rows.map(r => r.player_id);
      // Clear qualifiers after use
      await pool.query('DELETE FROM tournament_qualifiers');
    } else {
      return res.status(400).json({ error: 'No hay suficientes clasificados en el ranking para crear la liga (Mínimo 2). Debes traspasar ganadores de un torneo primero.' });
    }

    const seasonResult = await pool.query('INSERT INTO seasons (name) VALUES ($1) RETURNING id', [name]);
    const seasonId = seasonResult.rows[0].id;

    const shuffled = [...playerIds].sort(() => Math.random() - 0.5);

    for (let i = 0; i < shuffled.length; i++) {
      await pool.query(
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

      const roundResult = await pool.query(
        'INSERT INTO rounds (season_id, round_number, status) VALUES ($1, $2, $3) RETURNING id',
        [seasonId, round.round_number, round.round_number === 1 ? 'active' : 'pending']
      );
      const roundId = roundResult.rows[0].id;

      let hour = 16;
      for (const pair of round.pairs) {
        const matchDate = new Date(roundDate);
        matchDate.setHours(hour, 0, 0, 0);
        const dateStr = toLocalStr(matchDate);
        await pool.query(
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
    const result = await pool.query(`
      SELECT s.*,
        s.status = 'active' AS is_active,
        (SELECT COUNT(*) FROM season_players sp WHERE sp.season_id = s.id) AS player_count,
        (SELECT COUNT(*) FROM rounds r WHERE r.season_id = s.id) AS total_rounds,
        (SELECT COUNT(*) FROM rounds r WHERE r.season_id = s.id AND r.status = 'completed') AS completed_rounds,
        (SELECT COUNT(*) FROM matches m
         JOIN rounds r2 ON r2.id = m.round_id
         WHERE r2.season_id = s.id AND r2.status = 'active'
         AND m.status = 'completed') AS current_round_completed_matches,
        (SELECT COUNT(*) FROM matches m
         JOIN rounds r3 ON r3.id = m.round_id
         WHERE r3.season_id = s.id AND r3.status = 'active') AS current_round_total_matches
      FROM seasons s
      WHERE s.status = 'active'
      ORDER BY s.id DESC LIMIT 1
    `);
    if (result.rows.length > 0) return res.json(result.rows[0]);

    const lastResult = await pool.query(`
      SELECT s.*, false AS is_active,
        (SELECT COUNT(*) FROM season_players sp WHERE sp.season_id = s.id) AS player_count,
        (SELECT COUNT(*) FROM rounds r WHERE r.season_id = s.id) AS total_rounds,
        (SELECT COUNT(*) FROM rounds r WHERE r.season_id = s.id AND r.status = 'completed') AS completed_rounds,
        0 AS current_round_completed_matches,
        0 AS current_round_total_matches
      FROM seasons s
      ORDER BY s.id DESC LIMIT 1
    `);
    if (lastResult.rows.length === 0) return res.json(null);
    res.json(lastResult.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/seasons/:id/end', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const now = new Date().toISOString();
    await pool.query(`
      DELETE FROM matches
      WHERE status = 'pending' AND round_id IN (SELECT id FROM rounds WHERE season_id = $1)
    `, [req.params.id]);
    await pool.query(`
      UPDATE rounds SET status = 'completed'
      WHERE season_id = $1 AND status != 'completed'
    `, [req.params.id]);
    await pool.query("UPDATE seasons SET status = 'completed', ended_at = $1 WHERE id = $2", [now, req.params.id]);
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

    let seasonId = req.query.season_id ? parseInt(req.query.season_id) : null;
    if (!seasonId) {
      const activeSeason = await pool.query("SELECT id FROM seasons WHERE status = 'active' LIMIT 1");
      if (activeSeason.rows.length > 0) {
        seasonId = activeSeason.rows[0].id;
      } else {
        const lastSeason = await pool.query("SELECT id FROM seasons ORDER BY id DESC LIMIT 1");
        if (lastSeason.rows.length > 0) {
          seasonId = lastSeason.rows[0].id;
        }
      }
    }

    if (!seasonId) return res.json([]);

    let query = `
      SELECT m.id, m.player1_id, m.player2_id, m.winner_id, m.legend1, m.legend2, m.score, m.status, m.scheduled_date, m.played_date, m.rescheduled, m.match_code,
             m.p1_damage, m.p2_damage, m.p1_kos, m.p2_kos,
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
      WHERE r.season_id = $1
    `;

    const queryParams = [seasonId];
    if (statusFilter && validStatuses.includes(statusFilter)) {
      query += ` AND m.status = $2`;
      queryParams.push(statusFilter);
    } else {
      query += ` AND m.status != 'cancelled'`;
    }

    query += ' ORDER BY r.round_number ASC, m.id ASC';
    const result = await pool.query(query, queryParams);

    // Determine requesting user
    let reqPlayerId = null;
    let reqIsAdmin = false;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const user = jwt.verify(token, JWT_SECRET);
        reqIsAdmin = user.role === 'admin';
        if (!reqIsAdmin) {
          const playerRow = await pool.query('SELECT id FROM players WHERE user_id = $1', [user.id]);
          if (playerRow.rows.length > 0) reqPlayerId = playerRow.rows[0].id;
        }
      } catch {}
    }

    // Filter match_code: only admin or match participants can see it
    const rows = result.rows.map(m => {
      if (!reqIsAdmin && reqPlayerId !== m.player1_id && reqPlayerId !== m.player2_id) {
        return { ...m, match_code: null };
      }
      return m;
    });

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/matches/round/:roundId', async (req, res) => {
  try {
    const result = await pool.query(`
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
    const seasonResult = await pool.query("SELECT id FROM seasons WHERE status = 'active' LIMIT 1");
    if (seasonResult.rows.length === 0) return res.json([]);

    const result = await pool.query(`
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
    const { winner_id, legend1, legend2, score, format, p1_damage, p2_damage, p1_kos, p2_kos } = req.body;
    if (!winner_id) return res.status(400).json({ error: 'winner_id required' });

    const matchResult = await pool.query('SELECT round_id, player1_id, player2_id FROM matches WHERE id = $1', [req.params.id]);
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

    await pool.query(
      `UPDATE matches SET winner_id = $1, legend1 = $2, legend2 = $3, score = $4, status = 'completed', played_date = $5,
       p1_damage = $6, p2_damage = $7, p1_kos = $8, p2_kos = $9
       WHERE id = $10`,
      [winner_id, legend1 || null, legend2 || null, score || null, playedDateStr,
       p1_damage || 0, p2_damage || 0, p1_kos || 0, p2_kos || 0, req.params.id]
    );

    const roundResult = await pool.query(
      `UPDATE rounds SET status = 'completed'
       WHERE id = $1 AND (
         SELECT COUNT(*) FROM matches WHERE round_id = $1 AND status = 'pending'
       ) = 0`, [match.round_id]
    );

    const hasMoreRounds = await pool.query(`
      SELECT COUNT(*) AS pending FROM rounds WHERE season_id = (
        SELECT season_id FROM rounds WHERE id = $1
      ) AND status = 'pending'
    `, [match.round_id]);

    if (parseInt(hasMoreRounds.rows[0].pending) > 0) {
      await pool.query(`
        UPDATE rounds SET status = 'active'
        WHERE id = (
          SELECT id FROM rounds WHERE season_id = (
            SELECT season_id FROM rounds WHERE id = $1
          ) AND status = 'pending' ORDER BY round_number ASC LIMIT 1
        )
      `, [match.round_id]);
    } else {
      const now2 = new Date().toISOString();
      await pool.query(`
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
    let seasonId = null;
    const activeSeason = await pool.query("SELECT id FROM seasons WHERE status = 'active' LIMIT 1");
    if (activeSeason.rows.length > 0) {
      seasonId = activeSeason.rows[0].id;
    } else {
      const lastSeason = await pool.query("SELECT id FROM seasons ORDER BY id DESC LIMIT 1");
      if (lastSeason.rows.length > 0) {
        seasonId = lastSeason.rows[0].id;
      }
    }

    if (!seasonId) return res.json([]);

    const result = await pool.query(`
      SELECT m.id, m.round_id, r.round_number, m.player1_id, m.player2_id, m.winner_id,
             m.legend1, m.legend2, m.score, m.status, m.played_date, m.scheduled_date, m.rescheduled, m.match_code,
             m.p1_damage, m.p2_damage, m.p1_kos, m.p2_kos,
             p1.brawlhalla_name AS player1_name, p2.brawlhalla_name AS player2_name,
             u1.username AS player1_username, u2.username AS player2_username
      FROM matches m
      JOIN rounds r ON r.id = m.round_id
      JOIN players p1 ON p1.id = m.player1_id
      JOIN players p2 ON p2.id = m.player2_id
      JOIN users u1 ON u1.id = p1.user_id
      JOIN users u2 ON u2.id = p2.user_id
      WHERE m.status = 'completed' AND r.season_id = $1
      ORDER BY m.played_date DESC, m.id DESC
    `, [seasonId]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: EDITAR RESULTADO ───

app.put('/api/admin/matches/:id/result', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { winner_id, legend1, legend2, score, format, p1_damage, p2_damage, p1_kos, p2_kos } = req.body;
    if (!winner_id) return res.status(400).json({ error: 'winner_id required' });

    const matchResult = await pool.query('SELECT round_id, player1_id, player2_id, status FROM matches WHERE id = $1', [req.params.id]);
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

    await pool.query(
      `UPDATE matches SET winner_id = $1, legend1 = $2, legend2 = $3, score = $4, status = 'completed',
       p1_damage = $5, p2_damage = $6, p1_kos = $7, p2_kos = $8
       WHERE id = $9`,
      [winner_id, legend1 || null, legend2 || null, score || null,
       p1_damage || 0, p2_damage || 0, p1_kos || 0, p2_kos || 0, req.params.id]
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
    const matchResult = await pool.query('SELECT round_id, status FROM matches WHERE id = $1', [req.params.id]);
    if (matchResult.rows.length === 0) return res.status(404).json({ error: 'Match not found' });
    if (matchResult.rows[0].status !== 'completed') return res.status(400).json({ error: 'Match is not completed' });

    const roundId = matchResult.rows[0].round_id;

    await pool.query(
      `UPDATE matches SET winner_id = NULL, score = NULL, legend1 = NULL, legend2 = NULL,
       status = 'pending', played_date = NULL
       WHERE id = $1`,
      [req.params.id]
    );

    await pool.query(
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

    const matchResult = await pool.query('SELECT id FROM matches WHERE id = $1', [req.params.id]);
    if (matchResult.rows.length === 0) return res.status(404).json({ error: 'Match not found' });

    await pool.query(
      'UPDATE matches SET scheduled_date = $1, rescheduled = 1 WHERE id = $2',
      [scheduled_date, req.params.id]
    );
    res.json({ message: 'Match rescheduled' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/admin/matches/:id/code', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { match_code } = req.body;
    const cleanCode = String(match_code || '').trim().slice(0, 80);

    const matchResult = await pool.query('SELECT id FROM matches WHERE id = $1', [req.params.id]);
    if (matchResult.rows.length === 0) return res.status(404).json({ error: 'Match not found' });

    await pool.query(
      'UPDATE matches SET match_code = $1 WHERE id = $2',
      [cleanCode || null, req.params.id]
    );
    res.json({ message: 'Match code updated', match_code: cleanCode || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/matches/:id/code', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { match_code } = req.body;
    const cleanCode = String(match_code || '').trim().slice(0, 80);

    const matchResult = await pool.query(
      'SELECT id FROM matches WHERE id = $1',
      [req.params.id]
    );
    if (matchResult.rows.length === 0) return res.status(404).json({ error: 'Match not found' });

    await pool.query(
      'UPDATE matches SET match_code = $1 WHERE id = $2',
      [cleanCode || null, req.params.id]
    );
    res.json({ message: 'Match code updated', match_code: cleanCode || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── SEASONS HISTORY ───

// Helper to compute season champion and stats accurately
async function getSeasonChampion(seasonId) {
  // Step 1: Get round IDs for this season
  const roundsResult = await pool.query('SELECT id FROM rounds WHERE season_id = $1', [seasonId]);
  const roundIds = roundsResult.rows.map(r => r.id);

  // Step 2: Get all season players
  const playersResult = await pool.query(`
    SELECT sp.player_id, sp.initial_position, p.id, p.brawlhalla_name, p.tier, u.username
    FROM season_players sp
    JOIN players p ON p.id = sp.player_id
    JOIN users u ON u.id = p.user_id
    WHERE sp.season_id = $1
  `, [seasonId]);

  if (playersResult.rows.length === 0) return null;

  if (roundIds.length === 0) {
    const p = playersResult.rows[0];
    return {
      player_id: p.id,
      brawlhalla_name: p.brawlhalla_name,
      wins: 0,
      losses: 0,
      points: 0,
      matches_played: 0
    };
  }

  // Step 3: Get completed matches for these rounds
  const matchesResult = await pool.query(`
    SELECT player1_id, player2_id, winner_id
    FROM matches
    WHERE round_id = ANY($1) AND status = 'completed'
  `, [roundIds]);

  // Step 4: Map stats in JS
  const statsMap = {};
  for (const p of playersResult.rows) {
    statsMap[p.id] = { wins: 0, losses: 0, matches_played: 0 };
  }

  for (const m of matchesResult.rows) {
    const p1 = m.player1_id;
    const p2 = m.player2_id;
    if (statsMap[p1]) {
      statsMap[p1].matches_played++;
      if (m.winner_id === p1) statsMap[p1].wins++;
      else if (m.winner_id !== null) statsMap[p1].losses++;
    }
    if (statsMap[p2]) {
      statsMap[p2].matches_played++;
      if (m.winner_id === p2) statsMap[p2].wins++;
      else if (m.winner_id !== null) statsMap[p2].losses++;
    }
  }

  // Step 5: Sort and select the champion
  const rows = playersResult.rows.map(p => {
    const s = statsMap[p.id] || { wins: 0, losses: 0, matches_played: 0 };
    const points = s.wins;
    const diff = s.wins - s.losses;
    return {
      player_id: p.id,
      brawlhalla_name: p.brawlhalla_name,
      points,
      wins: s.wins,
      losses: s.losses,
      matches_played: s.matches_played,
      difference: diff,
      initial_position: p.initial_position || 0
    };
  });

  rows.sort((a, b) => b.points - a.points || b.difference - a.difference || b.wins - a.wins || a.initial_position - b.initial_position);
  return rows[0];
}

app.get('/api/seasons/all', async (req, res) => {
  try {
    const seasonsResult = await pool.query('SELECT * FROM seasons ORDER BY started_at DESC');
    const seasons = seasonsResult.rows;
    if (seasons.length === 0) return res.json([]);

    const enriched = [];
    for (const s of seasons) {
      const champ = await getSeasonChampion(s.id);
      s.champion_name = champ ? champ.brawlhalla_name : null;
      enriched.push(s);
    }
    res.json(enriched);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── HALL OF FAME ───

app.get('/api/hall-of-fame', async (req, res) => {
  try {
    // Show only completed seasons in HOF
    const seasonsResult = await pool.query("SELECT id, name, started_at, ended_at FROM seasons WHERE status = 'completed' ORDER BY ended_at DESC NULLS LAST");
    if (seasonsResult.rows.length === 0) return res.json([]);

    const hofEntries = [];

    for (const s of seasonsResult.rows) {
      const champ = await getSeasonChampion(s.id);
      if (!champ) continue;

      const mp = parseInt(champ.matches_played) || 0;
      const w = parseInt(champ.wins) || 0;

      hofEntries.push({
        id: s.id,
        name: s.name,
        started_at: s.started_at,
        ended_at: s.ended_at,
        champion_id: champ.player_id,
        champion_name: champ.brawlhalla_name,
        wins: w,
        losses: parseInt(champ.losses) || 0,
        points: parseInt(champ.points) || 0,
        matches_played: mp,
        winrate: mp > 0 ? Math.round((w / mp) * 10000) / 100 : 0
      });
    }

    res.json(hofEntries);
  } catch (e) {
    console.error('HOF error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ─── STANDINGS ────────────────────────────────

async function computeStandings(seasonId, res) {
  try {
    // Step 1: Get round IDs for this season (simple indexed lookup)
    const roundsResult = await pool.query('SELECT id FROM rounds WHERE season_id = $1', [seasonId]);
    const roundIds = roundsResult.rows.map(r => r.id);

    // Step 2: Get all season players
    const playersResult = await pool.query(`
      SELECT sp.player_id, sp.initial_position, p.id, p.brawlhalla_name, p.tier, u.username
      FROM season_players sp
      JOIN players p ON p.id = sp.player_id
      JOIN users u ON u.id = p.user_id
      WHERE sp.season_id = $1
    `, [seasonId]);

    if (roundIds.length === 0 || playersResult.rows.length === 0) {
      // No rounds yet, return players with zeroed stats
      return res.json(playersResult.rows.map(p => ({
        id: p.id, brawlhalla_name: p.brawlhalla_name, tier: p.tier, username: p.username,
        points: 0, wins: 0, losses: 0, matches_played: 0, difference: 0, winrate: 0,
        initial_position: p.initial_position || 0
      })));
    }

    // Step 3: Get all completed matches for these rounds in one query
    const matchesResult = await pool.query(`
      SELECT player1_id, player2_id, winner_id, p1_damage, p2_damage, p1_kos, p2_kos
      FROM matches
      WHERE round_id = ANY($1) AND status = 'completed'
    `, [roundIds]);

    // Step 4: Compute stats in JavaScript
    const statsMap = {};
    for (const p of playersResult.rows) {
      statsMap[p.id] = { wins: 0, losses: 0, matches_played: 0, total_kos: 0, total_damage: 0 };
    }

    for (const m of matchesResult.rows) {
      const p1 = m.player1_id;
      const p2 = m.player2_id;
      if (statsMap[p1]) {
        statsMap[p1].matches_played++;
        if (m.winner_id === p1) statsMap[p1].wins++;
        else if (m.winner_id !== null) statsMap[p1].losses++;
        statsMap[p1].total_kos += m.p1_kos || 0;
        statsMap[p1].total_damage += m.p1_damage || 0;
      }
      if (statsMap[p2]) {
        statsMap[p2].matches_played++;
        if (m.winner_id === p2) statsMap[p2].wins++;
        else if (m.winner_id !== null) statsMap[p2].losses++;
        statsMap[p2].total_kos += m.p2_kos || 0;
        statsMap[p2].total_damage += m.p2_damage || 0;
      }
    }

    // Step 5: Build result rows
    const rows = playersResult.rows.map(p => {
      const s = statsMap[p.id] || { wins: 0, losses: 0, matches_played: 0, total_kos: 0, total_damage: 0 };
      const points = s.wins * 3;
      const diff = s.wins - s.losses;
      const winrate = s.matches_played > 0 ? Math.round((s.wins / s.matches_played) * 10000) / 100 : 0;
      return {
        id: p.id, brawlhalla_name: p.brawlhalla_name, tier: p.tier, username: p.username,
        points, wins: s.wins, losses: s.losses, matches_played: s.matches_played,
        difference: diff, winrate, total_kos: s.total_kos, total_damage: s.total_damage,
        initial_position: p.initial_position || 0
      };
    });

    rows.sort((a, b) => b.points - a.points || b.difference - a.difference || b.wins - a.wins || b.total_kos - a.total_kos || a.total_damage - b.total_damage || a.initial_position - b.initial_position);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
}

app.get('/api/standings', async (req, res) => {
  try {
    const requestedSeasonId = req.query.season_id ? parseInt(req.query.season_id) : null;

    if (requestedSeasonId) {
      const seasonCheck = await pool.query('SELECT id, status FROM seasons WHERE id = $1', [requestedSeasonId]);
      if (seasonCheck.rows.length === 0) return res.status(404).json({ error: 'Season not found' });
      await computeStandings(requestedSeasonId, res);
      return;
    }

    const seasonResult = await pool.query("SELECT id FROM seasons WHERE status = 'active' LIMIT 1");
    if (seasonResult.rows.length === 0) {
      const lastSeason = await pool.query("SELECT id FROM seasons ORDER BY id DESC LIMIT 1");
      if (lastSeason.rows.length > 0) {
        await computeStandings(lastSeason.rows[0].id, res);
        return;
      }
      const qualifiers = await pool.query(`
        SELECT q.position, p.id, p.brawlhalla_name, p.tier, u.username, 0 AS points, 0 AS wins, 0 AS losses, 0 AS matches_played, 0 AS difference, 0.00 AS winrate, 0 AS total_kos, 0 AS total_damage
        FROM tournament_qualifiers q
        JOIN players p ON p.id = q.player_id
        JOIN users u ON u.id = p.user_id
        ORDER BY q.position ASC
      `);
      if (qualifiers.rows.length > 0) {
        return res.json(qualifiers.rows);
      }
      const allPlayers = await pool.query(`
        SELECT p.id, p.brawlhalla_name, p.tier, u.username, 0 AS points, 0 AS wins, 0 AS losses, 0 AS matches_played, 0 AS difference, 0.00 AS winrate, 0 AS total_kos, 0 AS total_damage
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

// ─── TOURNAMENT HELPER FUNCTIONS ───

function getRoundRobinPairs(players) {
  let list = [...players];
  if (list.length % 2 !== 0) {
    list.push(null);
  }
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const roundPairs = [];
    for (let i = 0; i < n / 2; i++) {
      const p1 = list[i];
      const p2 = list[n - 1 - i];
      if (p1 !== null && p2 !== null) {
        roundPairs.push([p1, p2]);
      }
    }
    rounds.push(roundPairs);
    // Rotate
    list = [list[0], list[n - 1], ...list.slice(1, n - 1)];
  }
  return rounds;
}

function getRoundName(roundNumber, totalRounds) {
  if (roundNumber === totalRounds) return 'Gran Final';
  if (roundNumber === totalRounds - 1) return 'Semifinales';
  if (roundNumber === totalRounds - 2) return 'Cuartos de Final';
  if (roundNumber === totalRounds - 3) return 'Octavos de Final';
  return `Ronda ${roundNumber}`;
}

async function propagateTournamentMatchWinner(client, matchId, winnerId) {
  const matchRes = await client.query(
    'SELECT m.id, m.round_id, r.round_number, r.tournament_id FROM tournament_matches m JOIN tournament_rounds r ON r.id = m.round_id WHERE m.id = $1',
    [matchId]
  );
  if (matchRes.rows.length === 0) return;
  const currentMatch = matchRes.rows[0];
  
  const roundMatchesRes = await client.query(
    'SELECT id FROM tournament_matches WHERE round_id = $1 ORDER BY id ASC',
    [currentMatch.round_id]
  );
  const matchIndex = roundMatchesRes.rows.findIndex(m => m.id === parseInt(matchId));
  if (matchIndex === -1) return;

  const nextRoundNumber = currentMatch.round_number + 1;
  const nextRoundRes = await client.query(
    'SELECT id FROM tournament_rounds WHERE tournament_id = $1 AND round_number = $2',
    [currentMatch.tournament_id, nextRoundNumber]
  );
  if (nextRoundRes.rows.length === 0) {
    await client.query(
      "UPDATE tournaments SET status = 'completed' WHERE id = $1",
      [currentMatch.tournament_id]
    );
    return;
  }
  const nextRoundId = nextRoundRes.rows[0].id;

  const nextRoundMatchesRes = await client.query(
    'SELECT id, player1_id, player2_id FROM tournament_matches WHERE round_id = $1 ORDER BY id ASC',
    [nextRoundId]
  );
  const targetMatchIndex = Math.floor(matchIndex / 2);
  if (targetMatchIndex >= nextRoundMatchesRes.rows.length) return;
  
  const targetMatch = nextRoundMatchesRes.rows[targetMatchIndex];
  const isPlayer1 = (matchIndex % 2 === 0);

  if (isPlayer1) {
    await client.query(
      'UPDATE tournament_matches SET player1_id = $1 WHERE id = $2',
      [winnerId, targetMatch.id]
    );
  } else {
    await client.query(
      'UPDATE tournament_matches SET player2_id = $1 WHERE id = $2',
      [winnerId, targetMatch.id]
    );
  }
}

async function propagateNewFormatPlayoffMatch(client, tournamentId, matchId, winnerId) {
  const matchRes = await client.query(
    'SELECT m.round_id, r.round_number FROM tournament_matches m JOIN tournament_rounds r ON r.id = m.round_id WHERE m.id = $1',
    [matchId]
  );
  if (matchRes.rows.length === 0) return;
  const rn = matchRes.rows[0].round_number;

  if (rn === 7) {
    const nextRes = await client.query('SELECT id FROM tournament_rounds WHERE tournament_id = $1 AND round_number = 8', [tournamentId]);
    if (nextRes.rows.length === 0) {
      await client.query("UPDATE tournaments SET status = 'completed' WHERE id = $1", [tournamentId]);
    }
    return;
  }

  const roundMatches = await client.query(
    'SELECT id FROM tournament_matches WHERE round_id = $1 ORDER BY id ASC',
    [matchRes.rows[0].round_id]
  );
  const idx = roundMatches.rows.findIndex(m => m.id === parseInt(matchId));
  if (idx === -1) return;

  let targetRoundNumber;
  let targetMatchIdx;
  let targetColumn;

  if (rn === 4) {
    // Play-in → Cuartos (round 5)
    targetRoundNumber = 5;
    const map = [
      { mi: 0, col: 'player1_id' },
      { mi: 1, col: 'player1_id' },
      { mi: 1, col: 'player2_id' },
      { mi: 0, col: 'player2_id' }
    ];
    targetMatchIdx = map[idx].mi;
    targetColumn = map[idx].col;
  } else if (rn === 5) {
    // Cuartos → Semifinales (round 6)
    targetRoundNumber = 6;
    targetMatchIdx = idx;
    targetColumn = 'player2_id';
  } else if (rn === 6) {
    // Semifinales → Gran Final (round 7)
    targetRoundNumber = 7;
    targetMatchIdx = 0;
    targetColumn = idx === 0 ? 'player1_id' : 'player2_id';
  } else {
    return;
  }

  const nextRoundRes = await client.query(
    'SELECT id FROM tournament_rounds WHERE tournament_id = $1 AND round_number = $2',
    [tournamentId, targetRoundNumber]
  );
  if (nextRoundRes.rows.length === 0) return;

  const nextMatches = await client.query(
    'SELECT id FROM tournament_matches WHERE round_id = $1 ORDER BY id ASC',
    [nextRoundRes.rows[0].id]
  );
  if (targetMatchIdx >= nextMatches.rows.length) return;

  await client.query(
    `UPDATE tournament_matches SET ${targetColumn} = $1 WHERE id = $2`,
    [winnerId, nextMatches.rows[targetMatchIdx].id]
  );
}

// ─── TOURNAMENT ENDPOINTS ───

app.get('/api/tournaments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tournaments ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/tournaments/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tournaments WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tournament not found' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/tournaments', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, format } = req.body;
    if (!name || !format) return res.status(400).json({ error: 'Name and format required' });
    if (!['custom_3groups', 'single_elimination'].includes(format)) {
      return res.status(400).json({ error: 'Invalid format' });
    }
    const result = await pool.query(
      "INSERT INTO tournaments (name, format, status) VALUES ($1, $2, 'active') RETURNING *",
      [name, format]
    );
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/tournaments/:id/join', authMiddleware, async (req, res) => {
  try {
    const tournament = await pool.query('SELECT * FROM tournaments WHERE id = $1', [req.params.id]);
    if (tournament.rows.length === 0) return res.status(404).json({ error: 'Tournament not found' });
    if (tournament.rows[0].status !== 'active') return res.status(400).json({ error: 'Tournament is not active' });

    const player = await pool.query('SELECT id, status FROM players WHERE user_id = $1', [req.user.id]);
    if (player.rows.length === 0) return res.status(404).json({ error: 'Player profile not found' });
    if (player.rows[0].status !== 'approved') return res.status(403).json({ error: 'Player account is not approved by admin' });

    const playerId = player.rows[0].id;

    const existing = await pool.query(
      'SELECT id FROM tournament_players WHERE tournament_id = $1 AND player_id = $2',
      [req.params.id, playerId]
    );
    if (existing.rows.length > 0) return res.status(400).json({ error: 'You are already registered for this tournament' });

    const countRes = await pool.query('SELECT COUNT(*) FROM tournament_players WHERE tournament_id = $1', [req.params.id]);
    const seed = parseInt(countRes.rows[0].count) + 1;

    const joinResult = await pool.query(
      `INSERT INTO tournament_players (tournament_id, player_id, status, seed)
       VALUES ($1, $2, 'pending', $3) RETURNING *`,
      [req.params.id, playerId, seed]
    );
    res.json({ message: 'Request to join sent', registration: joinResult.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/tournaments/:id/players', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tp.id, tp.tournament_id, tp.player_id, tp.group_name, tp.status, tp.seed, tp.created_at,
             p.brawlhalla_id, p.brawlhalla_name, p.tier, p.rating, u.username
      FROM tournament_players tp
      JOIN players p ON p.id = tp.player_id
      JOIN users u ON u.id = p.user_id
      WHERE tp.tournament_id = $1
      ORDER BY tp.seed ASC, tp.id ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/tournaments/:id/players/:playerId/verify', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { action } = req.body;
    if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    if (action === 'approved') {
      await pool.query(
        "UPDATE tournament_players SET status = 'approved' WHERE tournament_id = $1 AND player_id = $2",
        [req.params.id, req.params.playerId]
      );
      res.json({ message: 'Player approved for tournament' });
    } else {
      await pool.query(
        "DELETE FROM tournament_players WHERE tournament_id = $1 AND player_id = $2",
        [req.params.id, req.params.playerId]
      );
      res.json({ message: 'Player tournament request removed' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/tournaments/:id/start', authMiddleware, adminMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const tournamentId = req.params.id;
    await client.query('BEGIN');

    const tournament = await client.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (tournament.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const { format } = tournament.rows[0];

    const roundCheck = await client.query('SELECT id FROM tournament_rounds WHERE tournament_id = $1', [tournamentId]);
    if (roundCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Tournament already started' });
    }

    const approvedPlayers = await client.query(
      "SELECT player_id FROM tournament_players WHERE tournament_id = $1 AND status = 'approved' ORDER BY seed ASC",
      [tournamentId]
    );

    if (format === 'custom_3groups') {
      const N = approvedPlayers.rows.length;
      if (N !== 15) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This format requires exactly 15 approved players' });
      }

      const shuffled = [...approvedPlayers.rows].sort(() => Math.random() - 0.5);

      const groupNames = ['A','B','C','D','E'];
      for (let i = 0; i < 15; i++) {
        await client.query(
          'UPDATE tournament_players SET group_name = $1 WHERE tournament_id = $2 AND player_id = $3',
          [groupNames[Math.floor(i / 3)], tournamentId, shuffled[i].player_id]
        );
      }

      const rounds = [];
      for (let r = 1; r <= 3; r++) {
        const roundRes = await client.query(
          'INSERT INTO tournament_rounds (tournament_id, round_number, round_name, status) VALUES ($1, $2, $3, $4) RETURNING id',
          [tournamentId, r, `Grupo - Fecha ${r}`, r === 1 ? 'active' : 'pending']
        );
        rounds.push(roundRes.rows[0].id);
      }

      const groupPlayers = { A: [], B: [], C: [], D: [], E: [] };
      for (let i = 0; i < 15; i++) {
        const g = groupNames[Math.floor(i / 3)];
        groupPlayers[g].push(shuffled[i].player_id);
      }

      for (let r = 1; r <= 3; r++) {
        const roundId = rounds[r - 1];
        for (const g of groupNames) {
          const pairs = getRoundRobinPairs(groupPlayers[g]);
          for (const pair of pairs[r - 1] || []) {
            await client.query(
              "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, $2, $3, 'pending')",
              [roundId, pair[0], pair[1]]
            );
          }
        }
      }

    } else if (format === 'single_elimination') {
      const N = approvedPlayers.rows.length;
      if (N < 2) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'At least 2 approved players are required for single elimination' });
      }

      let M = 2;
      while (M < N) M *= 2;
      const numRounds = Math.log2(M);

      const rounds = [];
      for (let r = 1; r <= numRounds; r++) {
        const roundName = getRoundName(r, numRounds);
        const roundStatus = (r === 1) ? 'active' : 'pending';
        const roundRes = await client.query(
          'INSERT INTO tournament_rounds (tournament_id, round_number, round_name, status) VALUES ($1, $2, $3, $4) RETURNING id',
          [tournamentId, r, roundName, roundStatus]
        );
        rounds.push({ id: roundRes.rows[0].id, round_number: r });
      }

      const r1Id = rounds[0].id;
      const r1Matches = [];

      for (let i = 0; i < M / 2; i++) {
        const p1 = approvedPlayers.rows[2 * i] ? approvedPlayers.rows[2 * i].player_id : null;
        const p2 = approvedPlayers.rows[2 * i + 1] ? approvedPlayers.rows[2 * i + 1].player_id : null;

        if (p1 !== null && p2 !== null) {
          const matchRes = await client.query(
            "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, $2, $3, 'pending') RETURNING id",
            [r1Id, p1, p2]
          );
          r1Matches.push({ id: matchRes.rows[0].id, hasBye: false });
        } else if (p1 !== null && p2 === null) {
          const pad = n => n.toString().padStart(2, '0');
          const nd = new Date();
          const playedDateStr = `${nd.getFullYear()}-${pad(nd.getMonth()+1)}-${pad(nd.getDate())} ${pad(nd.getHours())}:${pad(nd.getMinutes())}`;
          const matchRes = await client.query(
            "INSERT INTO tournament_matches (round_id, player1_id, player2_id, winner_id, score, status, played_date) VALUES ($1, $2, NULL, $2, 'W.O.', 'completed', $3) RETURNING id",
            [r1Id, p1, playedDateStr]
          );
          r1Matches.push({ id: matchRes.rows[0].id, hasBye: true, winnerId: p1 });
        } else {
          const matchRes = await client.query(
            "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, NULL, NULL, 'pending') RETURNING id",
            [r1Id]
          );
          r1Matches.push({ id: matchRes.rows[0].id, hasBye: false });
        }
      }

      for (let r = 2; r <= numRounds; r++) {
        const roundId = rounds[r - 1].id;
        const matchesCount = M / (2 ** r);
        for (let i = 0; i < matchesCount; i++) {
          await client.query(
            "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, NULL, NULL, 'pending')",
            [roundId]
          );
        }
      }

      for (const m of r1Matches) {
        if (m.hasBye) {
          await propagateTournamentMatchWinner(client, m.id, m.winnerId);
        }
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Tournament started and fixtures generated' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.get('/api/tournaments/:id/matches', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tm.id, tm.round_id, tm.player1_id, tm.player2_id, tm.winner_id,
             tm.score, tm.legend1, tm.legend2, tm.status, tm.played_date, tm.scheduled_date,
             tm.p1_damage, tm.p2_damage, tm.p1_kos, tm.p2_kos,
             tr.round_number, tr.round_name,
             p1.brawlhalla_name AS player1_name, p2.brawlhalla_name AS player2_name,
             tp1.group_name AS player1_group, tp2.group_name AS player2_group
      FROM tournament_matches tm
      JOIN tournament_rounds tr ON tr.id = tm.round_id
      LEFT JOIN players p1 ON p1.id = tm.player1_id
      LEFT JOIN players p2 ON p2.id = tm.player2_id
      LEFT JOIN tournament_players tp1 ON (tp1.tournament_id = tr.tournament_id AND tp1.player_id = tm.player1_id)
      LEFT JOIN tournament_players tp2 ON (tp2.tournament_id = tr.tournament_id AND tp2.player_id = tm.player2_id)
      WHERE tr.tournament_id = $1
      ORDER BY tr.round_number ASC, tm.id ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/tournaments/:id/matches/:matchId/result', authMiddleware, adminMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { winner_id, legend1, legend2, score, p1_damage, p2_damage, p1_kos, p2_kos } = req.body;
    if (!winner_id) return res.status(400).json({ error: 'winner_id is required' });

    await client.query('BEGIN');

    const matchRes = await client.query(
      'SELECT tm.*, tr.tournament_id, tr.round_number FROM tournament_matches tm JOIN tournament_rounds tr ON tr.id = tm.round_id WHERE tm.id = $1',
      [req.params.matchId]
    );
    if (matchRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Match not found' });
    }
    const match = matchRes.rows[0];

    if (winner_id !== match.player1_id && winner_id !== match.player2_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Winner must be one of the players' });
    }

    const pad = n => n.toString().padStart(2, '0');
    const nd = new Date();
    const playedDateStr = `${nd.getFullYear()}-${pad(nd.getMonth()+1)}-${pad(nd.getDate())} ${pad(nd.getHours())}:${pad(nd.getMinutes())}`;

    await client.query(
      `UPDATE tournament_matches
       SET winner_id = $1, legend1 = $2, legend2 = $3, score = $4, status = 'completed', played_date = $5,
           p1_damage = $6, p2_damage = $7, p1_kos = $8, p2_kos = $9
       WHERE id = $10`,
      [winner_id, legend1 || null, legend2 || null, score || null, playedDateStr,
       p1_damage || 0, p2_damage || 0, p1_kos || 0, p2_kos || 0, req.params.matchId]
    );

    const tournamentRes = await client.query('SELECT format FROM tournaments WHERE id = $1', [match.tournament_id]);
    const format = tournamentRes.rows[0].format;

    const roundRes = await client.query('SELECT round_name FROM tournament_rounds WHERE id = $1', [match.round_id]);
    const roundName = roundRes.rows[0].round_name;
    const roundNumber = match.round_number;

    const isBracket = (format === 'single_elimination' || roundName.includes('Repechaje') || roundName.includes('Playoffs') || roundName.includes('Final'));

    if (isBracket) {
      if (format === 'custom_3groups' && roundName.includes('Playoffs')) {
        const groupCount = await client.query(
          "SELECT COUNT(DISTINCT group_name) AS cnt FROM tournament_players WHERE tournament_id = $1 AND group_name IS NOT NULL",
          [match.tournament_id]
        );
        const numGroups = parseInt(groupCount.rows[0].cnt);
        if (numGroups === 5) {
          await propagateNewFormatPlayoffMatch(client, match.tournament_id, req.params.matchId, winner_id);
        } else {
          await propagateTournamentMatchWinner(client, req.params.matchId, winner_id);
        }
      } else {
        await propagateTournamentMatchWinner(client, req.params.matchId, winner_id);
      }
    }

    const pendingMatches = await client.query(
      "SELECT COUNT(*) FROM tournament_matches WHERE round_id = $1 AND status = 'pending'",
      [match.round_id]
    );
    if (parseInt(pendingMatches.rows[0].count) === 0) {
      await client.query(
        "UPDATE tournament_rounds SET status = 'completed' WHERE id = $1",
        [match.round_id]
      );

      if (format === 'single_elimination' || (format === 'custom_3groups' && roundName.includes('Playoffs'))) {
        const nextRoundNumber = roundNumber + 1;
        await client.query(
          "UPDATE tournament_rounds SET status = 'active' WHERE tournament_id = $1 AND round_number = $2",
          [match.tournament_id, nextRoundNumber]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Tournament match result recorded' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.get('/api/tournaments/:id/standings', async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const playersRes = await pool.query(`
      SELECT tp.player_id, tp.group_name, tp.seed, p.brawlhalla_name, p.tier, u.username
      FROM tournament_players tp
      JOIN players p ON p.id = tp.player_id
      JOIN users u ON u.id = p.user_id
      WHERE tp.tournament_id = $1 AND tp.status = 'approved'
    `, [tournamentId]);

    const matchesRes = await pool.query(`
      SELECT tm.player1_id, tm.player2_id, tm.winner_id,
             tm.p1_damage, tm.p2_damage, tm.p1_kos, tm.p2_kos
      FROM tournament_matches tm
      JOIN tournament_rounds tr ON tr.id = tm.round_id
      WHERE tr.tournament_id = $1 AND tr.round_number <= 5 AND tr.round_name LIKE 'Grupo%' AND tm.status = 'completed'
    `, [tournamentId]);

    const stats = {};
    for (const p of playersRes.rows) {
      stats[p.player_id] = {
        player_id: p.player_id,
        brawlhalla_name: p.brawlhalla_name,
        username: p.username,
        tier: p.tier,
        group_name: p.group_name,
        seed: p.seed,
        matches_played: 0,
        wins: 0,
        losses: 0,
        points: 0,
        damage_dealt: 0,
        damage_taken: 0,
        kos: 0
      };
    }

    for (const m of matchesRes.rows) {
      const p1 = m.player1_id;
      const p2 = m.player2_id;
      if (stats[p1]) {
        stats[p1].matches_played++;
        stats[p1].damage_dealt += (m.p1_damage || 0);
        stats[p1].damage_taken += (m.p2_damage || 0);
        stats[p1].kos += (m.p1_kos || 0);
        if (m.winner_id === p1) {
          stats[p1].wins++;
          stats[p1].points += 1;
        } else if (m.winner_id === p2) {
          stats[p1].losses++;
        }
      }
      if (stats[p2]) {
        stats[p2].matches_played++;
        stats[p2].damage_dealt += (m.p2_damage || 0);
        stats[p2].damage_taken += (m.p1_damage || 0);
        stats[p2].kos += (m.p2_kos || 0);
        if (m.winner_id === p2) {
          stats[p2].wins++;
          stats[p2].points += 1;
        } else if (m.winner_id === p1) {
          stats[p2].losses++;
        }
      }
    }

    const list = Object.values(stats);
    const groupNames = ['A','B','C','D','E'];
    const groups = {};
    for (const g of groupNames) groups[g] = [];
    for (const item of list) {
      if (groups[item.group_name]) groups[item.group_name].push(item);
    }

    const sortFn = (a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.kos !== a.kos) return b.kos - a.kos;
      const diffB = b.damage_dealt - b.damage_taken;
      const diffA = a.damage_dealt - a.damage_taken;
      if (diffB !== diffA) return diffB - diffA;
      if (b.damage_dealt !== a.damage_dealt) return b.damage_dealt - a.damage_dealt;
      return a.seed - b.seed;
    };

    for (const g of groupNames) groups[g].sort(sortFn);

    res.json(groups);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/tournaments/:id/generate-repechaje', authMiddleware, adminMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const tournamentId = req.params.id;
    await client.query('BEGIN');

    const tournament = await client.query('SELECT format FROM tournaments WHERE id = $1', [tournamentId]);
    if (tournament.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const groupCount = await client.query(
      "SELECT COUNT(DISTINCT group_name) AS cnt FROM tournament_players WHERE tournament_id = $1 AND group_name IS NOT NULL",
      [tournamentId]
    );
    const numGroups = parseInt(groupCount.rows[0].cnt);

    if (numGroups === 5) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'New format (5 grupos de 3) does not have a repechaje phase. Use GENERAR PLAYOFFS instead.' });
    }

    const roundCheck = await client.query(
      "SELECT id FROM tournament_rounds WHERE tournament_id = $1 AND round_name = 'Repechaje'",
      [tournamentId]
    );
    if (roundCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Repechaje already generated' });
    }

    const pendingCount = await client.query(`
      SELECT COUNT(*)
      FROM tournament_matches tm
      JOIN tournament_rounds tr ON tr.id = tm.round_id
      WHERE tr.tournament_id = $1 AND tr.round_number <= 5 AND tm.status = 'pending'
    `, [tournamentId]);

    if (parseInt(pendingCount.rows[0].count) > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Not all group phase matches are completed yet' });
    }

    const playersRes = await client.query(`
      SELECT tp.player_id, tp.group_name, tp.seed, p.brawlhalla_name, p.tier, u.username
      FROM tournament_players tp
      JOIN players p ON p.id = tp.player_id
      JOIN users u ON u.id = p.user_id
      WHERE tp.tournament_id = $1 AND tp.status = 'approved'
    `, [tournamentId]);

    const matchesRes = await client.query(`
      SELECT tm.player1_id, tm.player2_id, tm.winner_id,
             tm.p1_damage, tm.p2_damage, tm.p1_kos, tm.p2_kos
      FROM tournament_matches tm
      JOIN tournament_rounds tr ON tr.id = tm.round_id
      WHERE tr.tournament_id = $1 AND tr.round_number <= 5 AND tr.round_name LIKE 'Grupo%' AND tm.status = 'completed'
    `, [tournamentId]);

    const stats = {};
    for (const p of playersRes.rows) {
      stats[p.player_id] = {
        player_id: p.player_id, group_name: p.group_name, seed: p.seed,
        points: 0, kos: 0, damage_dealt: 0, damage_taken: 0
      };
    }

    for (const m of matchesRes.rows) {
      for (const side of [
        { pid: m.player1_id, dmg: m.p1_damage, kos: m.p1_kos, winner: m.winner_id },
        { pid: m.player2_id, dmg: m.p2_damage, kos: m.p2_kos, winner: m.winner_id }
      ]) {
        if (stats[side.pid]) {
          stats[side.pid].damage_dealt += (side.dmg || 0);
          stats[side.pid].kos += (side.kos || 0);
          if (side.winner === side.pid) stats[side.pid].points += 1;
        }
      }
    }

    const groups = { A: [], B: [], C: [] };
    for (const item of Object.values(stats)) {
      if (groups[item.group_name]) groups[item.group_name].push(item);
    }

    const sortFn = (a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.kos !== a.kos) return b.kos - a.kos;
      const diffB = b.damage_dealt - b.damage_taken;
      const diffA = a.damage_dealt - a.damage_taken;
      if (diffB !== diffA) return diffB - diffA;
      if (b.damage_dealt !== a.damage_dealt) return b.damage_dealt - a.damage_dealt;
      return a.seed - b.seed;
    };

    groups.A.sort(sortFn);
    groups.B.sort(sortFn);
    groups.C.sort(sortFn);

    const a3 = groups.A[2].player_id;
    const a4 = groups.A[3].player_id;
    const b3 = groups.B[2].player_id;
    const b4 = groups.B[3].player_id;
    const c3 = groups.C[2].player_id;
    const c4 = groups.C[3].player_id;

    const roundRes = await client.query(
      "INSERT INTO tournament_rounds (tournament_id, round_number, round_name, status) VALUES ($1, 6, 'Repechaje', 'active') RETURNING id",
      [tournamentId]
    );
    const roundId = roundRes.rows[0].id;

    await client.query(
      "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, $2, $3, 'pending')",
      [roundId, a3, b4]
    );
    await client.query(
      "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, $2, $3, 'pending')",
      [roundId, b3, c4]
    );
    await client.query(
      "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, $2, $3, 'pending')",
      [roundId, c3, a4]
    );

    await client.query('COMMIT');
    res.json({ message: 'Repechaje bracket generated successfully' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

async function finalizeTournamentNewFormat(client, tournamentId) {
  // Clean up any leftover playoff rounds from previous deploys
  await client.query(`
    DELETE FROM tournament_matches WHERE round_id IN (
      SELECT id FROM tournament_rounds WHERE tournament_id = $1 AND round_number > 3
    )
  `, [tournamentId]);
  await client.query(
    'DELETE FROM tournament_rounds WHERE tournament_id = $1 AND round_number > 3',
    [tournamentId]
  );

  const pendingCount = await client.query(`
    SELECT COUNT(*) FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.id = tm.round_id
    WHERE tr.tournament_id = $1 AND tr.round_number <= 3 AND tm.status = 'pending'
  `, [tournamentId]);
  if (parseInt(pendingCount.rows[0].count) > 0) {
    throw new Error('Not all group matches are completed yet');
  }

  const playersRes = await client.query(`
    SELECT tp.player_id, tp.group_name, tp.seed, p.brawlhalla_name, p.tier, u.username
    FROM tournament_players tp
    JOIN players p ON p.id = tp.player_id
    JOIN users u ON u.id = p.user_id
    WHERE tp.tournament_id = $1 AND tp.status = 'approved'
  `, [tournamentId]);

  const matchesRes = await client.query(`
    SELECT tm.player1_id, tm.player2_id, tm.winner_id,
           tm.p1_damage, tm.p2_damage, tm.p1_kos, tm.p2_kos
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.id = tm.round_id
    WHERE tr.tournament_id = $1 AND tr.round_number <= 3 AND tm.status = 'completed'
  `, [tournamentId]);

  const stats = {};
  for (const p of playersRes.rows) {
    stats[p.player_id] = { player_id: p.player_id, group_name: p.group_name, seed: p.seed, points: 0, kos: 0, damage_dealt: 0, damage_taken: 0 };
  }
  for (const m of matchesRes.rows) {
    for (const side of [
      { pid: m.player1_id, opp: m.player2_id, dmg: m.p1_damage, kos: m.p1_kos, winner: m.winner_id },
      { pid: m.player2_id, opp: m.player1_id, dmg: m.p2_damage, kos: m.p2_kos, winner: m.winner_id }
    ]) {
      if (stats[side.pid]) {
        stats[side.pid].damage_dealt += (side.dmg || 0);
        stats[side.pid].kos += (side.kos || 0);
        if (side.winner === side.pid) stats[side.pid].points += 1;
      }
    }
  }

  const groups = { A: [], B: [], C: [], D: [], E: [] };
  for (const item of Object.values(stats)) {
    if (groups[item.group_name]) groups[item.group_name].push(item);
  }

  const sortFn = (a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.kos !== a.kos) return b.kos - a.kos;
    const diffB = b.damage_dealt - b.damage_taken;
    const diffA = a.damage_dealt - a.damage_taken;
    if (diffB !== diffA) return diffB - diffA;
    if (b.damage_dealt !== a.damage_dealt) return b.damage_dealt - a.damage_dealt;
    return a.seed - b.seed;
  };

  for (const g of Object.keys(groups)) groups[g].sort(sortFn);

  // Send elimination messages to 3rd place in each group
  const msg = 'Gracias por participar. Sigue mejorando para poder participar en la liga, no te rindas, habrán más torneos próximamente.';
  for (const g of Object.keys(groups)) {
    if (groups[g].length >= 3) {
      await client.query(
        'INSERT INTO tournament_player_messages (tournament_id, player_id, message) VALUES ($1, $2, $3)',
        [tournamentId, groups[g][2].player_id, msg]
      );
    }
  }

  // Store qualified players (top 2 per group) in tournament_qualifiers
  let globalPos = 1;
  for (const g of Object.keys(groups)) {
    for (let pos = 0; pos < 2 && pos < groups[g].length; pos++) {
      await client.query(
        'INSERT INTO tournament_qualifiers (tournament_id, player_id, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [tournamentId, groups[g][pos].player_id, globalPos]
      );
      globalPos++;
    }
  }

  // Mark tournament as completed
  await client.query("UPDATE tournaments SET status = 'completed' WHERE id = $1", [tournamentId]);
}

async function generatePlayoffsOldFormat(client, tournamentId) {
  const playersRes = await client.query(`
    SELECT tp.player_id, tp.group_name, tp.seed, p.brawlhalla_name, p.tier, u.username
    FROM tournament_players tp
    JOIN players p ON p.id = tp.player_id
    JOIN users u ON u.id = p.user_id
    WHERE tp.tournament_id = $1 AND tp.status = 'approved'
  `, [tournamentId]);

  const matchesRes = await client.query(`
    SELECT tm.player1_id, tm.player2_id, tm.winner_id,
           tm.p1_damage, tm.p2_damage, tm.p1_kos, tm.p2_kos
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.id = tm.round_id
    WHERE tr.tournament_id = $1 AND tr.round_number <= 5 AND tr.round_name LIKE 'Grupo%' AND tm.status = 'completed'
  `, [tournamentId]);

  const stats = {};
  for (const p of playersRes.rows) {
    stats[p.player_id] = { player_id: p.player_id, group_name: p.group_name, seed: p.seed, points: 0, kos: 0, damage_dealt: 0, damage_taken: 0 };
  }
  for (const m of matchesRes.rows) {
    for (const side of [
      { pid: m.player1_id, opp: m.player2_id, dmg: m.p1_damage, kos: m.p1_kos, winner: m.winner_id },
      { pid: m.player2_id, opp: m.player1_id, dmg: m.p2_damage, kos: m.p2_kos, winner: m.winner_id }
    ]) {
      if (stats[side.pid]) {
        stats[side.pid].damage_dealt += (side.dmg || 0);
        stats[side.pid].kos += (side.kos || 0);
        if (side.winner === side.pid) stats[side.pid].points += 1;
      }
    }
  }

  const groups = { A: [], B: [], C: [] };
  for (const item of Object.values(stats)) {
    if (groups[item.group_name]) groups[item.group_name].push(item);
  }

  const sortFn = (a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.kos !== a.kos) return b.kos - a.kos;
    const diffB = b.damage_dealt - b.damage_taken;
    const diffA = a.damage_dealt - a.damage_taken;
    if (diffB !== diffA) return diffB - diffA;
    if (b.damage_dealt !== a.damage_dealt) return b.damage_dealt - a.damage_dealt;
    return a.seed - b.seed;
  };

  groups.A.sort(sortFn);
  groups.B.sort(sortFn);
  groups.C.sort(sortFn);

  const a5 = groups.A[4].player_id;
  const b5 = groups.B[4].player_id;
  const c5 = groups.C[4].player_id;

  const repechajeRoundRes = await client.query(
    "SELECT id, status FROM tournament_rounds WHERE tournament_id = $1 AND round_name = 'Repechaje'",
    [tournamentId]
  );
  if (repechajeRoundRes.rows.length === 0 || repechajeRoundRes.rows[0].status !== 'completed') {
    throw new Error('Repechaje must be completed before generating playoffs');
  }

  const repMatchesRes = await client.query(
    "SELECT id, player1_id, player2_id, winner_id FROM tournament_matches WHERE round_id = $1",
    [repechajeRoundRes.rows[0].id]
  );
  const losers = repMatchesRes.rows.map(m => {
    return m.winner_id === m.player1_id ? m.player2_id : m.player1_id;
  });

  const r7 = await client.query(
    "INSERT INTO tournament_rounds (tournament_id, round_number, round_name, status) VALUES ($1, 7, 'Playoffs - Cuartos de Final', 'active') RETURNING id",
    [tournamentId]
  );
  const r8 = await client.query(
    "INSERT INTO tournament_rounds (tournament_id, round_number, round_name, status) VALUES ($1, 8, 'Playoffs - Semifinales', 'pending') RETURNING id",
    [tournamentId]
  );
  const r9 = await client.query(
    "INSERT INTO tournament_rounds (tournament_id, round_number, round_name, status) VALUES ($1, 9, 'Playoffs - Gran Final', 'pending') RETURNING id",
    [tournamentId]
  );

  const r7Id = r7.rows[0].id;
  const r8Id = r8.rows[0].id;
  const r9Id = r9.rows[0].id;

  const semi1 = await client.query(
    "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, NULL, NULL, 'pending') RETURNING id",
    [r8Id]
  );
  const semi2 = await client.query(
    "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, NULL, NULL, 'pending') RETURNING id",
    [r8Id]
  );
  await client.query(
    "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, NULL, NULL, 'pending')",
    [r9Id]
  );

  const pad = n => n.toString().padStart(2, '0');
  const nd = new Date();
  const playedDateStr = `${nd.getFullYear()}-${pad(nd.getMonth()+1)}-${pad(nd.getDate())} ${pad(nd.getHours())}:${pad(nd.getMinutes())}`;

  const m1 = await client.query(
    "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, $2, $3, 'pending') RETURNING id",
    [r7Id, losers[0], a5]
  );
  const m2 = await client.query(
    "INSERT INTO tournament_matches (round_id, player1_id, player2_id, status) VALUES ($1, $2, $3, 'pending') RETURNING id",
    [r7Id, losers[1], b5]
  );
  const m3 = await client.query(
    "INSERT INTO tournament_matches (round_id, player1_id, player2_id, winner_id, status, score, played_date) VALUES ($1, $2, NULL, $2, 'completed', 'W.O.', $3) RETURNING id",
    [r7Id, losers[2], playedDateStr]
  );
  const m4 = await client.query(
    "INSERT INTO tournament_matches (round_id, player1_id, player2_id, winner_id, status, score, played_date) VALUES ($1, $2, NULL, $2, 'completed', 'W.O.', $3) RETURNING id",
    [r7Id, c5, playedDateStr]
  );

  await propagateTournamentMatchWinner(client, m3.rows[0].id, losers[2]);
  await propagateTournamentMatchWinner(client, m4.rows[0].id, c5);
}

app.post('/api/tournaments/:id/generate-playoffs', authMiddleware, adminMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const tournamentId = req.params.id;
    await client.query('BEGIN');

    const tournament = await client.query('SELECT format FROM tournaments WHERE id = $1', [tournamentId]);
    if (tournament.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Tournament not found' });
    }
    if (tournament.rows[0].format !== 'custom_3groups') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This action is only available for custom_3groups format' });
    }

    if (tournament.rows[0].status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Tournament already finalized' });
    }

    // Detect if this is old format (3 groups) or new format (5 groups)
    const groupCount = await client.query(
      "SELECT COUNT(DISTINCT group_name) AS cnt FROM tournament_players WHERE tournament_id = $1 AND group_name IS NOT NULL",
      [tournamentId]
    );
    const numGroups = parseInt(groupCount.rows[0].cnt);

    if (numGroups === 5) {
      await finalizeTournamentNewFormat(client, tournamentId);
    } else {
      await generatePlayoffsOldFormat(client, tournamentId);
    }

    await client.query('COMMIT');
    res.json({ message: '¡Jugadores clasificados! Ahora puedes crear una temporada/liga y los 10 clasificados se agregarán automáticamente.' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  } finally {
    client.release();
  }
});

app.get('/api/tournament-messages', authMiddleware, async (req, res) => {
  try {
    const player = await pool.query('SELECT id FROM players WHERE user_id = $1', [req.user.id]);
    if (player.rows.length === 0) return res.json([]);
    const result = await pool.query(
      `SELECT tpm.id, tpm.message, tpm.read, tpm.created_at, t.name AS tournament_name
       FROM tournament_player_messages tpm
       JOIN tournaments t ON t.id = tpm.tournament_id
       WHERE tpm.player_id = $1
       ORDER BY tpm.created_at DESC`,
      [player.rows[0].id]
    );
    if (result.rows.length > 0) {
      await pool.query(
        'UPDATE tournament_player_messages SET read = true WHERE player_id = $1 AND read = false',
        [player.rows[0].id]
      );
    }
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── REPLAY PARSING ───

const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');

const replayUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.replay';
      cb(null, crypto.randomBytes(8).toString('hex') + ext);
    }
  }),
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.replay') || file.mimetype === 'application/octet-stream')
      cb(null, true);
    else
      cb(new Error('Only .replay files are allowed'));
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.post('/api/replay/parse', authMiddleware, adminMiddleware, (req, res) => {
  replayUpload.single('replay')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No replay file provided' });

    try {
      const data = extractMatchData(req.file.path);
      fs.unlink(req.file.path, () => {});
      res.json(data);
    } catch (e) {
      fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: 'Failed to parse replay: ' + (e.message || e) });
    }
  });
});

app.post('/api/replay/parse-path', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const data = extractMatchData(filePath);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: 'Failed to parse replay: ' + (e.message || e) });
  }
});

// ─── BRAWLHALLA NAME SEARCH ───

app.get('/api/brawlhalla/search', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const name = req.query.name;
    if (!name || name.length < 2) return res.json([]);
    const results = await brawlhalla.searchPlayerByName(name);
    const unique = {};
    for (const r of results) {
      if (r.brawlhalla_id && !unique[r.brawlhalla_id]) {
        unique[r.brawlhalla_id] = { brawlhalla_id: r.brawlhalla_id, name: r.name, rating: r.rating, tier: r.tier };
      }
    }
    res.json(Object.values(unique).slice(0, 10));
  } catch (e) {
    res.json([]);
  }
});

// ─── REPLAY AUTO-RESULT ───

app.post('/api/matches/:id/auto-result', authMiddleware, adminMiddleware, (req, res) => {
  replayUpload.single('replay')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No replay file provided' });

    try {
      const matchResult = await pool.query(
        `SELECT m.id, m.player1_id, m.player2_id,
                p1.brawlhalla_name AS p1_name, p1.brawlhalla_id AS p1_bhid,
                p2.brawlhalla_name AS p2_name, p2.brawlhalla_id AS p2_bhid
         FROM matches m
         JOIN players p1 ON p1.id = m.player1_id
         JOIN players p2 ON p2.id = m.player2_id
         WHERE m.id = $1`, [req.params.id]
      );
      if (matchResult.rows.length === 0) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Match not found' });
      }

      const match = matchResult.rows[0];
      const replay = parseReplay(req.file.path);
      const data = extractMatchData(req.file.path);
      fs.unlink(req.file.path, () => {});

      const syncName = async (playerId, brawlhallaId) => {
        if (!brawlhallaId) return null;
        try {
          const info = await brawlhalla.verifyPlayerExists(brawlhallaId);
          if (info && info.name) {
            const old = await pool.query('SELECT brawlhalla_name FROM players WHERE id = $1', [playerId]);
            const oldName = old.rows[0]?.brawlhalla_name || '';
            if (oldName !== info.name) {
              await pool.query('UPDATE players SET brawlhalla_name = $1 WHERE id = $2', [info.name, playerId]);
              return { old: oldName, new: info.name };
            }
          }
        } catch (e) {}
        return null;
      };

      const sync1 = await syncName(match.player1_id, match.p1_bhid);
      const sync2 = await syncName(match.player2_id, match.p2_bhid);

      const p1Name = (sync1?.new || match.p1_name || '').toLowerCase().trim();
      const p2Name = (sync2?.new || match.p2_name || '').toLowerCase().trim();

      const detection = {
        player1: { dbName: sync1?.new || match.p1_name || '', replayName: null, matched: false, synced: !!sync1, oldName: sync1?.old },
        player2: { dbName: sync2?.new || match.p2_name || '', replayName: null, matched: false, synced: !!sync2, oldName: sync2?.old },
      };

      let replayP1 = null, replayP2 = null;
      for (const e of replay.entities) {
        const en = e.name.toLowerCase().trim();
        if (!replayP1 && (en.includes(p1Name) || p1Name.includes(en))) { replayP1 = e; detection.player1.matched = true; detection.player1.replayName = e.name; }
        if (!replayP2 && (en.includes(p2Name) || p2Name.includes(en))) { replayP2 = e; detection.player2.matched = true; detection.player2.replayName = e.name; }
      }

      if (!replayP1 && !replayP2) {
        replayP1 = replay.entities[0]; detection.player1.replayName = replayP1?.name;
        replayP2 = replay.entities[1]; detection.player2.replayName = replayP2?.name;
      } else if (!replayP1) {
        replayP1 = replay.entities.find(e => e.id !== replayP2?.id);
        detection.player1.replayName = replayP1?.name;
      } else if (!replayP2) {
        replayP2 = replay.entities.find(e => e.id !== replayP1?.id);
        detection.player2.replayName = replayP2?.name;
      }

      const scores = data.perEntityScores || {};
      const score1 = scores[replayP1?.id] ?? 99;
      const score2 = scores[replayP2?.id] ?? 99;
      const winnerEntity = score1 < score2 ? replayP1 : replayP2;
      const winnerId = winnerEntity?.id === replayP1?.id ? match.player1_id : match.player2_id;

      const deaths = data.perEntityDeaths || {};
      const p1Kos = deaths[replayP2?.id] || 0;
      const p2Kos = deaths[replayP1?.id] || 0;

      const getLegend = (entity) => {
        if (!entity || !entity.data?.heroTypes?.length) return '';
        const h = entity.data.heroTypes[0];
        return `Hero_${h.heroId}`;
      };

      const legend1 = getLegend(replayP1);
      const legend2 = getLegend(replayP2);

      res.json({
        matchId: parseInt(req.params.id),
        detection,
        suggestion: {
          winner_id: winnerId,
          legend1,
          legend2,
          p1_kos: p1Kos,
          p2_kos: p2Kos,
          score: `${Math.max(p1Kos, p2Kos)}-${Math.min(p1Kos, p2Kos)}`,
        }
      });
    } catch (e) {
      if (req.file) fs.unlink(req.file.path, () => {});
      console.error(e);
      res.status(400).json({ error: 'Failed to parse replay: ' + (e.message || e) });
    }
  });
});

// ─── SYNC PLAYER NAMES ───

app.post('/api/admin/players/sync-names', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, brawlhalla_id, brawlhalla_name FROM players WHERE brawlhalla_id IS NOT NULL');
    let synced = 0;
    for (const p of rows) {
      try {
        const info = await brawlhalla.verifyPlayerExists(p.brawlhalla_id);
        if (info && info.name && info.name !== p.brawlhalla_name) {
          await pool.query('UPDATE players SET brawlhalla_name = $1 WHERE id = $2', [info.name, p.id]);
          synced++;
        }
      } catch (e) {}
    }
    res.json({ message: `${synced} nombres actualizados de ${rows.length} jugadores` });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/players/:id/sync-name', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, brawlhalla_id, brawlhalla_name FROM players WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Player not found' });
    const p = rows[0];
    if (!p.brawlhalla_id) return res.json({ message: 'No brawlhalla_id', changed: false });
    const info = await brawlhalla.verifyPlayerExists(p.brawlhalla_id);
    if (info && info.name) {
      if (info.name !== p.brawlhalla_name) {
        await pool.query('UPDATE players SET brawlhalla_name = $1 WHERE id = $2', [info.name, p.id]);
        return res.json({ message: `Nombre actualizado: ${p.brawlhalla_name} → ${info.name}`, changed: true, oldName: p.brawlhalla_name, newName: info.name });
      }
      return res.json({ message: `Nombre ya está actualizado: ${p.brawlhalla_name}`, changed: false });
    }
    res.json({ message: 'No se pudo verificar', changed: false });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── SEED ADMIN ───

async function seedAdmin() {
  const { rows } = await pool.query('SELECT id FROM users WHERE role = $1 LIMIT 1', ['admin']);
  if (rows.length === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
    const userResult = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [process.env.ADMIN_USERNAME || 'admin', hash, 'admin']);
    const userId = userResult.rows[0].id;
    await pool.query(
      `INSERT INTO players (user_id, brawlhalla_id, brawlhalla_name, status)
       VALUES ($1, NULL, $2, 'approved')`,
      [userId, process.env.ADMIN_USERNAME || 'admin']
    );
    console.log('Admin user created');
  }
}

// ─── START ───

async function start() {
  await initDB();
  await seedAdmin();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();
