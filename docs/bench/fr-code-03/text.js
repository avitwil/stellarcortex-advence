// Turns a title into a URL slug: lower case, words joined by single dashes.
exports.slugify = (s) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '');
