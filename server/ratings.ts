import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface PlayerRating {
  playerId: string;
  name: string;
  rating: number;
  wins: number;
  losses: number;
}

// DATA_DIR lets a Render persistent disk hold the leaderboard; otherwise it's the (ephemeral) repo root.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
const ratingsPath = path.join(dataDir, 'ratings.json');

function loadRatings(): Record<string, PlayerRating> {
  try {
    if (fs.existsSync(ratingsPath)) {
      const raw = fs.readFileSync(ratingsPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Error loading ratings:', e);
  }
  return {};
}

function saveRatings(ratings: Record<string, PlayerRating>) {
  try {
    fs.mkdirSync(path.dirname(ratingsPath), { recursive: true });
    fs.writeFileSync(ratingsPath, JSON.stringify(ratings, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving ratings:', e);
  }
}

export function getLeaderboard(): PlayerRating[] {
  const ratings = loadRatings();
  return Object.values(ratings)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 20); // Top 20
}

export function getPlayerRating(playerId: string, name: string): number {
  const ratings = loadRatings();
  return ratings[playerId]?.rating ?? 1000;
}

export function updateEloForMatch(players: Array<{ playerId: string; name: string; rank: number }>) {
  const ratings = loadRatings();
  
  // Initialize missing players
  for (const p of players) {
    if (!ratings[p.playerId]) {
      ratings[p.playerId] = {
        playerId: p.playerId,
        name: p.name,
        rating: 1000,
        wins: 0,
        losses: 0,
      };
    }
    // Update name if changed
    ratings[p.playerId].name = p.name;
  }

  // Pairwise Elo update
  const K = 32;
  const ratingChanges: Record<string, number> = {};
  for (const p of players) {
    ratingChanges[p.playerId] = 0;
  }

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const p1 = players[i];
      const p2 = players[j];
      
      const r1 = ratings[p1.playerId].rating;
      const r2 = ratings[p2.playerId].rating;
      
      const e1 = 1 / (1 + Math.pow(10, (r2 - r1) / 400));
      const e2 = 1 - e1;
      
      let s1 = 0.5;
      let s2 = 0.5;
      if (p1.rank < p2.rank) {
        s1 = 1;
        s2 = 0;
      } else if (p1.rank > p2.rank) {
        s1 = 0;
        s2 = 1;
      }
      
      ratingChanges[p1.playerId] += K * (s1 - e1);
      ratingChanges[p2.playerId] += K * (s2 - e2);
    }
  }

  // Apply changes and update wins/losses
  for (const p of players) {
    const record = ratings[p.playerId];
    record.rating = Math.max(100, Math.round(record.rating + ratingChanges[p.playerId]));
    if (p.rank === 1) {
      record.wins++;
    } else {
      record.losses++;
    }
  }

  saveRatings(ratings);
}
