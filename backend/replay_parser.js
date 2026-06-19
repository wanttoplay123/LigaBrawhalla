const fs = require('fs');
const zlib = require('zlib');

const XOR_KEY = [107,16,222,60,68,75,209,70,160,16,82,193,178,49,211,106,251,172,17,222,6,104,8,120,140,213,179,249,106,64,214,19,12,174,157,197,212,107,84,114,252,87,93,26,6,115,194,81,75,176,201,140,120,4,17,122,239,116,62,70,57,160,199,166];

const HEROES = {
  1:'Bödvar',2:'Cassidy',3:'Orion',4:'Lord Vraxx',5:'Gnash',6:'Queen Nai',
  7:'Hattori',8:'Sir Roland',9:'Scarlet',10:'Thatch',11:'Ada',12:'Sentinel',
  13:'Lucien',14:'Teros',15:'Brynn',16:'Asuri',17:'Barraza',18:'Ember',
  19:'Azoth',20:'Koji',21:'Ulgrim',22:'Diana',23:'Jhala',24:'Kor',
  25:'Wu Shang',26:'Val',27:'Ragnir',28:'Cross',29:'Mirage',30:'Nix',
  31:'Mordex',32:'Yumiko',33:'Artemis',34:'Caspian',35:'Sidra',36:'Xull',
  37:'Kaya',38:'Isaiah',39:'Jiro',40:'Lin Fei',41:'Zariel',42:'Rayman',
  43:'Dusk',44:'Fait',45:'Thor',46:'Petra',47:'Vector',48:'Volkov',
  49:'Onyx',50:'Jaeyun',51:'Mako',52:'Magyar',53:'Reno',54:'Munin',
  55:'Arcadia',56:'Ezio',57:'Thea',58:'Red Raptor',59:'Loki',60:'Seven',
  61:'Vivi',62:'Imugi',63:'Priya',64:'Tezca',
};

class BitReader {
  constructor(b) { this.data = b; this.bi = -1; this.cb = 0; this.ib = 8; this.len = b.length; }
  readBool() {
    if (this.ib === 8) {
      this.bi++;
      const nb = this.data[this.bi];
      if (nb === undefined) throw new Error('EOF');
      this.cb = nb ^ XOR_KEY[this.bi % XOR_KEY.length];
      this.ib = 0;
    }
    const r = (this.cb & (1 << (7 - this.ib))) !== 0; this.ib++; return r;
  }
  readBits(c) { let r = 0; while (c > 0) { r |= (this.readBool() ? 1 : 0) << (c - 1); c--; } return r; }
  readByte() { return this.readBits(8); }
  readBytes(a) { const b = Buffer.alloc(a); for (let i = 0; i < a; i++) b[i] = this.readByte(); return b; }
  readUShort() { return this.readBits(16); }
  readShort() { const v = this.readUShort(); return v >= 0x8000 ? v - 0x10000 : v; }
  readUInt() { return this.readBits(32); }
  readInt() { const v = this.readUInt(); return v >= 0x80000000 ? v - 0x100000000 : v; }
  readString() { return this.readBytes(this.readUShort()).toString('utf8'); }
}

function parseHeroType(bits) {
  return {
    heroId: bits.readUInt(),
    costumeId: bits.readUInt(),
    stanceIndex: bits.readUInt(),
    weaponSkin2: bits.readUShort(),
    weaponSkin1: bits.readUShort(),
  };
}

function parsePlayerData(bits, heroCount) {
  const d = {
    colorSchemeId: bits.readUInt(),
    spawnBotId: bits.readUInt(),
    companionId: bits.readUInt(),
    emitterId: bits.readUInt(),
    trailEffectId: bits.readUInt(),
    playerThemeId: bits.readUInt(),
    taunts: Array.from({ length: 8 }, () => bits.readUInt()),
    winTauntId: bits.readUShort(),
    loseTauntId: bits.readUShort(),
    ownedTaunts: [],
    avatarId: 0,
    team: 0,
    connectionTime: 0,
    heroTypes: [],
    isBot: false,
    handicapsEnabled: false,
    handicapStockCount: null,
    handicapDamageDoneMult: null,
    handicapDamageTakenMult: null,
  };

  let ti = 0;
  while (bits.readBool()) {
    const bf = bits.readUInt();
    for (let j = 0; j < 32; j++) {
      if ((bf & (1 << j)) !== 0) d.ownedTaunts.push(ti);
      ti++;
    }
  }

  d.avatarId = bits.readUShort();
  d.team = bits.readInt();
  d.connectionTime = bits.readInt();
  d.heroTypes = Array.from({ length: heroCount }, () => parseHeroType(bits));
  d.isBot = bits.readBool();
  d.handicapsEnabled = bits.readBool();

  if (d.handicapsEnabled) {
    d.handicapStockCount = bits.readUInt();
    d.handicapDamageDoneMult = bits.readUInt();
    d.handicapDamageTakenMult = bits.readUInt();
  }

  return d;
}

function parseGameSettings(bits) {
  return {
    flags: bits.readUInt(),
    maxPlayers: bits.readUInt(),
    duration: bits.readUInt(),
    roundDuration: bits.readUInt(),
    startingLives: bits.readUInt(),
    scoringTypeId: bits.readUInt(),
    scoreToWin: bits.readUInt(),
    gameSpeed: bits.readUInt(),
    damageMultiplier: bits.readUInt(),
    levelSetId: bits.readUInt(),
    itemSpawnRuleSetId: bits.readUInt(),
    weaponSpawnRateId: bits.readUInt(),
    gadgetSpawnRateId: bits.readUInt(),
    customGadgetSelection: bits.readUInt(),
    variation: bits.readUInt(),
  };
}

