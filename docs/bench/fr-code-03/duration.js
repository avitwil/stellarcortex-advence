// Parses durations such as "1h30m", "45s" or "2h" into seconds.
exports.parseDuration = (text) => {
  const units = { h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const [, n, u] of text.matchAll(/(\d+)([hms])/g)) total += Number(n) * units[u];
  return total || null;
};
