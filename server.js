const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static('public'));

// ======================== CONSTANTS ========================

const PORT = 3000;
const GRID_SIZE = 4;
const ROUND_DURATION = 60;
const TOTAL_ROUNDS = 1;
const PROBLEMS_PER_ROUND = 40; // max tasks including distractors and coins

const ROLES = ['water', 'sun', 'seed', 'animal'];
const ROLE_INFO = {
  water:  { name: 'Water Keeper',    icon: '\u{1F4A7}', color: '#2196F3', desc: 'Water dry plants. Pick the right amount!' },
  sun:    { name: 'Sun Guide',       icon: '\u{2600}\u{FE0F}', color: '#FF9800', desc: 'Give sun to dark plants. More sun = more suns!' },
  seed:   { name: 'Seed Planter',    icon: '\u{1F331}', color: '#4CAF50', desc: 'Plant seeds in empty soil. Pick the right amount!' },
  animal: { name: 'Animal Guardian', icon: '\u{1F6E1}\u{FE0F}', color: '#795548', desc: 'Shoo animals away. Pick the right amount!' }
};

const PLANT_TYPES = [
  { type: 'rose', emoji: '\u{1F339}' },
  { type: 'sunflower', emoji: '\u{1F33B}' },
  { type: 'tulip', emoji: '\u{1F337}' },
  { type: 'daisy', emoji: '\u{1F33C}' },
  { type: 'hibiscus', emoji: '\u{1F33A}' },
  { type: 'cherry_blossom', emoji: '\u{1F338}' }
];

const STAGE_EMOJI = { seed: '\u{1F7EB}', sprout: '\u{1F331}', growing: '\u{1F33F}', bloom: null, wilting: '\u{1F940}' };
const ANIMAL_TYPES = ['rabbit', 'bird', 'snail'];
const ANIMAL_EMOJI = { rabbit: '\u{1F430}', bird: '\u{1F426}', snail: '\u{1F40C}' };
const ROW_LABELS = ['A', 'B', 'C', 'D'];

// Action button configs per role
const ACTION_BUTTONS = {
  water:  ['\u{1F4A7}', '\u{1F4A7}\u{1F4A7}', '\u{1F4A7}\u{1F4A7}\u{1F4A7}'],
  sun:    ['\u{2600}\u{FE0F}', '\u{2600}\u{FE0F}\u{2600}\u{FE0F}', '\u{2600}\u{FE0F}\u{2600}\u{FE0F}\u{2600}\u{FE0F}'],
  seed:   ['\u{1F331}', '\u{1F331}\u{1F331}', '\u{1F331}\u{1F331}\u{1F331}'],
  animal: ['\u{1F43E}', '\u{1F43E}\u{1F43E}', '\u{1F43E}\u{1F43E}\u{1F43E}']
};
const ACTION_LABELS = ['A little', 'Some', 'A lot'];

// ======================== STATE ========================

const rooms = new Map();

// ======================== UTILITIES ========================

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = ''; for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]; } while (rooms.has(code));
  return code;
}
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const n of Object.keys(ifaces)) for (const i of ifaces[n]) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

// ======================== GARDEN ========================

function createGarden() {
  const grid = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    grid[r] = [];
    for (let c = 0; c < GRID_SIZE; c++) {
      const hasPlant = Math.random() > 0.25;
      const pt = pick(PLANT_TYPES);
      grid[r][c] = {
        row: r, col: c,
        plant: hasPlant ? { type: pt.type, emoji: pt.emoji, stage: pick(['sprout', 'growing', 'bloom']) } : null,
        moisture: randInt(45, 65),
        sunlight: randInt(40, 60),
        animal: null,
        shaded: false
      };
    }
  }
  return grid;
}

function advancePlants(garden) {
  const order = ['seed', 'sprout', 'growing', 'bloom'];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const p = garden[r][c];
      if (p.plant && p.plant.stage !== 'wilting') {
        const idx = order.indexOf(p.plant.stage);
        if (idx < order.length - 1 && Math.random() > 0.4) p.plant.stage = order[idx + 1];
      }
      p.shaded = false;
      p.moisture = Math.max(25, Math.min(75, p.moisture + randInt(-5, 5)));
      p.sunlight = Math.max(25, Math.min(70, p.sunlight + randInt(-5, 5)));
    }
  }
}

