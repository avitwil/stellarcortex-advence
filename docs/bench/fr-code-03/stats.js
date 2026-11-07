// Median of a list of numbers (the list is not changed).
exports.median = (xs) => {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort();
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
