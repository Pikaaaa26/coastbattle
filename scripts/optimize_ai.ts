import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { generateMap } from '../shared/map';
import { createGame, applyAction, incomePreview } from '../shared/engine';
import { decideDeploy, decideTurn, newAiMemory, DEFAULT_AI_WEIGHTS, type AiWeights } from '../shared/ai';
import type { GameSettings, GameState, MapArchetype } from '../shared/types';
import { TURN_CAP } from '../shared/constants';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POPULATION_SIZE = 40;
const GENERATIONS = 45;
const GAMES_PER_EVAL = 6;
const MUTATION_RATE = 0.3;
const CROSSOVER_RATE = 0.7;

// Simulated 3-player Free-For-All match
function simulateMatch(
  weights0: AiWeights,
  weights1: AiWeights,
  weights2: AiWeights,
  archetype: MapArchetype,
  seed: number
): { winner: number; turns: number; buildingsDestroyed: number[]; fitnessScores: number[] } {
  const settings: GameSettings = {
    numPlayers: 3,
    mode: 'ffa',
    turnCap: TURN_CAP,
    fogOfWar: true,
    mapArchetype: archetype,
    difficulty: 'hard',
  };
  const players = [
    { id: 'p0', name: 'CPU-0', isAI: true },
    { id: 'p1', name: 'CPU-1', isAI: true },
    { id: 'p2', name: 'CPU-2', isAI: true },
  ];
  let state = createGame(settings, seed, players);

  // Deploy phase
  let dguard = 0;
  while (state.phase === 'deploy' && dguard++ < 150) {
    const ai = state.currentPlayer;
    const a = decideDeploy(state, ai);
    if (!a) throw new Error('AI could not deploy base');
    const r = applyAction(state, state.players[ai].id, a);
    if (!r.ok) throw new Error('deploy failed: ' + r.error);
    state = r.state;
  }

  // Play phase
  const mem = [newAiMemory(), newAiMemory(), newAiMemory()];
  const fitnessScores = [0, 0, 0];
  let safety = 0;
  while (state.phase === 'playing' && safety++ < 3000) {
    const ai = state.currentPlayer;
    
    // 1. Calculate and record turn-start/income/hoarding fitness metrics
    const income = incomePreview(state, ai);
    fitnessScores[ai] += income * 2;
    
    const currentEnergy = state.players[ai].energy;
    if (currentEnergy + income > 6) {
      fitnessScores[ai] += 30;
    }
    
    const target = mem[ai].targetBuilding;
    if (currentEnergy + income > 15 && target !== 'nuclear') {
      fitnessScores[ai] -= 40;
    }

    const currentWeights = ai === 0 ? weights0 : ai === 1 ? weights1 : weights2;
    const plan = decideTurn(state, ai, mem[ai], currentWeights);
    for (const act of plan) {
      const r = applyAction(state, state.players[ai].id, act);
      if (r.ok) {
        // Process events
        for (const e of r.events) {
          if (e.type === 'cellDestroyed' && e.owner !== ai) {
            fitnessScores[ai] += 25;
          } else if (e.type === 'absorbed') {
            fitnessScores[e.owner] += 15;
          } else if (e.type === 'missile' && e.intercepted) {
            const idx = e.to.y * state.map.width + e.to.x;
            const defender = state.map.territory[idx];
            if (defender >= 0 && defender < 3) {
              fitnessScores[defender] += 20;
            }
          }
        }
        state = r.state;
      }
      if (state.phase === 'ended') break;
    }
  }

  const winner = state.winner ?? -1;
  const turns = state.turn;
  
  // Calculate destroyed buildings for each player (buildings belonging to opponents)
  const buildingsDestroyed = [0, 0, 0];
  for (let pIdx = 0; pIdx < 3; pIdx++) {
    const enemyBuildings = state.buildings.filter(b => b.owner !== pIdx);
    buildingsDestroyed[pIdx] = enemyBuildings.filter(b => b.destroyed).length;
  }

  // Add final game bonuses/punishments
  for (let i = 0; i < 3; i++) {
    if (winner === i) {
      fitnessScores[i] += 1000;
    }
    fitnessScores[i] -= turns * 2;
  }

  return { winner, turns, buildingsDestroyed, fitnessScores };
}

