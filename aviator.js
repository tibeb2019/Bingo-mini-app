'use strict';
const crypto = require('crypto');

const BET_MS = 8000;
const CRASH_PAUSE_MS = 4000;
const K = 0.00007;
const HOUSE_EDGE = 0.03;
const MAX_CRASH = 200;
const HISTORY_MAX = 15;

module.exports = function mountAviator(app, deps) {
  const {
    validateInitData, getBalance, deductIfSufficient,
    changeBalance, touch, logActivity, STAKE_OPTIONS
  } = deps;

  /* ---------- math ---------- */
  function multAt(ms) {
    if (ms <= 0) return 1;
    return Math.max(1, Math.floor(Math.exp(K * ms) * 100) / 100);
  }
  function msFor(mult) {
    return Math.ceil(Math.log(mult) / K);
  }
  function genCrash() {
    const R = 1099511627776; // 2^40
    const u = crypto.randomInt(0, R) / R;
    const raw = (1 - HOUSE_EDGE) / (1 - u);
    let c = Math.floor(raw * 100) / 100;
    if (c < 1) c = 1;
    if (c > MAX_CRASH) c = MAX_CRASH;
    return c;
  }
  function parseAuto(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(MAX_CRASH, Math.max(1.01, Math.round(n * 100) / 100));
  }
  function fail(res, status, code, msg) {
    return res.status(status).json({ error: msg, code: code });
  }

  /* ---------- round state (in memory) ---------- */
  let roundSeq = Math.floor(Date.now() / 1000);
  let cur = null;
  const history = [];

  function newRound(betStart) {
    const crash = genCrash();
    cur = {
      id: ++roundSeq,
      phase: 'betting',
      betStart: betStart,
      betEnd: betStart + BET_MS,
      flyStart: null,
      crashPoint: crash,
      crashMs: msFor(crash),
      crashedAt: null,
      bets: new Map()
    };
  }

  async function creditWin(b, roundId) {
    for (let i = 0; i < 3; i++) {
      try {
        await changeBalance(b.userId, b.win);
        b.paid = true;
        try {
          logActivity({
            type: 'aviator_cashout', userId: b.userId, name: b.name,
            amount: b.amount, win: b.win, mult: b.cashMult,
            slot: b.slot, round: roundId
          });
        } catch (e) { /* ignore */ }
        return true;
      } catch (err) {
        console.error('aviator credit retry', i + 1, err);
      }
    }
    console.error('AVIATOR CREDIT FAILED', b.userId, b.win, roundId);
    return false;
  }

  function settleAutos(r, el) {
    r.bets.forEach(function (b) {
      if (!b.ready || b.cashed || !b.auto) return;
      const am = msFor(b.auto);
      if (am <= el && am < r.crashMs) {
        // mark synchronously BEFORE any await
        b.cashed = true;
        b.cashMult = b.auto;
        b.win = Math.floor(b.amount * b.auto * 100) / 100;
        creditWin(b, r.id).catch(function () {});
      }
    });
  }

  function advance(now) {
    for (let i = 0; i < 10; i++) {
      const r = cur;
      if (r.phase === 'betting') {
        if (now < r.betEnd) return;
        r.phase = 'flying';
        r.flyStart = r.betEnd;
      }
      if (r.phase === 'flying') {
        const el = now - r.flyStart;
        settleAutos(r, el);
        if (el < r.crashMs) return;
        r.phase = 'crashed';
        r.crashedAt = r.flyStart + r.crashMs;
        history.unshift(r.crashPoint);
        if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
      }
      if (r.phase === 'crashed') {
        const nextStart = r.crashedAt + CRASH_PAUSE_MS;
        if (now < nextStart) return;
        newRound(now - nextStart > 1000 ? now : nextStart);
        continue;
      }
    }
  }

  newRound(Date.now());
  setInterval(function () {
    try { advance(Date.now()); } catch (e) { console.error('aviator tick', e); }
  }, 100);

  /* ---------- GET state ---------- */
  app.get('/api/aviator/state', async function (req, res) {
    try {
      const user = validateInitData(req.query.initData || '');
      if (!user) return fail(res, 401, 'auth', 'invalid initData');

      const now = Date.now();
      advance(now);
      const r = cur;

      let flyingMs = 0;
      let mult = 1;
      if (r.phase === 'flying') {
        flyingMs = now - r.flyStart;
        mult = Math.min(multAt(flyingMs), r.crashPoint);
      } else if (r.phase === 'crashed') {
        flyingMs = r.crashMs;
        mult = r.crashPoint;
      }

      const myBets = [];
      [0, 1].forEach(function (slot) {
        const b = r.bets.get(user.id + ':' + slot);
        if (b && b.ready) {
          myBets.push({
            slot: slot,
            amount: b.amount,
            auto: b.auto,
            cashed: b.cashed,
            cash_mult: b.cashMult,
            win: b.win
          });
        }
      });

      const players = new Set();
      r.bets.forEach(function (b) {
        if (b.ready) players.add(b.userId);
      });

      touch(user.id, user.first_name);
      const balance = await getBalance(user.id);

      const out = {
        success: true,
        round: r.id,
        phase: r.phase,
        bet_left_ms: r.phase === 'betting' ? Math.max(0, r.betEnd - now) : 0,
        flying_ms: flyingMs,
        mult: mult,
        history: history.slice(0, HISTORY_MAX),
        my_bets: myBets,
        players: players.size,
        balance: Number(balance)
      };
      if (r.phase === 'crashed') {
        out.crash_point = r.crashPoint;
        out.next_in_ms = Math.max(0, r.crashedAt + CRASH_PAUSE_MS - now);
      }
      return res.json(out);
    } catch (err) {
      console.error('aviator state error:', err);
      return res.status(500).json({ error: 'failed to load state' });
    }
  });

  /* ---------- POST bet ---------- */
  app.post('/api/aviator/bet', async function (req, res) {
    try {
      const user = validateInitData(req.body.initData);
      if (!user) return fail(res, 401, 'auth', 'invalid initData');

      const slot = Number(req.body.slot);
      if (slot !== 0 && slot !== 1) {
        return fail(res, 400, 'slot', 'ልክ ያልሆነ ቦታ');
      }
      const amount = Number(req.body.amount);
      if (!Number.isFinite(amount) || STAKE_OPTIONS.indexOf(amount) === -1) {
        return fail(res, 400, 'amount', 'ልክ ያልሆነ መጠን');
      }
      const auto = parseAuto(req.body.auto);

      const now = Date.now();
      advance(now);
      const r = cur;
      if (r.phase !== 'betting' || now >= r.betEnd) {
        return fail(res, 400, 'closed', 'ውርርድ ተዘግቷል');
      }

      const key = user.id + ':' + slot;
      if (r.bets.has(key)) {
        return fail(res, 409, 'dup', 'በዚህ ቦታ ቀድሞ ተወራርደዋል');
      }

      const bet = {
        userId: String(user.id),
        name: user.first_name || null,
        slot: slot,
        amount: amount,
        auto: auto,
        ready: false,
        cashed: false,
        cashMult: null,
        win: 0,
        paid: false
      };

      // reserve the slot synchronously BEFORE any await
      r.bets.set(key, bet);

      let ded;
      try {
        ded = await deductIfSufficient(user.id, amount);
      } catch (e) {
        r.bets.delete(key);
        throw e;
      }
      if (!ded.ok) {
        r.bets.delete(key);
        return res.status(400).json({
          error: 'በቂ ቀሪ ሂሳብ የለም',
          code: 'balance',
          balance: Number(ded.balance)
        });
      }

      // round may have started while we awaited -> refund
      advance(Date.now());
      if (cur !== r || r.phase !== 'betting') {
        r.bets.delete(key);
        try {
          await changeBalance(user.id, amount);
        } catch (e) {
          console.error('AVIATOR REFUND FAILED', user.id, amount, e);
        }
        return fail(res, 400, 'closed', 'ውርርድ ተዘግቷል');
      }

      bet.ready = true;

      touch(user.id, user.first_name);
      logActivity({
        type: 'aviator_bet', userId: user.id, name: user.first_name || null,
        amount: amount, auto: auto, slot: slot, round: r.id
      });

      return res.json({
        success: true,
        round: r.id,
        slot: slot,
        amount: amount,
        auto: auto,
        balance: Number(ded.balance)
      });
    } catch (err) {
      console.error('aviator bet error:', err);
      return res.status(500).json({ error: 'failed to place bet' });
    }
  });

  /* ---------- POST cashout ---------- */
  app.post('/api/aviator/cashout', async function (req, res) {
    try {
      const user = validateInitData(req.body.initData);
      if (!user) return fail(res, 401, 'auth', 'invalid initData');

      const slot = Number(req.body.slot);
      if (slot !== 0 && slot !== 1) {
        return fail(res, 400, 'slot', 'ልክ ያልሆነ ቦታ');
      }

      const now = Date.now();
      advance(now);
      const r = cur;
      const b = r.bets.get(user.id + ':' + slot);

      if (!b || !b.ready) return fail(res, 404, 'nobet', 'ውርርድ የለም');
      if (b.cashed) return fail(res, 409, 'done', 'ቀድሞ ወጥተዋል');
      if (r.phase !== 'flying') return fail(res, 400, 'late', 'አውሮፕላኑ ጠፍቷል');

      const el = now - r.flyStart;
      if (el >= r.crashMs) return fail(res, 400, 'late', 'አውሮፕላኑ ጠፍቷል');

      const mult = Math.min(multAt(el), r.crashPoint);

      // mark cashed synchronously BEFORE awaiting the balance change
      b.cashed = true;
      b.cashMult = mult;
      b.win = Math.floor(b.amount * mult * 100) / 100;

      const ok = await creditWin(b, r.id);
      if (!ok) {
        return res.status(500).json({ error: 'failed to credit win', code: 'credit' });
      }

      touch(user.id, user.first_name);
      const balance = await getBalance(user.id);

      return res.json({
        success: true,
        slot: slot,
        mult: mult,
        win: b.win,
        balance: Number(balance)
      });
    } catch (err) {
      console.error('aviator cashout error:', err);
      return res.status(500).json({ error: 'failed to cash out' });
    }
  });
};
