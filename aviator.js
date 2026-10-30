'use strict';
const crypto = require('crypto');
const express = require('express');

module.exports = function (app, h) {
  const { validateInitData, getBalance, deductIfSufficient, changeBalance, touch, logActivity, STAKE_OPTIONS } = h;

  const BET_MS = 8000, CRASH_MS = 4000, RATE = 0.00007, EDGE = 0.03, CAP = 200, HIST = 15;
  const json = express.json();

  let round = 0, phase = 'betting', phaseStart = Date.now();
  let crashPoint = 1, crashMs = 0;
  let bets = new Map();
  const history = [];

  const multAt = ms => Math.floor(Math.exp(RATE * ms) * 100) / 100;
  const safe = fn => { try { Promise.resolve(fn()).catch(() => {}); } catch (e) {} };

  function genCrash() {
    const r = crypto.randomBytes(6).readUIntBE(0, 6) / 281474976710656;
    let c = Math.floor(((1 - EDGE) / (1 - r)) * 100) / 100;
    if (!(c >= 1)) c = 1;
    return Math.min(c, CAP);
  }

  function newRound(ts) {
    round++;
    phase = 'betting';
    phaseStart = ts || Date.now();
    crashPoint = genCrash();
    crashMs = Math.ceil(Math.log(crashPoint) / RATE);
    bets = new Map();
  }

  // mark cashed synchronously, then pay
  function settle(b, mult) {
    b.cashed = true;
    b.cash_mult = mult;
    b.win = Math.floor(b.amount * mult * 100) / 100;
    return (async () => {
      try { await changeBalance(b.uid, b.win); }
      catch (e) { console.error('aviator payout failed', b.uid, b.win, e); }
    })();
  }

  function autoCash(limit, strict) {
    for (const b of bets.values()) {
      if (b.pending || b.cashed || !b.auto) continue;
      if (strict ? b.auto < limit : b.auto <= limit) settle(b, b.auto);
    }
  }

  function advance() {
    for (let i = 0; i < 6; i++) {
      const el = Date.now() - phaseStart;
      if (phase === 'betting') {
        if (el < BET_MS) return;
        phase = 'flying';
        phaseStart += BET_MS;
      } else if (phase === 'flying') {
        if (el < crashMs) { autoCash(multAt(el), false); return; }
        autoCash(crashPoint, true);
        phase = 'crashed';
        phaseStart += crashMs;
        history.unshift(crashPoint);
        if (history.length > HIST) history.pop();
      } else {
        if (el < CRASH_MS) return;
        newRound(phaseStart + CRASH_MS);
      }
    }
  }

  newRound();
  setInterval(advance, 100);

  async function auth(initData) {
    if (!initData) return null;
    try {
      const u = await validateInitData(initData);
      return u && u.id ? u : null;
    } catch (e) { return null; }
  }

  const bad = (res, error, extra) => res.status(400).json(Object.assign({ error }, extra || {}));

  app.get('/api/aviator/state', async (req, res) => {
    try {
      const u = await auth(req.query.initData);
      if (!u) return res.status(401).json({ error: 'auth' });
      advance();
      const el = Date.now() - phaseStart;
      const out = {
        round, phase, rate: RATE, stakes: STAKE_OPTIONS, history,
        bet_left_ms: 0, flying_ms: 0, mult: 1
      };
      if (phase === 'betting') out.bet_left_ms = Math.max(0, BET_MS - el);
      else if (phase === 'flying') { out.flying_ms = el; out.mult = multAt(Math.min(el, crashMs)); }
      else { out.mult = crashPoint; out.crash = crashPoint; }

      const uids = new Set();
      let cnt = 0;
      for (const b of bets.values()) { if (!b.pending) { uids.add(String(b.uid)); cnt++; } }
      out.players = uids.size;
      out.bets_count = cnt;

      out.my_bets = [0, 1].map(s => {
        const b = bets.get(u.id + ':' + s);
        if (!b) return null;
        return { amount: b.amount, auto: b.auto, cashed: b.cashed, cash_mult: b.cash_mult, win: b.win };
      });
      out.balance = await getBalance(u.id);
      res.json(out);
    } catch (e) {
      console.error('aviator state', e);
      res.status(500).json({ error: 'server' });
    }
  });

  app.post('/api/aviator/bet', json, async (req, res) => {
    try {
      const p = req.body || {};
      const u = await auth(p.initData);
      if (!u) return res.status(401).json({ error: 'auth' });
      const slot = Number(p.slot);
      if (slot !== 0 && slot !== 1) return bad(res, 'slot');
      const amount = Number(p.amount);
      if (!STAKE_OPTIONS.includes(amount)) return bad(res, 'amount');
      let auto = null;
      if (p.auto !== null && p.auto !== undefined && p.auto !== '') {
        auto = Math.round(Number(p.auto) * 100) / 100;
        if (!(auto >= 1.01 && auto <= CAP)) return bad(res, 'auto');
      }
      advance();
      if (phase !== 'betting') return bad(res, 'closed');
      const key = u.id + ':' + slot;
      if (bets.has(key)) return bad(res, 'already');

      const myRound = round;
      const bet = { uid: u.id, slot, amount, auto, cashed: false, cash_mult: 0, win: 0, pending: true };
      bets.set(key, bet); // reserve slot BEFORE awaiting

      let r;
      try { r = await deductIfSufficient(u.id, amount); }
      catch (e) { if (bets.get(key) === bet) bets.delete(key); throw e; }
      if (!r || !r.ok) {
        if (bets.get(key) === bet) bets.delete(key);
        return bad(res, 'balance', { balance: r && r.balance });
      }

      advance();
      if (round !== myRound || phase !== 'betting' || bets.get(key) !== bet) {
        await changeBalance(u.id, amount); // refund: round already started
        if (bets.get(key) === bet) bets.delete(key);
        return bad(res, 'closed', { balance: await getBalance(u.id) });
      }
      bet.pending = false;
      safe(() => touch(u.id, u.first_name));
      safe(() => logActivity(u.id, 'aviator bet ' + amount));
      res.json({ ok: true, balance: r.balance });
    } catch (e) {
      console.error('aviator bet', e);
      res.status(500).json({ error: 'server' });
    }
  });

  app.post('/api/aviator/cashout', json, async (req, res) => {
    try {
      const p = req.body || {};
      const u = await auth(p.initData);
      if (!u) return res.status(401).json({ error: 'auth' });
      const slot = Number(p.slot);
      if (slot !== 0 && slot !== 1) return bad(res, 'slot');
      advance();
      const b = bets.get(u.id + ':' + slot);
      if (!b || b.pending) return bad(res, 'nobet');
      if (b.cashed) return bad(res, 'already', { mult: b.cash_mult, win: b.win });
      if (phase !== 'flying') return bad(res, 'notflying');
      const el = Date.now() - phaseStart;
      if (el >= crashMs) return bad(res, 'crashed');
      const mult = multAt(el);
      await settle(b, mult); // cashed flag is set synchronously inside
      safe(() => logActivity(u.id, 'aviator win ' + b.win + ' @' + mult));
      res.json({ mult, win: b.win, balance: await getBalance(u.id) });
    } catch (e) {
      console.error('aviator cashout', e);
      res.status(500).json({ error: 'server' });
    }
  });
};