const STATE = { INPUTS: 1, END: 2, HEADER: 3, GAMEDATA: 4, KNOCKOUT_FACES: 5, RESULTS: 6, FACES: 7, INVALID: 8 };

function parseReplay(filePath) {
  const raw = fs.readFileSync(filePath);
  const bits = new BitReader(zlib.inflateSync(raw));

  const version = bits.readUInt();

  const result = {
    version,
    randomSeed: null,
    playlistId: null,
    playlistName: null,
    onlineGame: false,
    settings: null,
    levelId: null,
    heroCount: 0,
    entities: [],
    results: [],
    deaths: [],
    victoryFaces: [],
    inputs: {},
    parseErrors: [],
    statesFound: [],
  };

  let stop = false;
  let sc = 0;

  while (bits.bi < bits.len - 1 && !stop && sc < 200) {
    const state = bits.readBits(4);
    result.statesFound.push(state);
    sc++;

    switch (state) {
      case STATE.HEADER:
        result.randomSeed = bits.readUInt();
        result.playlistId = bits.readUInt();
        result.playlistName = result.playlistId !== 0 ? bits.readString() : null;
        result.onlineGame = bits.readBool();
        break;

      case STATE.GAMEDATA:
        result.settings = parseGameSettings(bits);
        result.levelId = bits.readUInt();
        result.heroCount = bits.readUShort();
        while (bits.readBool()) {
          const entId = bits.readInt();
          const name = bits.readString();
          const playerData = parsePlayerData(bits, result.heroCount);
          result.entities.push({ id: entId, name, data: playerData });
        }
        result.checksum = bits.readUInt();
        break;

      case STATE.RESULTS:
        const length = bits.readUInt();
        const scores = {};
        if (bits.readBool()) {
          while (bits.readBool()) {
            const entId = bits.readBits(5);
            const score = bits.readShort();
            scores[entId] = score;
          }
        }
        const fanfareId = bits.readUInt();
        result.results.push({ length, scores, fanfareId });
        break;

      case STATE.KNOCKOUT_FACES:
        result.deaths = [];
        while (bits.readBool()) {
          const entId = bits.readBits(5);
          const timestamp = bits.readInt();
          result.deaths.push({ entityId: entId, timestamp });
        }
        result.deaths.sort((a, b) => a.timestamp - b.timestamp);
        break;

      case STATE.FACES:
        result.victoryFaces = [];
        while (bits.readBool()) {
          const entId = bits.readBits(5);
          const timestamp = bits.readInt();
          result.victoryFaces.push({ entityId: entId, timestamp });
        }
        break;

      case STATE.INPUTS:
        while (bits.readBool()) {
          const entId = bits.readBits(5);
          const inputCount = bits.readInt();
          if (!result.inputs[entId]) result.inputs[entId] = [];
          for (let i = 0; i < inputCount; i++) {
            const timestamp = bits.readInt();
            const hasState = bits.readBool();
            const state14 = hasState ? bits.readBits(14) : 0;
            result.inputs[entId].push({ timestamp, inputState: state14 });
          }
        }
        break;

      case STATE.END:
        stop = true;
        break;

      default:
        result.parseErrors.push(`Unknown state ${state}`);
        if (state !== 0) {
          try { const sl = bits.readUShort(); for (let i = 0; i < sl; i++) bits.readByte(); }
          catch (e) { stop = true; }
        } else {
          try { bits.readByte(); } catch (e) { stop = true; }
        }
        break;
    }
  }

  return result;
}

function getPlayerInfo(entities) {
  return entities.map(e => ({
    id: e.id,
    name: e.name,
    team: e.data.team,
    isBot: e.data.isBot,
    heroes: e.data.heroTypes.map(h => ({
      heroId: h.heroId,
      name: HEROES[h.heroId] || `Hero_${h.heroId}`,
    })),
  }));
}

function getTeamsAndScores(replay) {
  const teams = {};

  for (const e of replay.entities) {
    const t = e.data.team;
    if (!teams[t]) teams[t] = { team: t, players: [], totalScore: 0 };
    teams[t].players.push(e.name);
  }

  const scores = replay.results[0]?.scores || {};
  for (const e of replay.entities) {
    const t = e.data.team;
    if (teams[t]) {
      teams[t].totalScore += scores[e.id] || 0;
    }
  }

  const allZero = Object.values(teams).every(t => t.totalScore === 0);
  const teamList = Object.values(teams).sort((a, b) => a.totalScore - b.totalScore);
  const winner = (!allZero && teamList.length > 0) ? teamList[0] : null;

  return { teams: teamList, winner, scores };
}

function getDeathCounts(replay) {
  const deaths = {};
  for (const d of replay.deaths) {
    deaths[d.entityId] = (deaths[d.entityId] || 0) + 1;
  }
  return deaths;
}

function extractMatchData(filePath) {
  const replay = parseReplay(filePath);
  const players = getPlayerInfo(replay.entities);
  const { teams, winner, scores } = getTeamsAndScores(replay);
  const koCounts = getDeathCounts(replay);
  const playlistName = (replay.playlistName || '').replace(/^PlaylistType_/, '').replace(/_DisplayName$/, '');

  return {
    filename: filePath.split(/[/\\]/).pop(),
    version: replay.version,
    gamemode: playlistName || 'unknown',
    playerCount: players.length,
    teamCount: teams.length,
    players,
    teams,
    winner: winner ? { team: winner.team, players: winner.players, totalScore: winner.totalScore } : null,
    perEntityScores: scores,
    perEntityDeaths: koCounts,
    settings: replay.settings,
    heroCount: replay.heroCount,
    totalDeaths: replay.deaths.length,
  };
}

module.exports = { parseReplay, extractMatchData, getPlayerInfo, getTeamsAndScores, getDeathCounts, HEROES };