function getPlotEmoji(plot) {
  if (!plot.plant) return '';
  if (plot.plant.stage === 'bloom') return plot.plant.emoji;
  return STAGE_EMOJI[plot.plant.stage] || '';
}

function serializeGarden(garden) {
  return garden.map(row => row.map(p => ({
    row: p.row, col: p.col, plant: p.plant,
    moisture: p.moisture, sunlight: p.sunlight,
    animal: p.animal, shaded: p.shaded,
    displayEmoji: getPlotEmoji(p)
  })));
}

// ======================== PROBLEM & CLUE GENERATION ========================

function makeProblemsForPlayer(game, player, usedByRole) {
  const problems = [];
  const role = player.role;
  const used = usedByRole[role];

  // Generate a mix: ~22 real, ~10 distractors, ~8 gold coins = 40 total
  const realCount = 22;
  const distractorCount = 10;
  const coinCount = 8;

  // 1. Real problems
  for (let i = 0; i < realCount; i++) {
    let plot;
    if (role === 'seed') {
      plot = findAvailablePlot(game.garden, p => !p.plant && !used.has(p.row + ',' + p.col));
      if (!plot) plot = findAvailablePlot(game.garden, p => !p.plant);
    } else {
      plot = findAvailablePlot(game.garden, p => p.plant && !used.has(p.row + ',' + p.col));
      if (!plot) plot = findAvailablePlot(game.garden, p => p.plant);
    }
    if (!plot) { plot = findAvailablePlot(game.garden, () => true); }
    if (!plot) break;

    used.add(plot.row + ',' + plot.col);
    const level = randInt(1, 3);
    const clue = makeClue(role, level, game.round);
    applyProblemToGarden(plot, role, level);

    problems.push({
      type: 'real',
      plotRow: plot.row, plotCol: plot.col,
      plotLabel: ROW_LABELS[plot.row] + (plot.col + 1),
      plotEmoji: getPlotEmoji(plot),
      level,
      clueText: clue.text,
      clueHint: clue.hint,
      solved: false, result: null
    });
  }

  // 2. Distractors (look like real tasks but the plot is fine — any action is wrong)
  for (let i = 0; i < distractorCount; i++) {
    const plot = findAvailablePlot(game.garden, () => true);
    if (!plot) break;
    const dClue = makeDistractorClue(role, game.round);
    problems.push({
      type: 'distractor',
      plotRow: plot.row, plotCol: plot.col,
      plotLabel: ROW_LABELS[plot.row] + (plot.col + 1),
      plotEmoji: getPlotEmoji(plot),
      level: 0, // 0 = no correct answer, skip is correct
      clueText: dClue.text,
      clueHint: dClue.hint,
      solved: false, result: null
    });
  }

  // 3. Gold coin bonus tasks
  for (let i = 0; i < coinCount; i++) {
    problems.push({
      type: 'coin',
      plotRow: -1, plotCol: -1,
      plotLabel: '',
      plotEmoji: '\u{1FA99}',
      level: 0,
      clueText: '',
      clueHint: '',
      solved: false, result: null
    });
  }

  // Shuffle all problems together
  for (let i = problems.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [problems[i], problems[j]] = [problems[j], problems[i]];
  }

  return problems;
}