// Evaluate fitness of a chromosome by playing against opponents of a specific generation's weights
function evaluateChromosome(
  c: AiWeights,
  opponentWeights: AiWeights,
  genIndex: number
): { fitness: number; winRate: number } {
  let totalScore = 0;
  let wins = 0;
  const archetypes: MapArchetype[] = ['twin', 'atolls', 'ring', 'bay', 'archipelago', 'twin'];
  
  for (let i = 0; i < archetypes.length; i++) {
    const arch = archetypes[i];
    const seed = 30000 + genIndex * 1000 + i;
    
    // Rotate positions to eliminate player order bias in FFA
    const chromIdx = i % 3;
    const w0 = chromIdx === 0 ? c : opponentWeights;
    const w1 = chromIdx === 1 ? c : opponentWeights;
    const w2 = chromIdx === 2 ? c : opponentWeights;
    
    const result = simulateMatch(w0, w1, w2, arch, seed);
    const won = result.winner === chromIdx;
    if (won) wins++;
    
    const score = result.fitnessScores[chromIdx];
    totalScore += score;
  }
  
  return {
    fitness: totalScore / GAMES_PER_EVAL,
    winRate: wins / GAMES_PER_EVAL,
  };
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function randomJitter(val: number, range: number, min = 0, max = 200): number {
  const change = (Math.random() - 0.5) * range;
  return clamp(Math.round(val + change), min, max);
}

function floatJitter(val: number, range: number, min = -50, max = 50): number {
  const change = (Math.random() - 0.5) * range;
  return Number(clamp(val + change, min, max).toFixed(4));
}

function mutateChromosome(c: AiWeights): AiWeights {
  return {
    baseScanVal: randomJitter(c.baseScanVal, 10, 0, 50),
    parityBonus: randomJitter(c.parityBonus, 6, -10, 30),
    adjacentHitBonus: randomJitter(c.adjacentHitBonus, 15, 0, 80),
    hitCellVal: randomJitter(c.hitCellVal, 30, 10, 250),
    knownBaseVal: randomJitter(c.knownBaseVal, 40, 20, 250),
    knownEcoVal: randomJitter(c.knownEcoVal, 30, 20, 200),
    knownRadarVal: randomJitter(c.knownRadarVal, 30, 10, 200),
    energyReserve: randomJitter(c.energyReserve, 4, 0, 20),

    wBase_economy: floatJitter(c.wBase_economy, 5, -50, 50),
    wEnergy_economy: floatJitter(c.wEnergy_economy, 0.4, -5, 5),
    wEnergyGen_economy: floatJitter(c.wEnergyGen_economy, 0.4, -5, 5),
    wBaseHp_economy: floatJitter(c.wBaseHp_economy, 0.4, -5, 5),

    wBase_tech: floatJitter(c.wBase_tech, 5, -50, 50),
    wEnergy_tech: floatJitter(c.wEnergy_tech, 0.4, -5, 5),
    wEnergyGen_tech: floatJitter(c.wEnergyGen_tech, 0.4, -5, 5),
    wBaseHp_tech: floatJitter(c.wBaseHp_tech, 0.4, -5, 5),

    wBase_defense: floatJitter(c.wBase_defense, 5, -50, 50),
    wEnergy_defense: floatJitter(c.wEnergy_defense, 0.4, -5, 5),
    wEnergyGen_defense: floatJitter(c.wEnergyGen_defense, 0.4, -5, 5),
    wBaseHp_defense: floatJitter(c.wBaseHp_defense, 0.4, -5, 5),

    wBase_military: floatJitter(c.wBase_military, 5, -50, 50),
    wEnergy_military: floatJitter(c.wEnergy_military, 0.4, -5, 5),
    wEnergyGen_military: floatJitter(c.wEnergyGen_military, 0.4, -5, 5),
    wBaseHp_military: floatJitter(c.wBaseHp_military, 0.4, -5, 5),
  };
}

function crossover(p1: AiWeights, p2: AiWeights): AiWeights {
  const blend = (v1: number, v2: number) => {
    const r = Math.random();
    if (r < 0.4) return v1;
    if (r < 0.8) return v2;
    return Math.round((v1 + v2) / 2);
  };
  const blendFloat = (v1: number, v2: number) => {
    const r = Math.random();
    if (r < 0.4) return v1;
    if (r < 0.8) return v2;
    return Number(((v1 + v2) / 2).toFixed(4));
  };
  return {
    baseScanVal: blend(p1.baseScanVal, p2.baseScanVal),
    parityBonus: blend(p1.parityBonus, p2.parityBonus),
    adjacentHitBonus: blend(p1.adjacentHitBonus, p2.adjacentHitBonus),
    hitCellVal: blend(p1.hitCellVal, p2.hitCellVal),
    knownBaseVal: blend(p1.knownBaseVal, p2.knownBaseVal),
    knownEcoVal: blend(p1.knownEcoVal, p2.knownEcoVal),
    knownRadarVal: blend(p1.knownRadarVal, p2.knownRadarVal),
    energyReserve: blend(p1.energyReserve, p2.energyReserve),

    wBase_economy: blendFloat(p1.wBase_economy, p2.wBase_economy),
    wEnergy_economy: blendFloat(p1.wEnergy_economy, p2.wEnergy_economy),
    wEnergyGen_economy: blendFloat(p1.wEnergyGen_economy, p2.wEnergyGen_economy),
    wBaseHp_economy: blendFloat(p1.wBaseHp_economy, p2.wBaseHp_economy),

    wBase_tech: blendFloat(p1.wBase_tech, p2.wBase_tech),
    wEnergy_tech: blendFloat(p1.wEnergy_tech, p2.wEnergy_tech),
    wEnergyGen_tech: blendFloat(p1.wEnergyGen_tech, p2.wEnergyGen_tech),
    wBaseHp_tech: blendFloat(p1.wBaseHp_tech, p2.wBaseHp_tech),

    wBase_defense: blendFloat(p1.wBase_defense, p2.wBase_defense),
    wEnergy_defense: blendFloat(p1.wEnergy_defense, p2.wEnergy_defense),
    wEnergyGen_defense: blendFloat(p1.wEnergyGen_defense, p2.wEnergyGen_defense),
    wBaseHp_defense: blendFloat(p1.wBaseHp_defense, p2.wBaseHp_defense),

    wBase_military: blendFloat(p1.wBase_military, p2.wBase_military),
    wEnergy_military: blendFloat(p1.wEnergy_military, p2.wEnergy_military),
    wEnergyGen_military: blendFloat(p1.wEnergyGen_military, p2.wEnergyGen_military),
    wBaseHp_military: blendFloat(p1.wBaseHp_military, p2.wBaseHp_military),
  };
}

function runOptimization() {
  console.log('--- STARTING 3-PLAYER CO-EVOLUTION AI OPTIMIZATION ---');
  console.log(`Population Size: ${POPULATION_SIZE}`);
  console.log(`Generations: ${GENERATIONS}`);
  console.log(`Matches per generation: ${POPULATION_SIZE * GAMES_PER_EVAL}`);
  console.log('------------------------------------------------------------');

  // Maintain co-evolution history
  const historyBestWeights: AiWeights[] = [];

  // Initialize population
  let population: AiWeights[] = [];
  population.push({ ...DEFAULT_AI_WEIGHTS });
  for (let i = 1; i < POPULATION_SIZE; i++) {
    population.push(mutateChromosome(DEFAULT_AI_WEIGHTS));
  }

  let bestChromosome: AiWeights = { ...DEFAULT_AI_WEIGHTS };
  let bestFitness = -Infinity;
  let bestWinRate = 0.0;

  for (let gen = 0; gen < GENERATIONS; gen++) {
    // Determine opponent weights (2 generations below, or default if G < 2)
    const opponentWeights = gen >= 2 ? historyBestWeights[gen - 2] : DEFAULT_AI_WEIGHTS;
    
    console.log(`\nEvaluating Generation ${gen + 1}/${GENERATIONS}...`);
    if (gen >= 2) {
      console.log(`Opponent AI Level: Evolved weights from Gen ${gen - 1}`);
    } else {
      console.log(`Opponent AI Level: Baseline DEFAULT_AI_WEIGHTS`);
    }
    
    // Evaluate population
    const evaluated = population.map((chrom) => {
      const { fitness, winRate } = evaluateChromosome(chrom, opponentWeights, gen);
      return { chrom, fitness, winRate };
    });

    // Sort by fitness descending
    evaluated.sort((a, b) => b.fitness - a.fitness);

    const genBest = evaluated[0];
    console.log(`Generation ${gen + 1} Best Fitness: ${genBest.fitness.toFixed(2)} (Win Rate vs Opponent AI: ${(genBest.winRate * 100).toFixed(1)}%)`);
    console.log(`Weights: ${JSON.stringify(genBest.chrom)}`);

    // Record best weights of this generation into history
    historyBestWeights.push({ ...genBest.chrom });

    if (genBest.fitness > bestFitness) {
      bestFitness = genBest.fitness;
      bestChromosome = { ...genBest.chrom };
      bestWinRate = genBest.winRate;

      // Save intermediate optimized weights to file at end of each generation
      const destPath = path.join(__dirname, '..', 'shared', 'optimized_weights.json');
      fs.writeFileSync(destPath, JSON.stringify(bestChromosome, null, 2), 'utf-8');
      console.log(`[Resilience] Saved best evolved weights to date (Gen ${gen + 1}) to optimized_weights.json`);
    }

    // Select Elites (top 25% -> 10 survivors)
    const elites = evaluated.slice(0, 10).map((e) => e.chrom);

    // Reproduce Offspring (30 offspring)
    const nextPopulation: AiWeights[] = [...elites];
    
    while (nextPopulation.length < POPULATION_SIZE) {
      const parent1 = elites[Math.floor(Math.random() * elites.length)];
      const parent2 = elites[Math.floor(Math.random() * elites.length)];

      let child = crossover(parent1, parent2);

      if (Math.random() < MUTATION_RATE) {
        child = mutateChromosome(child);
      }
      nextPopulation.push(child);
    }

    population = nextPopulation;
  }

  console.log('\n------------------------------------------------------------');
  console.log('CO-EVOLUTION OPTIMIZATION COMPLETE!');
  console.log(`Best Overall Fitness achieved: ${bestFitness.toFixed(2)}`);
  console.log('Final Evolved AI Weights:');
  console.log(JSON.stringify(bestChromosome, null, 2));
  console.log('------------------------------------------------------------');

  // Save optimized weights to file
  const destPath = path.join(__dirname, '..', 'shared', 'optimized_weights.json');
  fs.writeFileSync(destPath, JSON.stringify(bestChromosome, null, 2), 'utf-8');
  console.log(`Saved optimized weights to ${destPath}`);
}

runOptimization();
