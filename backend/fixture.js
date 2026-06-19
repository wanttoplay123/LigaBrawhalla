function generateFixture(playerIds) {
  const n = playerIds.length;
  if (n < 2) return [];

  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);

  const isOdd = n % 2 !== 0;
  const teams = isOdd ? [...shuffled, null] : [...shuffled];
  const m = teams.length;

  const roundsPerHalf = m - 1;
  const totalRounds = roundsPerHalf * 2;

  const fixed = teams[0];
  const rotating = teams.slice(1);
  const rounds = [];

  for (let half = 0; half < 2; half++) {
    for (let r = 0; r < roundsPerHalf; r++) {
      const pairs = [];
      pairs.push([fixed, rotating[r]]);

      for (let i = 1; i < m / 2; i++) {
        const idx1 = (r + i) % (m - 1);
        const idx2 = (r - i + (m - 1) * 2) % (m - 1);
        pairs.push([rotating[idx1], rotating[idx2]]);
      }

      let validPairs = pairs.filter(p => p[0] !== null && p[1] !== null);

      if (half === 0) {
        validPairs = validPairs.map(p =>
          Math.random() > 0.5 ? [p[0], p[1]] : [p[1], p[0]]
        );
      } else {
        validPairs = validPairs.map(p => [p[1], p[0]]);
      }

      const roundNumber = half === 0 ? r + 1 : roundsPerHalf + r + 1;
      rounds.push({ round_number: roundNumber, pairs: validPairs });
    }
  }

  return rounds;
}

module.exports = { generateFixture };