function makeDistractorClue(role, round) {
  const distractors = {
    water: [
      { text: 'This soil looks fine!', hint: '\u{2705}' },
      { text: 'Moist enough already', hint: '\u{1F44C}' },
      { text: 'No water needed here', hint: '\u{274C}' },
      { text: 'Already watered today', hint: '\u{2705}' },
      { text: 'Soil is nice and damp', hint: '\u{1F44D}' }
    ],
    sun: [
      { text: 'Plenty of sun already!', hint: '\u{2705}' },
      { text: 'Perfect sunlight here!', hint: '\u{1F44C}' },
      { text: 'No extra sun needed', hint: '\u{274C}' },
      { text: 'Light level is fine', hint: '\u{2705}' },
      { text: 'Bright and happy!', hint: '\u{1F44D}' }
    ],
    seed: [
      { text: 'Already growing here!', hint: '\u{2705}' },
      { text: 'No room for seeds', hint: '\u{274C}' },
      { text: 'This spot is taken', hint: '\u{1F44C}' },
      { text: 'Fully planted already', hint: '\u{2705}' },
      { text: 'Too crowded to plant', hint: '\u{1F44D}' }
    ],
    animal: [
      { text: 'No animals here!', hint: '\u{2705}' },
      { text: 'All clear, no pests', hint: '\u{1F44C}' },
      { text: 'This area is safe', hint: '\u{274C}' },
      { text: 'Nothing to shoo away', hint: '\u{2705}' },
      { text: 'Peaceful and quiet', hint: '\u{1F44D}' }
    ]
  };
  return pick(distractors[role] || distractors.water);
}

function findAvailablePlot(garden, filter) {
  const candidates = [];
  for (let r = 0; r < GRID_SIZE; r++)
    for (let c = 0; c < GRID_SIZE; c++)
      if (filter(garden[r][c])) candidates.push(garden[r][c]);
  return candidates.length > 0 ? pick(candidates) : null;
}

function applyProblemToGarden(plot, role, level) {
  switch (role) {
    case 'water': plot.moisture = [30, 18, 5][level - 1]; break;
    case 'sun': plot.sunlight = [30, 15, 5][level - 1]; break; // too dark, needs more sun
    case 'animal':
      plot.animal = pick(ANIMAL_TYPES);
      break;
    // seed: plot already empty, no change needed
  }
}

function makeClue(role, level, round) {
  if (round <= 2) {
    // EASY: direct words + visual hint
    const texts = {
      water:  ['A bit dry', 'Quite dry', 'Very dry!'],
      sun:    ['A bit dark', 'Quite dark', 'Very dark!'],
      seed:   ['Small spot', 'Some space', 'Big space!'],
      animal: ['Far away', 'Getting close', 'Very close!']
    };
    return { text: texts[role][level - 1], hint: ACTION_BUTTONS[role][level - 1] };
  } else if (round <= 4) {
    // MEDIUM: descriptive, visual hint removed
    const texts = {
      water: ['Top soil is a little dry', 'Soil is dry halfway down', 'Soil is cracking!'],
      sun:   ['Leaves look a little pale', 'Leaves are drooping without sun', 'No sunlight at all!'],
      seed:  ['A tiny gap here', 'A nice open spot', 'A big empty area!'],
      animal:['Something watching from far', 'An animal walking over', 'An animal is right here!']
    };
    return { text: texts[role][level - 1], hint: '' };
  } else {
    // ROUND 5: a bit more puzzle-like
    const texts = {
      water: ['One small crack in the soil', 'A few cracks in the soil', 'The ground is full of cracks!'],
      sun:   ['Just a ray of light needed', 'Needs more sunshine', 'Needs full bright sun!'],
      seed:  ['One little hole to fill', 'A couple of holes to fill', 'Many holes to fill!'],
      animal:['I hear a small rustle', 'I can see it coming', 'It is eating the plants!']
    };
    return { text: texts[role][level - 1], hint: '' };
  }
}

// ======================== ACTION PROCESSING ========================

