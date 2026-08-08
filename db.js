// A deliberately simple file-based "database". Good enough for launch traffic,
// and every function here is a natural swap point for a real database later
// (Postgres, MongoDB, etc.) without touching the rest of the app.
const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

function filePath(name) {
  return path.join(DB_DIR, name + '.json');
}

function readJSON(name, fallback) {
  const p = filePath(name);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`Corrupt ${name}.json, resetting to fallback:`, err.message);
    return fallback;
  }
}

function writeJSON(name, data) {
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2));
}

module.exports = {
  getUsers: () => readJSON('users', []),
  saveUsers: (users) => writeJSON('users', users),

  getBookings: () => readJSON('bookings', []),
  saveBookings: (bookings) => writeJSON('bookings', bookings),

  getStats: () => readJSON('stats', { total: 0, count: 0, date: null }),
  saveStats: (stats) => writeJSON('stats', stats),

  getNurses: () => readJSON('nurses', []),
  saveNurses: (nurses) => writeJSON('nurses', nurses),

  getPartners: () => readJSON('partners', []),
  savePartners: (partners) => writeJSON('partners', partners),
};
