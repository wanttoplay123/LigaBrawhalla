const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'player' CHECK (role IN ('admin', 'player')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        brawlhalla_id INTEGER UNIQUE,
        brawlhalla_name TEXT,
        tier TEXT,
        rating INTEGER DEFAULT 0,
        damage_dealt INTEGER DEFAULT 0,
        damage_taken INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS seasons (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed')),
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS season_players (
        id SERIAL PRIMARY KEY,
        season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
        player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        initial_position INTEGER,
        UNIQUE(season_id, player_id)
      );
      CREATE TABLE IF NOT EXISTS rounds (
        id SERIAL PRIMARY KEY,
        season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
        round_number INTEGER NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed')),
        UNIQUE(season_id, round_number)
      );
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        round_id INTEGER REFERENCES rounds(id) ON DELETE CASCADE,
        player1_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        player2_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        winner_id INTEGER REFERENCES players(id),
        legend1 TEXT,
        legend2 TEXT,
        score TEXT,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
        scheduled_date TEXT,
        rescheduled INTEGER DEFAULT 0,
        played_date TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_rounds_season_id ON rounds(season_id);
      CREATE INDEX IF NOT EXISTS idx_season_players_season_id ON season_players(season_id);
      CREATE INDEX IF NOT EXISTS idx_matches_round_id ON matches(round_id);
      CREATE INDEX IF NOT EXISTS idx_matches_player1_id ON matches(player1_id);
      CREATE INDEX IF NOT EXISTS idx_matches_player2_id ON matches(player2_id);
      CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);

      DELETE FROM matches WHERE status = 'cancelled';
    `);
    console.log('PostgreSQL tables ready with indexes and cleaned up');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