function processAction(game, socketId, chosenLevel) {
  const player = game.players.get(socketId);
  if (!player || !player.problems) return null;
  if (player.problemIdx >= player.problems.length) return null;

  const prob = player.problems[player.problemIdx];
  if (prob.solved) return null;

  let result, msg, points;

  if (prob.type === 'coin') {
    // Gold coin — chosenLevel 0 means "tapped the coin"
    result = 'coin'; points = 20;
    msg = pick(['Gold!', 'Coin!', 'Bonus!', 'Cha-ching!']);
    game.score += points; player.score += points; player.coins++;
    game.coins = (game.coins || 0) + 1;
    prob.solved = true; prob.result = 'coin';
    player.problemIdx++;
    return { result, msg, correctLevel: 0, chosenLevel: 0, points, coins: game.coins };
  }

  if (prob.type === 'distractor') {
    if (chosenLevel === 0) {
      // Player correctly skipped — well done!
      result = 'skipped'; points = 10;
      msg = pick(['Smart!', 'Good eye!', 'Correct skip!', 'Sharp!']);
      game.score += points; player.score += points;
    } else {
      // Player acted on a distractor — penalty
      result = 'tricked'; points = 0;
      msg = pick(['Tricked!', 'It was fine!', 'No need!', 'Careful!']);
      game.health = Math.max(0, game.health - 2);
    }
    prob.solved = true; prob.result = result;
    player.problemIdx++;
    return { result, msg, correctLevel: 0, chosenLevel, points };
  }

  // Real problem
  const diff = Math.abs(chosenLevel - prob.level);

  if (chosenLevel === 0) {
    result = 'wrong'; points = 0;
    msg = pick(['It needed help!', 'Don\'t skip this!', 'Oops!']);
    game.health = Math.max(0, game.health - 2);
  } else if (diff === 0) {
    result = 'perfect'; points = 15;
    msg = pick(['Perfect!', 'Spot on!', 'Just right!', 'Yes!']);
    game.health = Math.min(100, game.health + 2);
    player.perfect++;
  } else if (diff === 1) {
    result = 'close'; points = 5;
    msg = pick(['Almost!', 'Close!', 'Nearly right!']);
  } else {
    result = 'wrong'; points = 0;
    msg = pick(['Not quite!', 'Try next time!', 'Oops!']);
    game.health = Math.max(0, game.health - 2);
  }

  game.score += points; player.score += points;
  prob.solved = true;
  prob.result = result;

  // Apply action to garden
  if (chosenLevel > 0 && prob.plotRow >= 0) {
    const plot = game.garden[prob.plotRow][prob.plotCol];
    applyActionToGarden(plot, player.role, chosenLevel, prob.level);
  }

  player.problemIdx++;
  return { result, msg, correctLevel: prob.level, chosenLevel, points };
}

function applyActionToGarden(plot, role, chosen, correct) {
  const effectiveness = chosen === correct ? 1 : (Math.abs(chosen - correct) === 1 ? 0.6 : 0.2);
  switch (role) {
    case 'water':
      plot.moisture = Math.min(70, plot.moisture + Math.round(30 * effectiveness));
      if (plot.plant && plot.plant.stage === 'wilting' && effectiveness >= 0.6) plot.plant.stage = 'growing';
      break;
    case 'sun':
      plot.sunlight = Math.min(70, plot.sunlight + Math.round(35 * effectiveness));
      if (plot.plant && plot.plant.stage === 'wilting' && effectiveness >= 0.6) plot.plant.stage = 'growing';
      break;
    case 'animal':
      if (effectiveness >= 0.6) plot.animal = null;
      break;
    case 'seed':
      if (effectiveness >= 0.6 && !plot.plant) {
        const pt = pick(PLANT_TYPES);
        const stages = ['seed', 'seed', 'sprout'];
        plot.plant = { type: pt.type, emoji: pt.emoji, stage: stages[chosen - 1] || 'seed' };
        plot.moisture = 50; plot.sunlight = 50;
      }
      break;
  }
}

// ======================== GAME FLOW ========================

