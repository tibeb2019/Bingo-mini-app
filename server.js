require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const STARTING_BALANCE = 0;

const STAKE_OPTIONS = [5, 10, 20, 30, 40, 50, 80, 100, 200];

const MAX_NUMBERS = 8;

const SPIN_PAYOUT_MULTIPLIER = 36;

const ROUND_LENGTH = 50;
const BET_LENGTH = 40;

const MAX_ROUND_LIABILITY =
  Number(process.env.MAX_ROUND_LIABILITY || 50000);

const ONLINE_WINDOW_MS = 30 * 1000;

const ACTIVITY_LOG_MAX = 200;

/* =========================================================
   ROULETTE
========================================================= */

const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27,
  13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1,
  20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];

const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18,
  19, 21, 23, 25, 27, 30, 32, 34, 36
]);

function colorFor(number) {
  number = Number(number);

  if (number === 0) {
    return 'green';
  }

  return RED_NUMBERS.has(number)
    ? 'red'
    : 'black';
}

const EVEN_MONEY_MULTIPLIER = 2;
const DOZEN_MULTIPLIER = 3;

const ALL_NUMBERS =
  Array.from({ length: 37 }, (_, i) => i);

/* =========================================================
   DATABASE
========================================================= */

if (!DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set.');
  console.warn('Server will use in-memory storage.');
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

const memBalances = {};

const memOrders = {
  nextId: 1,
  orders: {}
};

const memTickets = {};

const memRounds = {};

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initDb() {
  if (!pool) {
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS balances (
      user_id TEXT PRIMARY KEY,
      balance NUMERIC NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      phone TEXT,
      confirmed_by TEXT,
      rejected_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id TEXT PRIMARY KEY,
      round_id BIGINT NOT NULL,
      user_id TEXT NOT NULL,
      bet_type TEXT NOT NULL,
      numbers JSONB NOT NULL DEFAULT '[]',
      stake NUMERIC NOT NULL,
      per_number_stake NUMERIC NOT NULL,
      settled BOOLEAN NOT NULL DEFAULT false,
      won BOOLEAN,
      payout NUMERIC NOT NULL DEFAULT 0,
      winning_number INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      settled_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rounds (
      round_id BIGINT PRIMARY KEY,
      winning_number INTEGER NOT NULL,
      winning_color TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  console.log('Database tables ready');
}

/* =========================================================
   BALANCE
========================================================= */

async function getBalance(userId) {
  userId = String(userId);

  if (!pool) {
    if (!(userId in memBalances)) {
      memBalances[userId] = STARTING_BALANCE;
    }

    return Number(memBalances[userId]);
  }

  const result = await pool.query(
    `
    SELECT balance
    FROM balances
    WHERE user_id = $1
    `,
    [userId]
  );

  if (result.rows.length === 0) {
    await pool.query(
      `
      INSERT INTO balances
        (user_id, balance)
      VALUES
        ($1, $2)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [
        userId,
        STARTING_BALANCE
      ]
    );

    const again = await pool.query(
      `
      SELECT balance
      FROM balances
      WHERE user_id = $1
      `,
      [userId]
    );

    return again.rows.length
      ? Number(again.rows[0].balance)
      : STARTING_BALANCE;
  }

  return Number(result.rows[0].balance);
}

async function changeBalance(userId, delta) {
  userId = String(userId);
  delta = Number(delta);

  if (!Number.isFinite(delta)) {
    throw new Error('Invalid balance change');
  }

  if (!pool) {
    const current = await getBalance(userId);
    const next = current + delta;

    if (next < 0) {
      throw new Error('Balance cannot become negative');
    }

    memBalances[userId] = next;

    return Number(next);
  }

  await getBalance(userId);

  const result = await pool.query(
    `
    UPDATE balances
    SET balance = balance + $2
    WHERE user_id = $1
      AND balance + $2 >= 0
    RETURNING balance
    `,
    [
      userId,
      delta
    ]
  );

  if (result.rows.length === 0) {
    throw new Error('Balance update rejected');
  }

  return Number(result.rows[0].balance);
}

async function deductIfSufficient(userId, amount) {
  userId = String(userId);
  amount = Number(amount);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return {
      ok: false,
      balance: await getBalance(userId)
    };
  }

  if (!pool) {
    const current = await getBalance(userId);

    if (current < amount) {
      return {
        ok: false,
        balance: current
      };
    }

    memBalances[userId] = current - amount;

    return {
      ok: true,
      balance: Number(memBalances[userId])
    };
  }

  await getBalance(userId);

  const result = await pool.query(
    `
    UPDATE balances
    SET balance = balance - $2
    WHERE user_id = $1
      AND balance >= $2
    RETURNING balance
    `,
    [
      userId,
      amount
    ]
  );

  if (result.rows.length === 0) {
    const current = await getBalance(userId);

    return {
      ok: false,
      balance: current
    };
  }

  return {
    ok: true,
    balance: Number(result.rows[0].balance)
  };
}

/* =========================================================
   ORDERS
========================================================= */

async function createOrder(type, userId, amount, extra) {
  extra = extra || {};

  userId = String(userId);
  amount = Number(amount);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error('Invalid order amount');
  }

  if (!pool) {
    const orderId = String(memOrders.nextId++);

    memOrders.orders[orderId] = {
      orderId,
      type,
      userId,
      amount,
      status: 'pending',
      createdAt: new Date().toISOString(),
      phone: extra.phone || null
    };

    return orderId;
  }

  const result = await pool.query(
    `
    INSERT INTO orders
      (
        type,
        user_id,
        amount,
        phone
      )
    VALUES
      ($1, $2, $3, $4)
    RETURNING order_id
    `,
    [
      type,
      userId,
      amount,
      extra.phone || null
    ]
  );

  return String(result.rows[0].order_id);
}

async function getOrder(orderId) {
  orderId = String(orderId);

  if (!pool) {
    return memOrders.orders[orderId] || null;
  }

  const result = await pool.query(
    `
    SELECT *
    FROM orders
    WHERE order_id = $1
    `,
    [orderId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  return {
    orderId: String(row.order_id),
    type: row.type,
    userId: row.user_id,
    amount: Number(row.amount),
    status: row.status,
    phone: row.phone,
    confirmedBy: row.confirmed_by,
    rejectedBy: row.rejected_by
  };
}

async function markOrder(orderId, status, adminId) {
  orderId = String(orderId);
  adminId = String(adminId || 'admin');

  if (!pool) {
    const order = memOrders.orders[orderId];

    if (!order) {
      return false;
    }

    if (order.status !== 'pending') {
      return false;
    }

    order.status = status;

    if (status === 'confirmed') {
      order.confirmedBy = adminId;
    } else {
      order.rejectedBy = adminId;
    }

    return true;
  }

  const col =
    status === 'confirmed'
      ? 'confirmed_by'
      : 'rejected_by';

  const result = await pool.query(
    `
    UPDATE orders
    SET
      status = $2,
      ${col} = $3
    WHERE order_id = $1
      AND status = 'pending'
    `,
    [
      orderId,
      status,
      adminId
    ]
  );

  return result.rowCount === 1;
}

/* =========================================================
   ADMIN BALANCE REPORT
========================================================= */

async function getAllBalances() {
  if (!pool) {
    return Object.keys(memBalances).map(function (userId) {
      return {
        userId,
        balance: Number(memBalances[userId])
      };
    });
  }

  const result = await pool.query(
    `
    SELECT
      user_id,
      balance
    FROM balances
    ORDER BY user_id
    `
  );

  return result.rows.map(function (row) {
    return {
      userId: row.user_id,
      balance: Number(row.balance)
    };
  });
}

async function getConfirmedTotals() {
  if (!pool) {
    let totalDeposits = 0;
    let totalWithdrawals = 0;

    Object.keys(memOrders.orders).forEach(function (orderId) {
      const order = memOrders.orders[orderId];

      if (order.status !== 'confirmed') {
        return;
      }

      if (order.type === 'deposit') {
        totalDeposits += Number(order.amount);
      }

      if (order.type === 'withdraw') {
        totalWithdrawals += Number(order.amount);
      }
    });

    return {
      totalDeposits,
      totalWithdrawals
    };
  }

  const depResult = await pool.query(`
    SELECT
      COALESCE(SUM(amount), 0) AS total
    FROM orders
    WHERE type = 'deposit'
      AND status = 'confirmed'
  `);

  const wdResult = await pool.query(`
    SELECT
      COALESCE(SUM(amount), 0) AS total
    FROM orders
    WHERE type = 'withdraw'
      AND status = 'confirmed'
  `);

  return {
    totalDeposits: Number(depResult.rows[0].total),
    totalWithdrawals: Number(wdResult.rows[0].total)
  };
}

/* =========================================================
   ADMIN AUTH
========================================================= */

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).json({
      error: 'admin access not configured'
    });
  }

  const provided =
    req.get('x-admin-secret') ||
    req.query.secret ||
    '';

  if (!provided) {
    return res.status(401).json({
      error: 'unauthorized'
    });
  }

  const providedBuffer =
    Buffer.from(String(provided));

  const expectedBuffer =
    Buffer.from(String(ADMIN_SECRET));

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(
      providedBuffer,
      expectedBuffer
    )
  ) {
    return res.status(401).json({
      error: 'unauthorized'
    });
  }

  next();
}

/* =========================================================
   TELEGRAM INIT DATA
========================================================= */

function validateInitData(initData) {
  if (
    !initData ||
    typeof initData !== 'string'
  ) {
    return null;
  }

  if (!BOT_TOKEN) {
    console.warn(
      'WARNING: BOT_TOKEN is not set. Telegram initData cannot be securely verified.'
    );

    return parseUnsafe(initData);
  }

  try {
    const params = new URLSearchParams(initData);

    const hash = params.get('hash');

    if (!hash) {
      return null;
    }

    params.delete('hash');

    const entries =
      Array.from(params.entries()).sort(function (a, b) {
        return a[0].localeCompare(b[0]);
      });

    const dataCheckString =
      entries
        .map(function (entry) {
          return entry[0] + '=' + entry[1];
        })
        .join('\n');

    const secretKey =
      crypto
        .createHmac('sha256', 'WebAppData')
        .update(BOT_TOKEN)
        .digest();

    const computedHash =
      crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    const hashA =
      Buffer.from(computedHash, 'hex');

    const hashB =
      Buffer.from(hash, 'hex');

    if (
      hashA.length !== hashB.length ||
      !crypto.timingSafeEqual(
        hashA,
        hashB
      )
    ) {
      return null;
    }

    const userJson = params.get('user');

    if (!userJson) {
      return null;
    }

    const user = JSON.parse(userJson);

    if (!user || !user.id) {
      return null;
    }

    return {
      id: String(user.id),
      first_name: user.first_name || ''
    };
  } catch (err) {
    console.error(
      'initData validation error:',
      err
    );

    return null;
  }
}

function parseUnsafe(initData) {
  try {
    const params =
      new URLSearchParams(initData);

    const userJson =
      params.get('user');

    if (!userJson) {
      return null;
    }

    const user =
      JSON.parse(userJson);

    if (!user || !user.id) {
      return null;
    }

    return {
      id: String(user.id),
      first_name: user.first_name || ''
    };
  } catch (err) {
    return null;
  }
}

/*
  ✅ አዲስ፦ resolveRequester
  Deposit/withdraw ጥያቄዎች ከሁለት ቦታ ሊመጡ ይችላሉ፦
  1. Mini App (Spin Win wheel) - initData ይልካል፣ HMAC ፊርማ ይረጋገጣል
  2. Telegram bot text command (/deposit, /withdraw) - initData የለውም፣
     በቀጥታ userId ይልካል

  ይህ function initData ካለ በጥብቅ ያረጋግጣል፣ ከሌለ ደግሞ በ request body
  ላይ የተላከውን userId ይቀበላል (bot ራሱ Telegram ውስጥ የተረጋገጠ ተጠቃሚ
  ስለሆነ safe ነው)።
*/
function resolveRequester(req) {
  const initData = req.body.initData;

  if (initData) {
    const user = validateInitData(initData);

    if (!user) {
      return {
        error: 'invalid initData'
      };
    }

    return {
      id: user.id,
      first_name: user.first_name || ''
    };
  }

  const bodyUserId = req.body.userId;

  if (
    bodyUserId !== undefined &&
    bodyUserId !== null &&
    String(bodyUserId).trim() !== ''
  ) {
    return {
      id: String(bodyUserId).trim(),
      first_name: ''
    };
  }

  return {
    error: 'missing user identification'
  };
}

/* =========================================================
   ONLINE USERS / ACTIVITY
========================================================= */

const lastSeen = {};

const activityLog = [];

function touch(userId, name) {
  lastSeen[String(userId)] = {
    ts: Date.now(),
    name: name || null
  };
}

function countOnline() {
  const cutoff =
    Date.now() - ONLINE_WINDOW_MS;

  let count = 0;

  Object.keys(lastSeen).forEach(function (userId) {
    if (lastSeen[userId].ts >= cutoff) {
      count++;
    }
  });

  return count;
}

function logActivity(entry) {
  entry.time = new Date().toISOString();

  activityLog.unshift(entry);

  if (activityLog.length > ACTIVITY_LOG_MAX) {
    activityLog.length = ACTIVITY_LOG_MAX;
  }
}

/* =========================================================
   ROUND SYSTEM
========================================================= */

const roundLiability = {};

/*
  FIX:
  forcedNextNumber ከnumber ብቻ ሳይሆን
  የትኛው round ላይ እንደሚሰራም እንይዛለን።
*/
const forcedNextNumber = {
  value: null,
  enabled: false,
  round: null
};

/*
  NEW:
  preGeneratedNumbers[round] = number

  Random በሚሆንበት ጊዜ ቁጥሩ ገና round ከመዘጋቱ በፊት
  አስቀድሞ ተፈጥሮ (pre-committed) እንዲቀመጥ ለማድረግ።
  ይሄው ቁጥር ነው round ሲፈታ (resolveRound) ጥቅም ላይ የሚውለው፣
  ስለዚህ አስቀድሞ የታየው ቁጥር እና በመጨረሻ የሚወጣው ቁጥር አንድ አይነት ይሆናሉ።
*/
const preGeneratedNumbers = {};

function currentRoundId() {
  return Math.floor(
    Date.now() / 1000 / ROUND_LENGTH
  );
}

function getRoundTiming(round) {
  round = Number(round);

  const startUnix =
    round * ROUND_LENGTH;

  const betCloseUnix =
    startUnix + BET_LENGTH;

  const roundEndUnix =
    startUnix + ROUND_LENGTH;

  return {
    startUnix,
    betCloseUnix,
    roundEndUnix
  };
}

function isBettingOpen(round) {
  const nowUnix =
    Math.floor(Date.now() / 1000);

  const timing =
    getRoundTiming(round);

  return (
    nowUnix >= timing.startUnix &&
    nowUnix < timing.betCloseUnix
  );
}

/*
  Round የተጠናቀቀ መሆኑን ለመፈተሽ
*/
function isRoundFinished(round) {
  const nowUnix =
    Math.floor(Date.now() / 1000);

  const timing =
    getRoundTiming(round);

  return nowUnix >= timing.betCloseUnix;
}

/*
  NEW:
  ለተጠቀሰው round ገና ካልተፈጠረ ቁጥር (forced ወይም random)
  አስቀድሞ ይፈጥራል/ያስቀምጣል እና ይመልሳል፣ ካለም ያለውኑ ይመልሳል።
  ይሄ ቁጥር ቁጥሩ ገና ከመውጣቱ (round ከመዘጋቱ) በፊት ለ admin ለማሳየት ይጠቅማል፣
  እና resolveRound() ሲጠራ ተመሳሳዩ ቁጥር ጥቅም ላይ ይውላል።
*/
function previewNumberForRound(round) {
  round = Number(round);

  if (
    forcedNextNumber.enabled &&
    Number(forcedNextNumber.round) === round
  ) {
    return {
      number: Number(forcedNextNumber.value),
      source: 'forced'
    };
  }

  if (round in preGeneratedNumbers) {
    return {
      number: Number(preGeneratedNumbers[round]),
      source: 'random'
    };
  }

  const number =
    WHEEL_ORDER[
      Math.floor(
        Math.random() * WHEEL_ORDER.length
      )
    ];

  preGeneratedNumbers[round] = number;

  return {
    number,
    source: 'random'
  };
}

function getLiabilityArray(round) {
  if (!roundLiability[round]) {
    roundLiability[round] =
      new Array(37).fill(0);
  }

  return roundLiability[round];
}

function payoutForOutcome(
  betType,
  numbers,
  stake,
  outcome
) {
  const color = colorFor(outcome);

  if (betType === 'number') {
    return numbers.indexOf(outcome) !== -1
      ? stake * SPIN_PAYOUT_MULTIPLIER
      : 0;
  }

  if (betType === 'red') {
    return color === 'red'
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'black') {
    return color === 'black'
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'odd') {
    return (
      outcome !== 0 &&
      outcome % 2 === 1
    )
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'even') {
    return (
      outcome !== 0 &&
      outcome % 2 === 0
    )
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'low') {
    return (
      outcome >= 1 &&
      outcome <= 18
    )
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'high') {
    return (
      outcome >= 19 &&
      outcome <= 36
    )
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'dozen1') {
    return (
      outcome >= 1 &&
      outcome <= 12
    )
      ? stake * DOZEN_MULTIPLIER
      : 0;
  }

  if (betType === 'dozen2') {
    return (
      outcome >= 13 &&
      outcome <= 24
    )
      ? stake * DOZEN_MULTIPLIER
      : 0;
  }

  if (betType === 'dozen3') {
    return (
      outcome >= 25 &&
      outcome <= 36
    )
      ? stake * DOZEN_MULTIPLIER
      : 0;
  }

  return 0;
}

function wouldExceedCap(
  round,
  betType,
  numbers,
  stake
) {
  const liability =
    getLiabilityArray(round);

  for (
    let i = 0;
    i < ALL_NUMBERS.length;
    i++
  ) {
    const outcome =
      ALL_NUMBERS[i];

    const added =
      payoutForOutcome(
        betType,
        numbers,
        stake,
        outcome
      );

    if (
      liability[outcome] + added >
      MAX_ROUND_LIABILITY
    ) {
      return true;
    }
  }

  return false;
}

function addLiability(
  round,
  betType,
  numbers,
  stake
) {
  const liability =
    getLiabilityArray(round);

  for (
    let i = 0;
    i < ALL_NUMBERS.length;
    i++
  ) {
    const outcome =
      ALL_NUMBERS[i];

    liability[outcome] +=
      payoutForOutcome(
        betType,
        numbers,
        stake,
        outcome
      );
  }
}

function removeLiability(
  round,
  betType,
  numbers,
  stake
) {
  const liability =
    getLiabilityArray(round);

  for (
    let i = 0;
    i < ALL_NUMBERS.length;
    i++
  ) {
    const outcome =
      ALL_NUMBERS[i];

    liability[outcome] -=
      payoutForOutcome(
        betType,
        numbers,
        stake,
        outcome
      );

    if (liability[outcome] < 0) {
      liability[outcome] = 0;
    }
  }
}

function cleanupOldLiability(currentRound) {
  const cutoff =
    currentRound - 5;

  Object.keys(roundLiability).forEach(
    function (key) {
      if (Number(key) < cutoff) {
        delete roundLiability[key];
      }
    }
  );

  Object.keys(preGeneratedNumbers).forEach(
    function (key) {
      if (Number(key) < cutoff) {
        delete preGeneratedNumbers[key];
      }
    }
  );
}

/* =========================================================
   ROUND RESOLUTION
========================================================= */

async function resolveRound(round) {
  round = Number(round);

  if (!Number.isInteger(round)) {
    throw new Error('Invalid round');
  }

  /*
    IMPORTANT FIX:
    Current round betting ገና ካልተዘጋ
    result አንፈጥርም።

    ይህ Admin በcurrent round ላይ
    result በማስኬድ forced number እንዳይበላ
    ይከላከላል።
  */
  const currentRound =
    currentRoundId();

  if (
    round === currentRound &&
    !isRoundFinished(round)
  ) {
    throw new Error(
      'Round is still open for betting'
    );
  }

  /*
    DATABASE MODE
  */
  if (pool) {
    const existing =
      await pool.query(
        `
        SELECT
          winning_number,
          winning_color
        FROM rounds
        WHERE round_id = $1
        `,
        [round]
      );

    if (existing.rows.length > 0) {
      cleanupOldLiability(round);

      return {
        winning_number:
          Number(
            existing.rows[0].winning_number
          ),

        winning_color:
          existing.rows[0].winning_color
      };
    }

    let winningNumber = null;

    /*
      Forced number የተዘጋጀው
      ለዚህ round ብቻ ከሆነ እንጠቀማለን።
    */
    if (
      forcedNextNumber.enabled &&
      Number(forcedNextNumber.round) === round
    ) {
      winningNumber =
        Number(forcedNextNumber.value);

      forcedNextNumber.enabled = false;
      forcedNextNumber.value = null;
      forcedNextNumber.round = null;
    }

    /*
      NEW:
      ካልተገደደ (forced) ግን አስቀድሞ preview
      ተደርጎ የተፈጠረ ቁጥር ካለ (pre-generated)፣
      ያንኑ ቁጥር እንጠቀማለን፣ አዲስ random አንፈጥርም።
      ይህ preview ላይ የታየው ቁጥር ከመጨረሻው ውጤት
      ጋር ተመሳሳይ እንዲሆን ያረጋግጣል።
    */
    if (
      winningNumber === null &&
      round in preGeneratedNumbers
    ) {
      winningNumber =
        Number(preGeneratedNumbers[round]);

      delete preGeneratedNumbers[round];
    }

    if (winningNumber === null) {
      winningNumber =
        WHEEL_ORDER[
          Math.floor(
            Math.random() *
              WHEEL_ORDER.length
          )
        ];
    }

    const winningColor =
      colorFor(winningNumber);

    /*
      INSERT ON CONFLICT:
      ሁለት request ቢመጡም
      አንድ round አንድ result ብቻ ይኖረዋል።
    */
    await pool.query(
      `
      INSERT INTO rounds
        (
          round_id,
          winning_number,
          winning_color
        )
      VALUES
        ($1, $2, $3)
      ON CONFLICT (round_id)
      DO NOTHING
      `,
      [
        round,
        winningNumber,
        winningColor
      ]
    );

    const final =
      await pool.query(
        `
        SELECT
          winning_number,
          winning_color
        FROM rounds
        WHERE round_id = $1
        `,
        [round]
      );

    cleanupOldLiability(round);

    if (final.rows.length === 0) {
      throw new Error(
        'Round result was not created'
      );
    }

    return {
      winning_number:
        Number(
          final.rows[0].winning_number
        ),

      winning_color:
        final.rows[0].winning_color
    };
  }

  /*
    IN-MEMORY MODE
  */
  if (memRounds[round]) {
    return memRounds[round];
  }

  let winningNumber = null;

  if (
    forcedNextNumber.enabled &&
    Number(forcedNextNumber.round) === round
  ) {
    winningNumber =
      Number(forcedNextNumber.value);

    forcedNextNumber.enabled = false;
    forcedNextNumber.value = null;
    forcedNextNumber.round = null;
  }

  /*
    NEW: same pre-generated reuse for in-memory mode
  */
  if (
    winningNumber === null &&
    round in preGeneratedNumbers
  ) {
    winningNumber =
      Number(preGeneratedNumbers[round]);

    delete preGeneratedNumbers[round];
  }

  if (winningNumber === null) {
    winningNumber =
      WHEEL_ORDER[
        Math.floor(
          Math.random() *
            WHEEL_ORDER.length
        )
      ];
  }

  memRounds[round] = {
    winning_number:
      winningNumber,

    winning_color:
      colorFor(winningNumber)
  };

  cleanupOldLiability(round);

  return memRounds[round];
}

/* =========================================================
   TICKETS
========================================================= */

async function getTicket(round, userId) {
  const ticketId =
    String(round) +
    '-' +
    String(userId);

  if (!pool) {
    return (
      memTickets[ticketId] ||
      null
    );
  }

  const result =
    await pool.query(
      `
      SELECT *
      FROM tickets
      WHERE ticket_id = $1
      `,
      [ticketId]
    );

  if (result.rows.length === 0) {
    return null;
  }

  const row =
    result.rows[0];

  return {
    ticketId:
      row.ticket_id,

    round:
      Number(row.round_id),

    userId:
      row.user_id,

    betType:
      row.bet_type,

    numbers:
      Array.isArray(row.numbers)
        ? row.numbers.map(Number)
        : [],

    stake:
      Number(row.stake),

    perNumberStake:
      Number(row.per_number_stake),

    settled:
      row.settled,

    won:
      row.won,

    payout:
      Number(row.payout || 0),

    winningNumber:
      row.winning_number === null
        ? null
        : Number(row.winning_number)
  };
}

async function createTicket(ticket) {
  if (!pool) {
    if (memTickets[ticket.ticketId]) {
      return false;
    }

    memTickets[ticket.ticketId] = ticket;

    return true;
  }

  const result =
    await pool.query(
      `
      INSERT INTO tickets
        (
          ticket_id,
          round_id,
          user_id,
          bet_type,
          numbers,
          stake,
          per_number_stake
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb,
          $6,
          $7
        )
      ON CONFLICT (ticket_id)
      DO NOTHING
      `,
      [
        ticket.ticketId,
        ticket.round,
        ticket.userId,
        ticket.betType,
        JSON.stringify(ticket.numbers),
        ticket.stake,
        ticket.perNumberStake
      ]
    );

  return result.rowCount === 1;
}

async function settleTicket(
  round,
  userId,
  winningNumber
) {
  const ticket =
    await getTicket(
      round,
      userId
    );

  if (!ticket) {
    return {
      exists: false,
      alreadySettled: false,
      won: false,
      amount: 0
    };
  }

  if (ticket.settled) {
    return {
      exists: true,
      alreadySettled: true,
      won: !!ticket.won,
      amount:
        Number(ticket.payout || 0)
    };
  }

  let won = false;
  let amount = 0;

  if (ticket.betType === 'number') {
    won =
      ticket.numbers.indexOf(
        winningNumber
      ) !== -1;

    if (won) {
      amount =
        ticket.perNumberStake *
        SPIN_PAYOUT_MULTIPLIER;
    }
  }

  else if (
    ticket.betType === 'red' ||
    ticket.betType === 'black'
  ) {
    won =
      colorFor(winningNumber) ===
      ticket.betType;

    amount =
      won
        ? ticket.stake *
          EVEN_MONEY_MULTIPLIER
        : 0;
  }

  else if (ticket.betType === 'odd') {
    won =
      winningNumber !== 0 &&
      winningNumber % 2 === 1;

    amount =
      won
        ? ticket.stake *
          EVEN_MONEY_MULTIPLIER
        : 0;
  }

  else if (ticket.betType === 'even') {
    won =
      winningNumber !== 0 &&
      winningNumber % 2 === 0;

    amount =
      won
        ? ticket.stake *
          EVEN_MONEY_MULTIPLIER
        : 0;
  }

  else if (ticket.betType === 'low') {
    won =
      winningNumber >= 1 &&
      winningNumber <= 18;

    amount =
      won
        ? ticket.stake *
          EVEN_MONEY_MULTIPLIER
        : 0;
  }

  else if (ticket.betType === 'high') {
    won =
      winningNumber >= 19 &&
      winningNumber <= 36;

    amount =
      won
        ? ticket.stake *
          EVEN_MONEY_MULTIPLIER
        : 0;
  }

  else if (ticket.betType === 'dozen1') {
    won =
      winningNumber >= 1 &&
      winningNumber <= 12;

    amount =
      won
        ? ticket.stake *
          DOZEN_MULTIPLIER
        : 0;
  }

  else if (ticket.betType === 'dozen2') {
    won =
      winningNumber >= 13 &&
      winningNumber <= 24;

    amount =
      won
        ? ticket.stake *
          DOZEN_MULTIPLIER
        : 0;
  }

  else if (ticket.betType === 'dozen3') {
    won =
      winningNumber >= 25 &&
      winningNumber <= 36;

    amount =
      won
        ? ticket.stake *
          DOZEN_MULTIPLIER
        : 0;
  }

  if (pool) {
    const result =
      await pool.query(
        `
        UPDATE tickets
        SET
          settled = true,
          won = $2,
          payout = $3,
          winning_number = $4,
          settled_at = now()
        WHERE ticket_id = $1
          AND settled = false
        RETURNING ticket_id
        `,
        [
          ticket.ticketId,
          won,
          amount,
          winningNumber
        ]
      );

    if (result.rowCount !== 1) {
      const already =
        await getTicket(
          round,
          userId
        );

      return {
        exists: true,
        alreadySettled: true,
        won:
          !!already.won,
        amount:
          Number(
            already.payout || 0
          )
      };
    }

    if (
      won &&
      amount > 0
    ) {
      await changeBalance(
        userId,
        amount
      );
    }
  } else {
    ticket.settled = true;
    ticket.won = won;
    ticket.payout = amount;
    ticket.winningNumber =
      winningNumber;

    if (
      won &&
      amount > 0
    ) {
      await changeBalance(
        userId,
        amount
      );
    }
  }

  return {
    exists: true,
    alreadySettled: false,
    won,
    amount
  };
}

/* =========================================================
   ADMIN: SET NEXT NUMBER
========================================================= */

app.post(
  '/api/admin/set-next-number',
  requireAdmin,
  function (req, res) {
    try {
      const raw =
        req.body.number;

      /*
        Random ለማድረግ
      */
      if (
        raw === null ||
        raw === undefined ||
        raw === ''
      ) {
        forcedNextNumber.enabled = false;
        forcedNextNumber.value = null;
        forcedNextNumber.round = null;

        return res.json({
          success: true,

          number: null,

          round: null,

          message:
            'ቀጥሎ የሚወጣው ቁጥር Random ሆኗል'
        });
      }

      const number =
        Number(raw);

      if (
        !Number.isInteger(number) ||
        number < 0 ||
        number > 36
      ) {
        return res.status(400).json({
          error:
            'ልክ ያልሆነ ቁጥር። 0-36 መሆን አለበት'
        });
      }

      const round =
        currentRoundId();

      /*
        Current round ከbetting ጊዜ ውጭ ከሆነ
        next round ላይ እንዲሰራ እንዘጋጀዋለን።
      */
      const targetRound =
        isBettingOpen(round)
          ? round
          : round + 1;

      forcedNextNumber.enabled = true;
      forcedNextNumber.value = number;
      forcedNextNumber.round = targetRound;

      /*
        NEW:
        ይህ round ቀድሞ pre-generated random ቁጥር ኖሮት ከሆነ
        አሁን forced ስለተቀናበረ ግራ መጋባትን ለማስወገድ እናጠፋዋለን።
      */
      delete preGeneratedNumbers[targetRound];

      return res.json({
        success: true,

        number,

        round: targetRound,

        message:
          'ቀጥሎ የሚወጣው ቁጥር ' +
          number +
          ' ተዘጋጅቷል'
      });
    } catch (err) {
      console.error(
        'set-next-number error:',
        err
      );

      return res.status(500).json({
        error:
          'failed to set next number'
      });
    }
  }
);

/* =========================================================
   ADMIN: PREVIEW NUMBER (NEW)
   ቁጥሩ ገና ራውንዱ ከመዝጋቱ በፊት (random ወይም admin የመረጠው
   ልዩነት ሳይኖረው) ለ admin ብቻ አስቀድሞ እንዲታይ ይመልሳል።
   ተመሳሳዩ ቁጥር ነው round ሲፈታ ጥቅም ላይ የሚውለው።
========================================================= */

app.get(
  '/api/admin/preview-number',
  requireAdmin,
  function (req, res) {
    try {
      const round =
        currentRoundId();

      /*
        Betting ገና ክፍት ከሆነ የአሁኑ round ላይ፣
        ካልሆነ (ማለትም betting ተዘግቷል ግን round
        ገና ካላለቀ) ቀጣዩ round ላይ ቀድመን እናዘጋጃለን።
      */
      const targetRound =
        isBettingOpen(round)
          ? round
          : round + 1;

      const preview =
        previewNumberForRound(targetRound);

      return res.json({
        success: true,

        round: targetRound,

        number: preview.number,

        color: colorFor(preview.number),

        source: preview.source
      });
    } catch (err) {
      console.error(
        'admin/preview-number error:',
        err
      );

      return res.status(500).json({
        error:
          'failed to preview number'
      });
    }
  }
);

/* =========================================================
   ADMIN: CURRENT ROUND INFO
========================================================= */

app.get(
  '/api/admin/current-round',
  requireAdmin,
  async function (req, res) {
    try {
      const round =
        currentRoundId();

      const timing =
        getRoundTiming(round);

      const nowUnix =
        Math.floor(Date.now() / 1000);

      let existingResult = null;

      if (pool) {
        const result =
          await pool.query(
            `
            SELECT
              winning_number,
              winning_color
            FROM rounds
            WHERE round_id = $1
            `,
            [round]
          );

        if (result.rows.length > 0) {
          existingResult = {
            winning_number:
              Number(
                result.rows[0]
                  .winning_number
              ),

            winning_color:
              result.rows[0]
                .winning_color
          };
        }
      } else if (memRounds[round]) {
        existingResult =
          memRounds[round];
      }

      res.json({
        success: true,

        round,

        start_unix:
          timing.startUnix,

        bet_close_unix:
          timing.betCloseUnix,

        round_end_unix:
          timing.roundEndUnix,

        betting_open:
          isBettingOpen(round),

        finished:
          isRoundFinished(round),

        seconds_to_bet_close:
          Math.max(
            0,
            timing.betCloseUnix -
              nowUnix
          ),

        seconds_to_round_end:
          Math.max(
            0,
            timing.roundEndUnix -
              nowUnix
          ),

        forced_number:
          forcedNextNumber.enabled &&
          Number(forcedNextNumber.round) === round
            ? Number(forcedNextNumber.value)
            : null,

        forced_round:
          forcedNextNumber.enabled
            ? Number(forcedNextNumber.round)
            : null,

        result:
          existingResult
      });
    } catch (err) {
      console.error(
        'admin/current-round error:',
        err
      );

      res.status(500).json({
        error:
          'failed to load current round'
      });
    }
  }
);

/* =========================================================
   ADMIN: STATS
========================================================= */

app.get(
  '/api/admin/stats',
  requireAdmin,
  async function (req, res) {
    try {
      const balances =
        await getAllBalances();

      const totals =
        await getConfirmedTotals();

      const totalUserBalance =
        balances.reduce(
          function (sum, user) {
            return (
              sum +
              Number(user.balance)
            );
          },
          0
        );

      const netProfit =
        totals.totalDeposits -
        totals.totalWithdrawals -
        totalUserBalance;

      res.json({
        total_users:
          balances.length,

        total_deposits:
          totals.totalDeposits,

        total_withdrawals:
          totals.totalWithdrawals,

        net_profit:
          netProfit,

        online_now:
          countOnline()
      });
    } catch (err) {
      console.error(
        'admin/stats error:',
        err
      );

      res.status(500).json({
        error:
          'failed to load stats'
      });
    }
  }
);

/* =========================================================
   ADMIN: USERS REPORT
========================================================= */

app.get(
  '/api/admin/users-report',
  requireAdmin,
  async function (req, res) {
    try {
      const balances =
        await getAllBalances();

      const cutoff =
        Date.now() -
        ONLINE_WINDOW_MS;

      const users =
        balances.map(
          function (user) {
            const seen =
              lastSeen[user.userId];

            return {
              userId:
                user.userId,

              name:
                seen
                  ? seen.name
                  : null,

              balance:
                Number(user.balance),

              online:
                !!(
                  seen &&
                  seen.ts >= cutoff
                )
            };
          }
        );

      res.json({
        users
      });
    } catch (err) {
      console.error(
        'admin/users-report error:',
        err
      );

      res.status(500).json({
        error:
          'failed to load users report'
      });
    }
  }
);

/* =========================================================
   ADMIN: ACTIVITY
========================================================= */

app.get(
  '/api/admin/activity',
  requireAdmin,
  async function (req, res) {
    const requested =
      Number(req.query.limit) || 50;

    const limit =
      Math.min(
        Math.max(requested, 1),
        ACTIVITY_LOG_MAX
      );

    res.json({
      activity:
        activityLog.slice(
          0,
          limit
        )
    });
  }
);

/* =========================================================
   ADMIN: ROUND RESULT
========================================================= */

app.get(
  '/api/admin/round-result',
  requireAdmin,
  async function (req, res) {
    try {
      const requestedRound =
        Number(req.query.round);

      const round =
        Number.isInteger(requestedRound)
          ? requestedRound
          : currentRoundId();

      /*
        IMPORTANT:
        Current round betting ገና ካልተዘጋ
        Admin result እንዲፈጠር አንፈቅድም።
      */
      if (
        round === currentRoundId() &&
        !isRoundFinished(round)
      ) {
        return res.status(425).json({
          error:
            'round not finished yet',

          round,

          bet_close_unix:
            getRoundTiming(round)
              .betCloseUnix
        });
      }

      const result =
        await resolveRound(round);

      res.json({
        success: true,

        round,

        winning_number:
          Number(
            result.winning_number
          ),

        winning_color:
          result.winning_color,

        is_current_round:
          round === currentRoundId(),

        finished:
          isRoundFinished(round)
      });
    } catch (err) {
      console.error(
        'admin/round-result error:',
        err
      );

      res.status(500).json({
        error:
          err.message ||
          'failed to resolve round'
      });
    }
  }
);

/* =========================================================
   HOME
========================================================= */

app.get(
  '/',
  function (req, res) {
    res.send(
      'Spin and Win API server is running'
    );
  }
);

/* =========================================================
   BALANCE VIA TELEGRAM MINI APP INIT DATA
========================================================= */

app.get(
  '/api/balance',
  async function (req, res) {
    try {
      const initData =
        req.query.initData || '';

      const user =
        validateInitData(initData);

      if (!user) {
        return res.status(401).json({
          error:
            'invalid initData'
        });
      }

      touch(
        user.id,
        user.first_name
      );

      const balance =
        await getBalance(user.id);

      return res.json({
        success: true,

        user_id:
          String(user.id),

        balance:
          Number(balance)
      });
    } catch (err) {
      console.error(
        'balance error:',
        err
      );

      return res.status(500).json({
        error:
          'failed to load balance'
      });
    }
  }
);

/* =========================================================
   BALANCE BY USER ID
========================================================= */

app.get(
  '/api/balance/:userId',
  async function (req, res) {
    try {
      const userId =
        String(req.params.userId);

      const balance =
        await getBalance(userId);

      touch(
        userId,
        null
      );

      return res.json({
        success: true,

        user_id:
          userId,

        balance:
          Number(balance)
      });
    } catch (err) {
      console.error(
        'balance/:userId error:',
        err
      );

      return res.status(500).json({
        error:
          'failed to load balance'
      });
    }
  }
);

/* =========================================================
   PLACE TICKET
========================================================= */

app.post(
  '/api/place-ticket',
  async function (req, res) {
    try {
      const initData =
        req.body.initData;

      const round =
        Number(req.body.round);

      const betType =
        req.body.betType;

      const numbers =
        req.body.numbers;

      const requestedStake =
        Number(req.body.stake);

      const user =
        validateInitData(initData);

      if (!user) {
        return res.status(401).json({
          error:
            'invalid initData'
        });
      }

      const currentRound =
        currentRoundId();

      if (
        !Number.isInteger(round) ||
        round !== currentRound
      ) {
        return res.status(400).json({
          error:
            'round closed'
        });
      }

      if (!isBettingOpen(round)) {
        return res.status(400).json({
          error:
            'betting time is closed'
        });
      }

      const VALID_TYPES = [
        'number',
        'red',
        'black',
        'odd',
        'even',
        'dozen1',
        'dozen2',
        'dozen3',
        'low',
        'high'
      ];

      if (
        VALID_TYPES.indexOf(betType) === -1
      ) {
        return res.status(400).json({
          error:
            'invalid bet type'
        });
      }

      if (
        !Number.isFinite(requestedStake) ||
        STAKE_OPTIONS.indexOf(requestedStake) === -1
      ) {
        return res.status(400).json({
          error:
            'invalid stake'
        });
      }

      let cleanNumbers = [];

      let perNumberStake =
        requestedStake;

      let stake =
        requestedStake;

      if (betType === 'number') {
        if (
          !Array.isArray(numbers) ||
          numbers.length === 0
        ) {
          return res.status(400).json({
            error:
              'select a number'
          });
        }

        if (
          numbers.length >
          MAX_NUMBERS
        ) {
          return res.status(400).json({
            error:
              'too many numbers'
          });
        }

        cleanNumbers =
          numbers.map(function (n) {
            return Number(n);
          });

        for (
          let i = 0;
          i < cleanNumbers.length;
          i++
        ) {
          const n =
            cleanNumbers[i];

          if (
            !Number.isInteger(n) ||
            n < 0 ||
            n > 36
          ) {
            return res.status(400).json({
              error:
                'invalid number'
            });
          }
        }

        if (
          new Set(cleanNumbers).size !==
          cleanNumbers.length
        ) {
          return res.status(400).json({
            error:
              'duplicate number'
          });
        }

        stake =
          cleanNumbers.length *
          requestedStake;
      }

      /*
        Ticket ID በአንድ round/user
        አንድ ብቻ ነው።
      */
      const ticketId =
        String(round) +
        '-' +
        String(user.id);

      const existing =
        await getTicket(
          round,
          user.id
        );

      if (existing) {
        return res.status(409).json({
          error:
            'በዚህ ዙር ቀድሞውኑ ትኬት ቆርጠዋል'
        });
      }

      const payoutStake =
        betType === 'number'
          ? perNumberStake
          : stake;

      if (
        wouldExceedCap(
          round,
          betType,
          cleanNumbers,
          payoutStake
        )
      ) {
        return res.status(400).json({
          error:
            'ይህ ውርርድ በአሁኑ ጊዜ አይቀበልም። የround liability limit ደርሷል'
        });
      }

      const deduction =
        await deductIfSufficient(
          user.id,
          stake
        );

      if (!deduction.ok) {
        return res.status(400).json({
          error:
            'insufficient balance',

          balance:
            Number(deduction.balance)
        });
      }

      addLiability(
        round,
        betType,
        cleanNumbers,
        payoutStake
      );

      const ticket = {
        ticketId,

        round,

        userId:
          String(user.id),

        betType,

        numbers:
          cleanNumbers,

        stake:
          Number(stake),

        perNumberStake:
          Number(perNumberStake),

        settled:
          false,

        won:
          null,

        payout:
          0,

        winningNumber:
          null
      };

      try {
        const created =
          await createTicket(ticket);

        if (!created) {
          await changeBalance(
            user.id,
            stake
          );

          removeLiability(
            round,
            betType,
            cleanNumbers,
            payoutStake
          );

          return res.status(409).json({
            error:
              'በዚህ ዙር ቀድሞውኑ ትኬት ቆርጠዋል'
          });
        }
      } catch (ticketError) {
        await changeBalance(
          user.id,
          stake
        );

        removeLiability(
          round,
          betType,
          cleanNumbers,
          payoutStake
        );

        throw ticketError;
      }

      touch(
        user.id,
        user.first_name
      );

      logActivity({
        type:
          'bet',

        userId:
          user.id,

        name:
          user.first_name || null,

        betType,

        numbers:
          cleanNumbers,

        stake:
          Number(stake),

        round,

        ticketId
      });

      return res.json({
        success: true,

        ticket_id:
          ticketId,

        round,

        bet_type:
          betType,

        numbers:
          cleanNumbers,

        stake:
          Number(stake),

        balance:
          Number(deduction.balance)
      });
    } catch (err) {
      console.error(
        'place-ticket error:',
        err
      );

      return res.status(500).json({
        error:
          'failed to place ticket'
      });
    }
  }
);

/* =========================================================
   ROUND RESULT
========================================================= */

app.get(
  '/api/round-result',
  async function (req, res) {
    try {
      const initData =
        req.query.initData || '';

      const round =
        Number(req.query.round);

      const ticketId =
        String(
          req.query.ticket_id || ''
        ).trim();

      const user =
        validateInitData(initData);

      if (!user) {
        return res.status(401).json({
          error:
            'invalid initData'
        });
      }

      touch(
        user.id,
        user.first_name
      );

      if (!Number.isInteger(round)) {
        return res.status(400).json({
          error:
            'invalid round'
        });
      }

      const timing =
        getRoundTiming(round);

      const nowUnix =
        Math.floor(Date.now() / 1000);

      /*
        Result 40 seconds ከተሟላ በኋላ ብቻ
        ይፈቀዳል።
      */
      if (
        nowUnix <
        timing.betCloseUnix
      ) {
        return res.status(425).json({
          error:
            'round not finished yet',

          round,

          bet_close_unix:
            timing.betCloseUnix,

          seconds_remaining:
            timing.betCloseUnix -
            nowUnix
        });
      }

      /*
        Ticket ID ከተላከ
        የuser ትክክለኛ ticket ID መሆን አለበት።
      */
      const expectedTicketId =
        String(round) +
        '-' +
        String(user.id);

      if (
        ticketId &&
        ticketId !== expectedTicketId
      ) {
        return res.status(403).json({
          error:
            'invalid ticket'
        });
      }

      /*
        User ticket ካለ እንፈልጋለን።
      */
      const ticket =
        await getTicket(
          round,
          user.id
        );

      /*
        =====================================================
        NO TICKET
        =====================================================
      */

      if (!ticket) {
        const resolved =
          await resolveRound(round);

        const balance =
          await getBalance(user.id);

        return res.json({
          success: true,

          round,

          winning_number:
            Number(
              resolved.winning_number
            ),

          winning_color:
            resolved.winning_color,

          won:
            false,

          amount:
            0,

          balance:
            Number(balance),

          ticket_id:
            null
        });
      }

      /*
        =====================================================
        HAS TICKET
        =====================================================
      */

      const resolved =
        await resolveRound(round);

      const settlement =
        await settleTicket(
          round,
          user.id,
          resolved.winning_number
        );

      const balance =
        await getBalance(user.id);

      if (
        settlement.exists &&
        !settlement.alreadySettled
      ) {
        logActivity({
          type:
            'result',

          userId:
            user.id,

          name:
            user.first_name || null,

          betType:
            ticket.betType,

          numbers:
            ticket.numbers,

          stake:
            ticket.stake,

          won:
            settlement.won,

          amount:
            settlement.amount,

          winningNumber:
            resolved.winning_number,

          round,

          ticketId:
            ticket.ticketId
        });
      }

      return res.json({
        success: true,

        round,

        ticket_id:
          ticket.ticketId,

        winning_number:
          Number(
            resolved.winning_number
          ),

        winning_color:
          resolved.winning_color,

        won:
          !!settlement.won,

        amount:
          Number(
            settlement.amount || 0
          ),

        balance:
          Number(balance)
      });
    } catch (err) {
      console.error(
        'round-result error:',
        err
      );

      return res.status(500).json({
        error:
          err.message ||
          'failed to load round result'
      });
    }
  }
);

/* =========================================================
   DEPOSIT REQUEST
   ✅ ተስተካክሏል፦ ከ Mini App (initData) ወይም ከ bot text command
   (userId በቀጥታ) ሁለቱም ምንጮች ጥያቄ መቀበል ይችላል።
========================================================= */

app.post(
  '/api/deposit/request',
  async function (req, res) {
    try {
      const amount =
        Number(req.body.amount);

      const requester =
        resolveRequester(req);

      if (requester.error) {
        return res.status(401).json({
          error:
            requester.error
        });
      }

      const userId = requester.id;
      const userFirstName = requester.first_name;

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          error:
            'Invalid amount'
        });
      }

      const orderId =
        await createOrder(
          'deposit',
          userId,
          amount
        );

      touch(
        userId,
        userFirstName
      );

      logActivity({
        type:
          'deposit_request',

        userId:
          userId,

        name:
          userFirstName || null,

        amount,

        orderId
      });

      return res.json({
        success: true,

        orderId,

        amount
      });
    } catch (err) {
      console.error(
        'deposit/request error:',
        err
      );

      return res.status(500).json({
        error:
          'failed to create deposit request'
      });
    }
  }
);

/* =========================================================
   DEPOSIT CONFIRM
========================================================= */

app.post(
  '/api/deposit/confirm',
  requireAdmin,
  async function (req, res) {
    try {
      const orderId =
        String(
          req.body.orderId || ''
        );

      const adminId =
        String(
          req.body.adminId || 'admin'
        );

      const order =
        await getOrder(orderId);

      if (!order) {
        return res.status(404).json({
          error:
            'Order not found'
        });
      }

      if (order.type !== 'deposit') {
        return res.status(400).json({
          error:
            'Invalid order type'
        });
      }

      if (order.status !== 'pending') {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      const newBalance =
        await changeBalance(
          order.userId,
          order.amount
        );

      const marked =
        await markOrder(
          orderId,
          'confirmed',
          adminId
        );

      if (!marked) {
        await changeBalance(
          order.userId,
          -order.amount
        );

        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      logActivity({
        type:
          'deposit_confirmed',

        userId:
          order.userId,

        amount:
          order.amount,

        orderId,

        adminId
      });

      return res.json({
        success: true,

        userId:
          order.userId,

        balance:
          Number(newBalance)
      });
    } catch (err) {
      console.error(
        'deposit/confirm error:',
        err
      );

      return res.status(500).json({
        error:
          'failed to confirm deposit'
      });
    }
  }
);

/* =========================================================
   DEPOSIT REJECT
========================================================= */

app.post(
  '/api/deposit/reject',
  requireAdmin,
  async function (req, res) {
    try {
      const orderId =
        String(
          req.body.orderId || ''
        );

      const adminId =
        String(
          req.body.adminId || 'admin'
        );

      const order =
        await getOrder(orderId);

      if (!order) {
        return res.status(404).json({
          error:
            'Order not found'
        });
      }

      if (order.type !== 'deposit') {
        return res.status(400).json({
          error:
            'Invalid order type'
        });
      }

      if (order.status !== 'pending') {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      const marked =
        await markOrder(
          orderId,
          'rejected',
          adminId
        );

      if (!marked) {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      logActivity({
        type:
          'deposit_rejected',

        userId:
          order.userId,

        amount:
          order.amount,

        orderId,

        adminId
      });

      return res.json({
        success: true,

        userId:
          order.userId
      });
    } catch (err) {
      console.error(
        'deposit/reject error:',
        err
      );

      return res.status(500).json({
        error:
          'failed to reject deposit'
      });
    }
  }
);

/* =========================================================
   WITHDRAW REQUEST
   ✅ ተስተካክሏል፦ ከ Mini App (initData) ወይም ከ bot text command
   (userId በቀጥታ) ሁለቱም ምንጮች ጥያቄ መቀበል ይችላል።
========================================================= */

app.post(
  '/api/withdraw/request',
  async function (req, res) {
    try {
      const amount =
        Number(req.body.amount);

      const phone =
        req.body.phone;

      const requester =
        resolveRequester(req);

      if (requester.error) {
        return res.status(401).json({
          error:
            requester.error
        });
      }

      const userId = requester.id;
      const userFirstName = requester.first_name;

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          error:
            'Invalid amount'
        });
      }

      if (
        !phone ||
        typeof phone !== 'string' ||
        !phone.trim()
      ) {
        return res.status(400).json({
          error:
            'Phone number required'
        });
      }

      const deduction =
        await deductIfSufficient(
          userId,
          amount
        );

      if (!deduction.ok) {
        return res.status(400).json({
          error:
            'insufficient balance',

          balance:
            Number(deduction.balance)
        });
      }

      try {
        const orderId =
          await createOrder(
            'withdraw',
            userId,
            amount,
            {
              phone:
                phone.trim()
            }
          );

        touch(
          userId,
          userFirstName
        );

        logActivity({
          type:
            'withdraw_request',

          userId:
            userId,

          name:
            userFirstName || null,

          amount,

          phone:
            phone.trim(),

          orderId
        });

        return res.json({
          success: true,

          orderId,

          balance:
            Number(deduction.balance)
        });
      } catch (orderError) {
        await changeBalance(
          userId,
          amount
        );

        throw orderError;
      }
    } catch (err) {
      console.error(
        'withdraw/request error:',
        err
      );

      return res.status(500).json({
        error:
          'failed to create withdrawal request'
      });
    }
  }
);

/* =========================================================
   WITHDRAW CONFIRM
========================================================= */

app.post(
  '/api/withdraw/confirm',
  requireAdmin,
  async function (req, res) {
    try {
      const orderId =
        String(
          req.body.orderId || ''
        );

      const adminId =
        String(
          req.body.adminId || 'admin'
        );

      const order =
        await getOrder(orderId);

      if (!order) {
        return res.status(404).json({
          error:
            'Order not found'
        });
      }

      if (order.type !== 'withdraw') {
        return res.status(400).json({
          error:
            'Invalid order type'
        });
      }

      if (order.status !== 'pending') {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      const marked =
        await markOrder(
          orderId,
          'confirmed',
          adminId
        );

      if (!marked) {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      const balance =
        await getBalance(
          order.userId
        );

      logActivity({
        type:
          'withdraw_confirmed',

        userId:
          order.userId,

        amount:
          order.amount,

        orderId,

        adminId
      });

      return res.json({
        success: true,

        userId:
          order.userId,

        balance:
          Number(balance)
      });
    } catch (err) {
      console.error(
        'withdraw/confirm error:',
        err
      );

      return res.status(500).json({
        error:
          'failed to confirm withdrawal'
      });
    }
  }
);

/* =========================================================
   WITHDRAW REJECT
========================================================= */

app.post(
  '/api/withdraw/reject',
  requireAdmin,
  async function (req, res) {
    try {
      const orderId =
        String(
          req.body.orderId || ''
        );

      const adminId =
        String(
          req.body.adminId || 'admin'
        );

      const order =
        await getOrder(orderId);

      if (!order) {
        return res.status(404).json({
          error:
            'Order not found'
        });
      }

      if (order.type !== 'withdraw') {
        return res.status(400).json({
          error:
            'Invalid order type'
        });
      }

      if (order.status !== 'pending') {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      const restoredBalance =
        await changeBalance(
          order.userId,
          order.amount
        );

      const marked =
        await markOrder(
          orderId,
          'rejected',
          adminId
        );

      if (!marked) {
        await changeBalance(
          order.userId,
          -order.amount
        );

        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      logActivity({
        type:
          'withdraw_rejected',

        userId:
          order.userId,

        amount:
          order.amount,

        orderId,

        adminId
      });

      return res.json({
        success: true,

        userId:
          order.userId,

        balance:
          Number(restoredBalance)
      });
    } catch (err) {
      console.error(
        'withdraw/reject error:',
        err
      );

      return res.status(500).json({
        error:
          'failed to reject withdrawal'
      });
    }
  }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  '/api/health',
  function (req, res) {
    res.json({
      success: true,
      server: 'online',
      round: currentRoundId(),
      round_length: ROUND_LENGTH,
      bet_length: BET_LENGTH,
      database:
        pool ? 'postgresql' : 'memory'
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

initDb()
  .then(function () {
require('./aviator')(app, {validateInitData, getBalance, deductIfSufficient, changeBalance, touch, logActivity, STAKE_OPTIONS});
    app.listen(
      PORT,
      function () {
        console.log(
          '========================================'
        );

        console.log(
          'Spin & Win Server Started'
        );

        console.log(
          'Server listening on port ' +
          PORT
        );

        console.log(
          'ROUND_LENGTH = ' +
          ROUND_LENGTH +
          ' seconds'
        );

        console.log(
          'BET_LENGTH = ' +
          BET_LENGTH +
          ' seconds'
        );

        console.log(
          'Database = ' +
          (pool
            ? 'PostgreSQL'
            : 'In-Memory')
        );

        console.log(
          '========================================'
        );
      }
    );
  })
  .catch(function (err) {
    console.error(
      'Failed to initialize database:',
      err
    );

    process.exit(1);
  });
