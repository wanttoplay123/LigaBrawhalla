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
        match_code TEXT,
        played_date TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_rounds_season_id ON rounds(season_id);
      CREATE INDEX IF NOT EXISTS idx_season_players_season_id ON season_players(season_id);
      CREATE INDEX IF NOT EXISTS idx_matches_round_id ON matches(round_id);
      CREATE INDEX IF NOT EXISTS idx_matches_player1_id ON matches(player1_id);
      CREATE INDEX IF NOT EXISTS idx_matches_player2_id ON matches(player2_id);
      CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);

      CREATE TABLE IF NOT EXISTS tournaments (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('custom_3groups', 'single_elimination')),
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tournament_players (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        group_name TEXT CHECK (group_name IN ('A', 'B', 'C', 'D', 'E') OR group_name IS NULL),
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
        seed INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tournament_id, player_id)
      );
      CREATE TABLE IF NOT EXISTS tournament_rounds (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        round_number INTEGER NOT NULL,
        round_name TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed'))
      );
      CREATE TABLE IF NOT EXISTS tournament_matches (
        id SERIAL PRIMARY KEY,
        round_id INTEGER REFERENCES tournament_rounds(id) ON DELETE CASCADE,
        player1_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        player2_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        winner_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
        score TEXT,
        legend1 TEXT,
        legend2 TEXT,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
        played_date TEXT,
        scheduled_date TEXT,
        p1_damage INTEGER DEFAULT 0,
        p2_damage INTEGER DEFAULT 0,
        p1_kos INTEGER DEFAULT 0,
        p2_kos INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_tournament_players_tournament_id ON tournament_players(tournament_id);
      CREATE INDEX IF NOT EXISTS idx_tournament_rounds_tournament_id ON tournament_rounds(tournament_id);
      CREATE INDEX IF NOT EXISTS idx_tournament_matches_round_id ON tournament_matches(round_id);

      CREATE TABLE IF NOT EXISTS tournament_player_messages (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        read BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tournament_qualifiers (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        position INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tournament_id, player_id)
      );

      DELETE FROM matches WHERE status = 'cancelled';

      ALTER TABLE matches ADD COLUMN IF NOT EXISTS match_code TEXT;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS p1_damage INTEGER DEFAULT 0;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS p2_damage INTEGER DEFAULT 0;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS p1_kos INTEGER DEFAULT 0;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS p2_kos INTEGER DEFAULT 0;

      -- Allow groups D and E for new 5-group format
      ALTER TABLE tournament_players DROP CONSTRAINT IF EXISTS tournament_players_group_name_check;
      ALTER TABLE tournament_players ADD CONSTRAINT tournament_players_group_name_check CHECK (group_name IN ('A', 'B', 'C', 'D', 'E') OR group_name IS NULL);
    `);
    console.log('PostgreSQL tables ready with indexes and cleaned up');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