function startRound(game) {
  game.round++;
  game.roundTimeLeft = ROUND_DURATION;
  if (game.round > 1) advancePlants(game.garden);

  // Generate problems for each player
  const usedByRole = { water: new Set(), sun: new Set(), seed: new Set(), animal: new Set() };
  for (const [sid, player] of game.players) {
    player.problems = makeProblemsForPlayer(game, player, usedByRole);
    player.problemIdx = 0;
  }

  const gardenData = serializeGarden(game.garden);

  // Notify TV
  io.to(game.tvSocketId).emit('round-start', {
    round: game.round, totalRounds: TOTAL_ROUNDS,
    garden: gardenData, health: game.health, score: game.score,
    duration: ROUND_DURATION,
    assignments: getAssignments(game)
  });

  // Send first problem to each player
  for (const [sid] of game.players) {
    sendProblemToPlayer(game, sid);
  }

  // Timer + leaderboard every 20 seconds
  game.roundTimer = setInterval(() => {
    game.roundTimeLeft--;
    if (game.roundTimeLeft <= 0) {
      endRound(game);
    } else if (game.roundTimeLeft % 20 === 0) {
      // Broadcast leaderboard every 20 seconds
      const board = getLeaderboard(game);
      io.to(game.tvSocketId).emit('leaderboard', { board, timeLeft: game.roundTimeLeft });
      for (const [sid] of game.players) {
        io.to(sid).emit('leaderboard', { board, timeLeft: game.roundTimeLeft });
      }
    }
  }, 1000);
}

function sendProblemToPlayer(game, sid) {
  const player = game.players.get(sid);
  if (!player) return;

  if (player.problemIdx >= player.problems.length) {
    const perfect = player.problems.filter(p => p.result === 'perfect').length;
    const coins = player.problems.filter(p => p.result === 'coin').length;
    const skipped = player.problems.filter(p => p.result === 'skipped').length;
    io.to(sid).emit('all-done', {
      perfect, coins, skipped, total: player.problems.length,
      score: game.score, health: game.health
    });
    return;
  }

  const prob = player.problems[player.problemIdx];
  io.to(sid).emit('problem', {
    problemType: prob.type, // 'real', 'distractor', or 'coin'
    plotLabel: prob.plotLabel,
    plotEmoji: prob.plotEmoji,
    plotRow: prob.plotRow, plotCol: prob.plotCol,
    clueText: prob.clueText,
    clueHint: prob.clueHint,
    problemNum: player.problemIdx + 1,
    totalProblems: player.problems.length,
    round: game.round, totalRounds: TOTAL_ROUNDS,
    score: game.score, health: game.health,
    coins: game.coins || 0,
    buttons: ACTION_BUTTONS[player.role],
    labels: ACTION_LABELS
  });
}

function getLeaderboard(game) {
  const board = Array.from(game.players.values()).map(p => ({
    name: p.name,
    role: p.role,
    roleIcon: ROLE_INFO[p.role].icon,
    roleColor: ROLE_INFO[p.role].color,
    score: p.score,
    coins: p.coins,
    perfect: p.perfect,
    done: p.problems ? p.problemIdx : 0,
    total: p.problems ? p.problems.length : 0
  }));
  board.sort((a, b) => b.score - a.score);
  board.forEach((p, i) => { p.rank = i + 1; });
  return board;
}

function getEncouragingMessage(player, rank, total) {
  const pct = player.problems ? Math.round((player.perfect / Math.max(1, player.problemIdx)) * 100) : 0;

  if (rank === 1) return pick([
    'Amazing! You are the garden champion! \u{1F451}',
    'Number one! The garden loves you! \u{1F31F}',
    'Top player! You are a garden hero! \u{1F3C6}'
  ]);
  if (rank === 2) return pick([
    'Great job! You are almost at the top! \u{1F4AA}',
    'So close to first! Keep going! \u{1F31F}',
    'Second place! That is wonderful! \u{1F389}'
  ]);
  if (rank === 3) return pick([
    'Well done! Top three! \u{1F44F}',
    'Third place is great! \u{1F331}',
    'You made the top three! Nice work! \u{2728}'
  ]);
  if (pct >= 70) return pick([
    'So many perfect answers! You are great! \u{1F33B}',
    'Your skills are blooming! Well played! \u{1F338}',
    'The garden thanks you! Great accuracy! \u{1F33F}'
  ]);
  if (player.coins >= 3) return pick([
    'Great coin collector! You found so many! \u{1FA99}',
    'Your eyes are sharp! So many coins! \u{1F4B0}',
    'Treasure hunter! You are amazing! \u{2728}'
  ]);
  return pick([
    'Great effort! Every action helps the garden! \u{1F33F}',
    'You did your best and that is wonderful! \u{1F31F}',
    'Thank you for helping! The garden is happier! \u{1F338}',
    'Well played! Every little bit counts! \u{1F44F}',
    'You are a true garden friend! \u{1F33B}',
    'Keep it up! You are learning fast! \u{1F4AA}'
  ]);
}

