const https = require('https');

const API_BASE = 'https://api.brawlhalla.com/v1';

function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${path}`;
    const options = { headers: { 'User-Agent': 'LigaBrawlhalla/1.0' } };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Brawlhalla API returned status ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON from Brawlhalla API'));
        }
      });
    }).on('error', reject);
  });
}

async function searchPlayer(name) {
  try {
    const data = await apiRequest(`/leaderboard/ranked?game_mode=1v1&region=ALL&search=${encodeURIComponent(name)}`);
    return (data.rankings || []).map(r => ({
      brawlhalla_id: r.players?.[0]?.id,
      name: r.players?.[0]?.username,
      rating: r.rating,
      tier: r.tier,
      wins: r.wins,
      losses: r.losses,
      region: r.region
    }));
  } catch (e) {
    return [];
  }
}

async function searchPlayerByName(name) {
  try {
    const results = await searchPlayer(name);
    if (results.length > 0) return results;
  } catch {}
  const clean = name.replace(/[^a-zA-Z0-9 ]/g, '').trim();
  if (clean && clean !== name) {
    const results = await searchPlayer(clean);
    if (results.length > 0) return results;
  }
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const last = words[words.length - 1];
    if (last.length > 2) return searchPlayer(last);
  }
  return [];
}

async function getPlayerStats(brawlhallaId) {
  try {
    const data = await apiRequest(`/player/stats?brawlhalla_id=${brawlhallaId}&mode=all`);
    return data;
  } catch (e) {
    return null;
  }
}

async function getPlayerRankedStats(brawlhallaId) {
  try {
    const data = await apiRequest(`/player/stats?brawlhalla_id=${brawlhallaId}&mode=ranked_1v1`);
    return data;
  } catch (e) {
    return null;
  }
}

async function verifyPlayerExists(brawlhallaId) {
  const data = await getPlayerStats(brawlhallaId);
  if (!data || !data.brawlhalla_id) return null;

  let totalDamageDealt = 0;
  let totalDamageTaken = 0;
  if (data.legends) {
    data.legends.forEach(l => {
      totalDamageDealt += l.damage_dealt || 0;
      totalDamageTaken += l.damage_taken || 0;
    });
  }

  // Search leaderboard for tier data
  let tier = null;
  let rating = 0;
  if (data.name) {
    const results = await searchPlayerByName(data.name);
    const match = results.find(r => r.brawlhalla_id === brawlhallaId);
    if (match) {
      tier = match.tier;
      rating = match.rating;
    }
  }

  return {
    ...data,
    tier,
    rating,
    total_damage_dealt: totalDamageDealt,
    total_damage_taken: totalDamageTaken
  };
}

module.exports = { searchPlayer, searchPlayerByName, getPlayerStats, getPlayerRankedStats, verifyPlayerExists };
