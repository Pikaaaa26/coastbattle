import { createGame, applyAction } from '../shared/engine';
import { decideDeploy, decideTurn, newAiMemory } from '../shared/ai';
import type { GameSettings } from '../shared/types';
import { TURN_CAP } from '../shared/constants';
import OPTIMIZED_AI_WEIGHTS from '../shared/optimized_weights.json';

function runVisualMatch() {
  const settings: GameSettings = {
    numPlayers: 2,
    mode: 'duel',
    turnCap: TURN_CAP,
    fogOfWar: true,
    mapArchetype: 'bay',
    difficulty: 'hard',
  };
  const players = [
    { id: 'p0', name: 'Commander Azure', isAI: true },
    { id: 'p1', name: 'Commander Crimson', isAI: true },
  ];
  let state = createGame(settings, 999, players);

  // Deploy phase
  let dguard = 0;
  while (state.phase === 'deploy' && dguard++ < 100) {
    const ai = state.currentPlayer;
    const a = decideDeploy(state, ai);
    if (!a) throw new Error('AI could not deploy base');
    const r = applyAction(state, state.players[ai].id, a);
    if (!r.ok) throw new Error('deploy failed: ' + r.error);
    state = r.state;
  }

  // Play phase
  const mem = [newAiMemory(), newAiMemory()];
  let safety = 0;
  while (state.phase === 'playing' && safety++ < 2000) {
    const ai = state.currentPlayer;
    const plan = decideTurn(state, ai, mem[ai], OPTIMIZED_AI_WEIGHTS);
    for (const act of plan) {
      const r = applyAction(state, state.players[ai].id, act);
      if (r.ok) state = r.state;
      if (state.phase === 'ended') break;
    }
  }

  console.log('\n============================================================');
  console.log('            BATTLE SIMULATION LOG (LATEST AI)');
  console.log('============================================================');
  for (const entry of state.log) {
    const prefix = entry.turn > 0 ? `[Turn ${entry.turn}] ` : `[Deploy] `;
    console.log(`${prefix}${entry.text}`);
  }
  console.log('============================================================');
  console.log(`Game ended at turn ${state.turn} with winner: ${state.winner !== null ? state.players[state.winner].name : 'Draw'}`);
  console.log('============================================================\n');
}

runVisualMatch();