function getAssignments(game) {
  const list = [];
  for (const [sid, player] of game.players) {
    if (!player.problems) continue;
    for (let i = 0; i < player.problems.length; i++) {
      const prob = player.problems[i];
      list.push({
        playerName: player.name,
        roleIcon: ROLE_INFO[player.role].icon,
        roleColor: ROLE_INFO[player.role].color,
        plotRow: prob.plotRow, plotCol: prob.plotCol,
        solved: prob.solved,
        active: i === player.problemIdx
      });
    }
  }
  return list;
}

function endRound(game) {
  if (game.roundTimer) { clearInterval(game.roundTimer); game.roundTimer = null; }

  // Penalize unsolved problems
  for (const [, player] of game.players) {
    if (!player.problems) continue;
    for (const prob of player.problems) {
      if (!prob.solved) {
        game.health = Math.max(0, game.health - 4);
        if (prob.plotRow >= 0) {
          const plot = game.garden[prob.plotRow][prob.plotCol];
          if (plot.plant && prob.level >= 2) plot.plant.stage = 'wilting';
        }
      }
    }
  }

  // Go straight to game over celebration
  endGame(game);
}

function endGame(game) {
  game.state = 'gameOver';
  if (game.roundTimer) { clearInterval(game.roundTimer); game.roundTimer = null; }

  let rating;
  if (game.score >= 400)      rating = { name: 'Paradise Garden',    emoji: '\u{1F308}', stars: 5 };
  else if (game.score >= 280) rating = { name: 'Beautiful Blooms',   emoji: '\u{1F338}', stars: 4 };
  else if (game.score >= 170) rating = { name: 'Growing Garden',     emoji: '\u{1F33F}', stars: 3 };
  else if (game.score >= 80)  rating = { name: 'Struggling Sprouts', emoji: '\u{1F331}', stars: 2 };
  else                        rating = { name: 'Dry Desert',         emoji: '\u{1F3DC}\u{FE0F}', stars: 1 };

  const board = getLeaderboard(game);
  const win = game.health > 50;

  // Send TV final results with leaderboard
  io.to(game.tvSocketId).emit('game-over', {
    score: game.score, health: game.health, rating,
    coins: game.coins || 0, win,
    garden: serializeGarden(game.garden),
    leaderboard: board,
    message: 'You are awesome!'
  });

  // Send each player their personal result
  for (const [sid, player] of game.players) {
    const rank = board.findIndex(b => b.name === player.name) + 1;
    io.to(sid).emit('game-over', {
      score: game.score, health: game.health, rating,
      coins: game.coins || 0, win,
      myScore: player.score,
      myRank: rank,
      totalPlayers: game.players.size,
      myPerfect: player.perfect,
      myCoins: player.coins,
      encouragement: getEncouragingMessage(player, rank, game.players.size),
      leaderboard: board,
      message: 'You are awesome!'
    });
  }
}

// ======================== BOT AUTO-PLAY ========================

