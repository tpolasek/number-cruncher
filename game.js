(function () {
  'use strict';

  // ===== Constants =====
  const COLS = 6;
  const ROWS = 5;
  const CELL = 100; // px (canvas is COLS*CELL x ROWS*CELL)
  const START_TARGET = 5;
  const TARGET_STEP = 5;
  const MAX_TARGET = 100;
  const START_LIVES = 3;
  const POINTS_PER_CELL = 10;
  const TROGGLE_GRACE_MS = 3000;
  const INVULN_MS = 1500;
  const LEVEL_TRANSITION_MS = 1800;

  const COLORS = {
    bg: '#000000',
    grid: '#7b2fbe',
    gridDim: '#3a1466',
    ink: '#ffffff',
    muncherBody: '#3fcc6e',
    muncherDark: '#1f8a3e',
    troggleBody: '#ff4d6d',
    troggleDark: '#a8203a',
    teeth: '#ffffff',
  };

  // ===== DOM =====
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const elTarget = document.getElementById('target');
  const elScore = document.getElementById('score');
  const elLives = document.getElementById('lives');
  const elLevel = document.getElementById('level');
  const elOverlay = document.getElementById('overlay');
  const elOverlayTitle = elOverlay.querySelector('h1');
  const elOverlayMsg = document.getElementById('overlay-msg');

  // ===== State =====
  const state = {
    status: 'idle', // idle | playing | paused | levelComplete | gameOver | won
    level: 1,
    target: START_TARGET,
    score: 0,
    lives: START_LIVES,
    grid: [],
    remainingCorrect: 0,
    player: { col: 0, row: 0, invulnUntil: 0 },
    troggles: [],
    troggleSpawnAt: 0,
    pausedAt: 0,
  };

  // ===== Audio (procedural square-wave synthesis) =====
  const Sfx = {
    ctx: null,
    init() {
      try {
        if (!this.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) this.ctx = new AC();
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) {
        this.ctx = null;
      }
    },
    // Schedule a single square-wave tone starting at `start` seconds offset from now.
    tone(freq, start, dur, gain) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime + start;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + 0.005);
      g.gain.linearRampToValueAtTime(gain * 0.6, t0 + dur * 0.6);
      g.gain.linearRampToValueAtTime(0, t0 + dur);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },
    play(name) {
      if (!this.ctx) return;
      switch (name) {
        case 'move':
          this.tone(330, 0, 0.05, 0.06);
          break;
        case 'eat':
          this.tone(523, 0, 0.06, 0.10);
          this.tone(659, 0.06, 0.06, 0.10);
          this.tone(784, 0.12, 0.10, 0.10);
          break;
        case 'wrong':
          this.tone(140, 0, 0.22, 0.18);
          this.tone(95, 0.02, 0.24, 0.12);
          break;
        case 'death':
          this.tone(440, 0, 0.10, 0.16);
          this.tone(330, 0.10, 0.10, 0.16);
          this.tone(220, 0.20, 0.10, 0.16);
          this.tone(110, 0.30, 0.25, 0.18);
          break;
        case 'levelUp':
          this.tone(523, 0, 0.09, 0.12);
          this.tone(659, 0.09, 0.09, 0.12);
          this.tone(784, 0.18, 0.09, 0.12);
          this.tone(1047, 0.27, 0.20, 0.14);
          break;
        case 'gameOver':
          this.tone(440, 0, 0.18, 0.14);
          this.tone(392, 0.18, 0.18, 0.14);
          this.tone(330, 0.36, 0.18, 0.14);
          this.tone(220, 0.54, 0.40, 0.16);
          break;
        case 'win':
          this.tone(523, 0, 0.10, 0.14);
          this.tone(659, 0.10, 0.10, 0.14);
          this.tone(784, 0.20, 0.10, 0.14);
          this.tone(1047, 0.30, 0.10, 0.14);
          this.tone(1319, 0.40, 0.30, 0.16);
          break;
      }
    },
  };

  // ===== Utilities =====
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  // ===== Level generation =====
  // Each cell: { a, b, op, empty } where op ∈ {'+', '-'}.
  // Operands are kept proportional to target so e.g. target=5 shows "9 - 4"
  // (max ~2X) rather than "95 - 90".
  function makeCell(target, wantCorrect) {
    const op = Math.random() < 0.5 ? '+' : '-';
    if (op === '+') {
      if (wantCorrect) {
        const a = randInt(0, target);
        const b = target - a;
        return { a, b, op, empty: false };
      }
      let a, b, guard = 0;
      do {
        a = randInt(0, target);
        b = randInt(0, target);
        guard++;
      } while (a + b === target && guard < 50);
      return { a, b, op, empty: false };
    }
    // subtraction: a - b. b in [0, target], a in [b, 2*target] => result in [0, 2*target].
    if (wantCorrect) {
      const b = randInt(0, target);
      const a = target + b; // a in [target, 2*target]
      return { a, b, op, empty: false };
    }
    let a, b, guard = 0;
    do {
      b = randInt(0, target);
      a = randInt(b, 2 * target);
      guard++;
    } while (a - b === target && guard < 50);
    return { a, b, op, empty: false };
  }

  function evalCell(cell) {
    return cell.op === '-' ? cell.a - cell.b : cell.a + cell.b;
  }

  function generateLevel(target) {
    const total = COLS * ROWS;
    // ~45% correct, clamped so the level is neither trivial nor brutal
    let numCorrect = Math.round(total * 0.45);
    numCorrect = clamp(numCorrect, 6, 22);
    const flags = [];
    for (let i = 0; i < numCorrect; i++) flags.push(true);
    for (let i = 0; i < total - numCorrect; i++) flags.push(false);
    shuffle(flags);
    const cells = [];
    for (let i = 0; i < total; i++) {
      cells.push(makeCell(target, flags[i]));
    }
    return cells;
  }

  function countCorrect() {
    let n = 0;
    for (const c of state.grid) {
      if (!c.empty && evalCell(c) === state.target) n++;
    }
    return n;
  }

  function cellAt(col, row) {
    return state.grid[row * COLS + col];
  }

  // ===== Game flow =====
  function init() {
    state.status = 'idle';
    state.level = 1;
    state.target = START_TARGET;
    state.score = 0;
    state.lives = START_LIVES;
    state.grid = generateLevel(state.target);
    state.remainingCorrect = countCorrect();
    state.player = { col: 0, row: 0, invulnUntil: 0 };
    state.troggles = [];
    state.troggleSpawnAt = 0;
    updateHUD();
    showOverlay('NUMBER CRUNCHER', 'Press any key to start');
    requestAnimationFrame(loop);
  }

  function startGame() {
    Sfx.init();
    state.troggleSpawnAt = performance.now() + TROGGLE_GRACE_MS;
    state.status = 'playing';
    hideOverlay();
  }

  function startLevel() {
    state.grid = generateLevel(state.target);
    state.remainingCorrect = countCorrect();
    state.player.col = 0;
    state.player.row = 0;
    state.player.invulnUntil = 0;
    state.troggles = [];
    state.troggleSpawnAt = performance.now() + TROGGLE_GRACE_MS;
    state.status = 'playing';
    hideOverlay();
    updateHUD();
  }

  function resetGame() {
    state.level = 1;
    state.target = START_TARGET;
    state.score = 0;
    state.lives = START_LIVES;
    startLevel();
  }

  function movePlayer(dc, dr) {
    const nc = clamp(state.player.col + dc, 0, COLS - 1);
    const nr = clamp(state.player.row + dr, 0, ROWS - 1);
    if (nc === state.player.col && nr === state.player.row) return;
    state.player.col = nc;
    state.player.row = nr;
    Sfx.play('move');
    checkTroggleHit();
  }

  function munch() {
    const cell = cellAt(state.player.col, state.player.row);
    if (!cell || cell.empty) return;
    if (evalCell(cell) === state.target) {
      cell.empty = true;
      state.score += POINTS_PER_CELL;
      state.remainingCorrect -= 1;
      Sfx.play('eat');
      updateHUD();
      if (state.remainingCorrect <= 0) levelComplete();
    } else {
      Sfx.play('wrong');
      loseLife(false);
    }
  }

  function loseLife(respawn = true) {
    state.lives -= 1;
    updateHUD();
    if (state.lives <= 0) {
      gameOver();
      return;
    }
    Sfx.play('death');
    state.player.invulnUntil = performance.now() + INVULN_MS;
    if (respawn) {
      state.player.col = 0;
      state.player.row = 0;
      relocateTroggles();
    }
  }

  function levelComplete() {
    state.status = 'levelComplete';
    if (state.target >= MAX_TARGET) {
      Sfx.play('win');
      state.status = 'won';
      showOverlay('YOU WIN!', `Final score: ${state.score}  —  Press R to play again`);
      return;
    }
    Sfx.play('levelUp');
    showOverlay(`LEVEL ${state.level} CLEAR`, `Next: Numbers that make ${state.target + TARGET_STEP}`);
    setTimeout(() => {
      state.level += 1;
      state.target += TARGET_STEP;
      startLevel();
    }, LEVEL_TRANSITION_MS);
  }

  function gameOver() {
    state.status = 'gameOver';
    Sfx.play('gameOver');
    showOverlay('GAME OVER', `Score: ${state.score}  —  Press R to restart`);
  }

  function togglePause() {
    if (state.status === 'playing') {
      state.status = 'paused';
      state.pausedAt = performance.now();
      showOverlay('PAUSED', 'Press P to resume');
    } else if (state.status === 'paused') {
      const delta = performance.now() - state.pausedAt;
      state.troggleSpawnAt += delta;
      for (const t of state.troggles) t.nextMoveAt += delta;
      state.player.invulnUntil += delta;
      state.status = 'playing';
      hideOverlay();
    }
  }

  // ===== Troggles =====
  function troggleInterval() {
    // L1 = 1500ms, shrinks 50ms per level, floor 600ms.
    return Math.max(600, 1500 - (state.level - 1) * 50);
  }

  function spawnTroggle() {
    let c, r, guard = 0;
    do {
      c = randInt(0, COLS - 1);
      r = randInt(0, ROWS - 1);
      guard++;
    } while ((c === state.player.col && r === state.player.row) && guard < 50);
    state.troggles.push({
      col: c,
      row: r,
      nextMoveAt: performance.now() + troggleInterval(),
    });
  }

  function moveTroggle(t) {
    const dirs = shuffle([[0, -1], [0, 1], [-1, 0], [1, 0]]);
    for (const [dc, dr] of dirs) {
      const nc = t.col + dc;
      const nr = t.row + dr;
      if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS) {
        t.col = nc;
        t.row = nr;
        checkTroggleHit();
        return;
      }
    }
  }

  function relocateTroggles() {
    for (const t of state.troggles) {
      let c, r, guard = 0;
      do {
        c = randInt(0, COLS - 1);
        r = randInt(0, ROWS - 1);
        guard++;
      } while (Math.abs(c - state.player.col) + Math.abs(r - state.player.row) < 3 && guard < 50);
      t.col = c;
      t.row = r;
      t.nextMoveAt = performance.now() + troggleInterval();
    }
  }

  function checkTroggleHit() {
    if (performance.now() < state.player.invulnUntil) return;
    for (const t of state.troggles) {
      if (t.col === state.player.col && t.row === state.player.row) {
        loseLife();
        return;
      }
    }
  }

  function updateTroggles(now) {
    if (state.troggles.length === 0 && state.troggleSpawnAt > 0 && now >= state.troggleSpawnAt) {
      spawnTroggle();
    }
    for (const t of state.troggles) {
      if (now >= t.nextMoveAt) {
        moveTroggle(t);
        t.nextMoveAt = now + troggleInterval();
      }
    }
  }

  // ===== Rendering =====
  function draw() {
    // background
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // cell fills (very subtle so the grid reads as panels)
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        ctx.fillStyle = (c + r) % 2 === 0 ? '#08000f' : '#0e001c';
        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    }

    // grid lines
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let c = 0; c <= COLS; c++) {
      ctx.moveTo(c * CELL + 0.5, 0);
      ctx.lineTo(c * CELL + 0.5, ROWS * CELL);
    }
    for (let r = 0; r <= ROWS; r++) {
      ctx.moveTo(0, r * CELL + 0.5);
      ctx.lineTo(COLS * CELL, r * CELL + 0.5);
    }
    ctx.stroke();

    // expressions
    ctx.fillStyle = COLORS.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = cellAt(c, r);
        if (!cell || cell.empty) continue;
        const text = `${cell.a} ${cell.op} ${cell.b}`;
        let size = 30;
        ctx.font = `${size}px "Courier New", ui-monospace, monospace`;
        while (ctx.measureText(text).width > CELL - 14 && size > 14) {
          size -= 2;
          ctx.font = `${size}px "Courier New", ui-monospace, monospace`;
        }
        ctx.fillText(text, c * CELL + CELL / 2, r * CELL + CELL / 2);
      }
    }

    // troggles
    for (const t of state.troggles) {
      drawTroggle(t.col * CELL, t.row * CELL);
    }

    // player (blink during invulnerability)
    const now = performance.now();
    const invuln = now < state.player.invulnUntil;
    const blink = invuln && Math.floor(now / 100) % 2 === 0;
    if (!blink) {
      drawMuncher(state.player.col * CELL, state.player.row * CELL);
    }
  }

  function drawMuncher(x, y) {
    // Slug-style eyestalks: thin green stalks rising from the head with
    // white eyeballs perched on top.
    ctx.fillStyle = COLORS.muncherBody;
    ctx.fillRect(x + 29, y + 12, 6, 14);  // left stalk
    ctx.fillRect(x + 65, y + 12, 6, 14);  // right stalk
    // Eyeballs (white) at the tip of each stalk
    ctx.fillStyle = '#fff';
    ctx.fillRect(x + 23, y + 0, 18, 14);  // left eyeball
    ctx.fillRect(x + 59, y + 0, 18, 14);  // right eyeball
    // Pupils (black)
    ctx.fillStyle = '#000';
    ctx.fillRect(x + 29, y + 4, 6, 6);    // left pupil
    ctx.fillRect(x + 65, y + 4, 6, 6);    // right pupil
    // Head + body
    ctx.fillStyle = COLORS.muncherBody;
    ctx.fillRect(x + 24, y + 24, 52, 14); // top of head
    ctx.fillRect(x + 14, y + 32, 72, 56); // body
    // Body shading (bottom edge)
    ctx.fillStyle = COLORS.muncherDark;
    ctx.fillRect(x + 14, y + 82, 72, 6);
    // Open mouth (black interior)
    ctx.fillStyle = '#000';
    ctx.fillRect(x + 20, y + 48, 60, 24);
    // Top teeth
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 5; i++) {
      ctx.fillRect(x + 26 + i * 10, y + 48, 6, 8);
    }
    // Bottom teeth
    for (let i = 0; i < 5; i++) {
      ctx.fillRect(x + 30 + i * 10, y + 64, 6, 8);
    }
  }

  function drawTroggle(x, y) {
    // body
    ctx.fillStyle = COLORS.troggleBody;
    ctx.fillRect(x + 14, y + 26, 72, 52);
    // horns
    ctx.fillRect(x + 14, y + 14, 12, 16);
    ctx.fillRect(x + 74, y + 14, 12, 16);
    // horn tips (darker)
    ctx.fillStyle = COLORS.troggleDark;
    ctx.fillRect(x + 14, y + 14, 12, 5);
    ctx.fillRect(x + 74, y + 14, 12, 5);
    // single large centered eye (white sclera)
    ctx.fillStyle = COLORS.teeth;
    ctx.fillRect(x + 30, y + 32, 40, 18);
    // pupil (black)
    ctx.fillStyle = '#000';
    ctx.fillRect(x + 44, y + 36, 12, 12);
    // jagged mouth
    ctx.fillStyle = '#000';
    ctx.fillRect(x + 20, y + 58, 60, 16);
    // teeth (alternating up/down)
    ctx.fillStyle = COLORS.teeth;
    for (let i = 0; i < 6; i++) {
      ctx.fillRect(x + 22 + i * 10, y + 58, 5, 6);
    }
    for (let i = 0; i < 5; i++) {
      ctx.fillRect(x + 27 + i * 10, y + 68, 5, 6);
    }
  }

  // ===== HUD & overlay =====
  function updateHUD() {
    elTarget.textContent = state.target;
    elScore.textContent = state.score;
    elLives.textContent = '💚'.repeat(state.lives);
    elLevel.textContent = state.level;
  }

  function showOverlay(title, msg) {
    elOverlayTitle.textContent = title;
    elOverlayMsg.textContent = msg;
    elOverlay.classList.add('visible');
  }

  function hideOverlay() {
    elOverlay.classList.remove('visible');
  }

  // ===== Input =====
  window.addEventListener('keydown', (e) => {
    // Always unlock audio + start on first key from idle.
    if (state.status === 'idle') {
      e.preventDefault();
      startGame();
      return;
    }
    if (state.status === 'gameOver' || state.status === 'won') {
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        resetGame();
      }
      return;
    }
    if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      togglePause();
      return;
    }
    if (state.status !== 'playing') return;

    switch (e.key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        e.preventDefault();
        movePlayer(0, -1);
        break;
      case 'ArrowDown':
      case 's':
      case 'S':
        e.preventDefault();
        movePlayer(0, 1);
        break;
      case 'ArrowLeft':
      case 'a':
      case 'A':
        e.preventDefault();
        movePlayer(-1, 0);
        break;
      case 'ArrowRight':
      case 'd':
      case 'D':
        e.preventDefault();
        movePlayer(1, 0);
        break;
      case ' ':
        e.preventDefault();
        munch();
        break;
    }
  });

  // ===== Loop =====
  function loop(now) {
    if (state.status === 'playing') {
      updateTroggles(now);
    }
    draw();
    requestAnimationFrame(loop);
  }

  // ===== Go =====
  init();
})();