function scheduleBotActions(game) {
  const bots = Array.from(game.players.values()).filter(p => p.isBot);
  if (!bots.length) return;

  bots.forEach(bot => {
    function doNextAction() {
      if (game.state !== 'playing') return;
      if (bot.problemIdx >= bot.problems.length) return;
      const prob = bot.problems[bot.problemIdx];
      let level;
      if (prob.type === 'coin') {
        level = 1;
      } else if (prob.type === 'distractor') {
        // Bots skip distractors 70% of the time
        level = Math.random() < 0.7 ? 0 : randInt(1, 3);
      } else {
        // Bots pick correct answer 60% of the time, off-by-one 30%, wrong 10%
        const r = Math.random();
        if (r < 0.6) level = prob.level;
        else if (r < 0.9) level = Math.max(1, Math.min(3, prob.level + (Math.random() < 0.5 ? 1 : -1)));
        else level = randInt(1, 3);
      }
      const result = processAction(game, bot.id, level);
      if (result) {
        io.to(game.tvSocketId).emit('garden-update', {
          garden: serializeGarden(game.garden),
          health: game.health, score: game.score,
          assignments: getAssignments(game),
          leaderboard: getLeaderboard(game),
          action: {
            playerName: bot.name,
            roleIcon: ROLE_INFO[bot.role].icon,
            result: result.result,
            plotRow: prob.plotRow,
            plotCol: prob.plotCol
          }
        });
      }
      const delay = 1200 + Math.random() * 1200;
      if (bot.problemIdx < bot.problems.length && game.state === 'playing') {
        setTimeout(doNextAction, delay);
      }
    }
    // Stagger bot start times so they don't all fire at once
    setTimeout(doNextAction, 1000 + Math.random() * 2000);
  });
}

// ======================== SOCKET HANDLERS ========================

io.on('connection', (socket) => {

  socket.on('create-room', async () => {
    const code = generateRoomCode();
    const base = process.env.FLY_APP_NAME
      ? `https://${process.env.FLY_APP_NAME}.fly.dev`
      : `http://${getLocalIP()}:${PORT}`;
    const joinUrl = `${base}/phone.html?room=${code}`;

    const game = {
      code, tvSocketId: socket.id,
      players: new Map(), state: 'lobby',
      round: 0, garden: null, health: 100, score: 0,
      roundTimer: null, roundTimeLeft: 0
    };
    rooms.set(code, game);
    socket.join(code);
    socket.roomCode = code;

    // Send room info immediately so code shows right away
    socket.emit('room-created', { code, qrDataUrl: null, joinUrl });

    // Generate QR in background and send when ready
    try {
      const qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 280, margin: 1, color: { dark: '#2E4F1F', light: '#FFFFFF' } });
      socket.emit('qr-ready', { qrDataUrl });
    } catch (e) {}
  });

  socket.on('join-room', ({ code, name }) => {
    const rc = (code || '').toUpperCase().trim();
    const game = rooms.get(rc);
    if (!game) return socket.emit('join-error', { message: 'Room not found.' });
    if (game.state !== 'lobby') return socket.emit('join-error', { message: 'Game already started.' });
    if (game.players.size >= 15) return socket.emit('join-error', { message: 'Room is full!' });

    const roleIdx = game.players.size % ROLES.length;
    const role = ROLES[roleIdx];
    const info = ROLE_INFO[role];

    const player = { id: socket.id, name: name.trim() || 'Player', role, score: 0, coins: 0, perfect: 0, problems: [], problemIdx: 0 };
    game.players.set(socket.id, player);
    socket.join(rc);
    socket.roomCode = rc;

    socket.emit('joined', {
      role, roleName: info.name, roleColor: info.color,
      roleIcon: info.icon, roleDesc: info.desc, playerName: player.name,
      buttons: ACTION_BUTTONS[role], labels: ACTION_LABELS
    });

    io.to(game.tvSocketId).emit('player-joined', { players: getPlayerList(game) });
  });

  socket.on('add-bots', ({ count }) => {
    const game = rooms.get(socket.roomCode);
    if (!game || game.tvSocketId !== socket.id || game.state !== 'lobby') return;
    const n = Math.min(count || 4, 4);
    const botNames = ['Alice 🤖', 'Bob 🤖', 'Carol 🤖', 'Dave 🤖'];
    for (let i = 0; i < n && game.players.size < 15; i++) {
      const botId = 'bot-' + game.code + '-' + i;
      if (game.players.has(botId)) continue;
      const roleIdx = game.players.size % ROLES.length;
      const role = ROLES[roleIdx];
      game.players.set(botId, {
        id: botId, name: botNames[i], role, score: 0, coins: 0, perfect: 0,
        problems: [], problemIdx: 0, isBot: true
      });
    }
    io.to(game.tvSocketId).emit('player-joined', { players: getPlayerList(game) });
  });

  socket.on('start-game', () => {
    const game = rooms.get(socket.roomCode);
    if (!game || game.tvSocketId !== socket.id || game.state !== 'lobby') return;
    if (game.players.size < 1) return socket.emit('game-error', { message: 'Need at least 1 player.' });

    game.state = 'playing';
    game.garden = createGarden();
    io.to(game.code).emit('game-starting', { players: getPlayerList(game), totalRounds: TOTAL_ROUNDS });
    setTimeout(() => {
      startRound(game);
      scheduleBotActions(game);
    }, 3000);
  });

  // Player picks an action level (1, 2, or 3)
  socket.on('player-action', ({ level }) => {
    const game = rooms.get(socket.roomCode);
    if (!game || game.state !== 'playing') return;

    const result = processAction(game, socket.id, level);
    if (!result) return;

    const player = game.players.get(socket.id);

    // Send result to player
    socket.emit('action-result', {
      result: result.result, msg: result.msg,
      correctLevel: result.correctLevel, chosenLevel: result.chosenLevel,
      points: result.points, score: game.score, health: game.health
    });

    // Update TV
    io.to(game.tvSocketId).emit('garden-update', {
      garden: serializeGarden(game.garden),
      health: game.health, score: game.score,
      assignments: getAssignments(game),
      leaderboard: getLeaderboard(game),
      action: {
        playerName: player.name, roleIcon: ROLE_INFO[player.role].icon,
        result: result.result, plotRow: result.correctLevel !== undefined ? player.problems[player.problemIdx - 1].plotRow : 0,
        plotCol: result.correctLevel !== undefined ? player.problems[player.problemIdx - 1].plotCol : 0
      }
    });

    // Send next problem quickly — fast-paced!
    setTimeout(() => sendProblemToPlayer(game, socket.id), 800);
  });

  socket.on('get-time', () => {
    const game = rooms.get(socket.roomCode);
    if (game) socket.emit('time-sync', { timeLeft: game.roundTimeLeft });
  });

  socket.on('reset-game', () => {
    const game = rooms.get(socket.roomCode);
    if (!game || game.tvSocketId !== socket.id) return;
    if (game.roundTimer) { clearInterval(game.roundTimer); game.roundTimer = null; }
    game.state = 'lobby';
    game.round = 0;
    game.garden = null;
    game.health = 100;
    game.score = 0;
    game.coins = 0;
    game.roundTimeLeft = 0;
    // Reset player scores but keep them in the room
    for (const [, player] of game.players) {
      player.score = 0; player.coins = 0; player.perfect = 0;
      player.problems = []; player.problemIdx = 0;
    }
    io.to(game.tvSocketId).emit('game-reset', { players: getPlayerList(game) });
    // Notify phone players to go back to waiting screen
    for (const [sid, player] of game.players) {
      if (!player.isBot) io.to(sid).emit('game-reset', {});
    }
  });

  socket.on('disconnect', () => {
    const game = rooms.get(socket.roomCode);
    if (!game) return;
    if (socket.id === game.tvSocketId) {
      if (game.roundTimer) clearInterval(game.roundTimer);
      io.to(game.code).emit('game-error', { message: 'TV disconnected.' });
      rooms.delete(game.code);
    } else {
      game.players.delete(socket.id);
      io.to(game.tvSocketId).emit('player-joined', { players: getPlayerList(game) });
    }
  });
});

function getPlayerList(game) {
  return Array.from(game.players.values()).map(p => ({
    name: p.name, role: p.role,
    roleName: ROLE_INFO[p.role].name,
    roleIcon: ROLE_INFO[p.role].icon,
    roleColor: ROLE_INFO[p.role].color
  }));
}

// ======================== START ========================

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n' + '='.repeat(50));
  console.log('  GARDEN GUARDIANS - Multiplayer Garden Game');
  console.log('='.repeat(50));
  console.log(`  TV Screen:  http://${ip}:${PORT}/tv.html`);
  console.log(`  Players:    http://${ip}:${PORT}/phone.html`);
  console.log(`  Local:      http://localhost:${PORT}`);
  console.log('='.repeat(50) + '\n');
});
