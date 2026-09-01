/* Broker — orders, fills, position and account state.
 *
 * This is the shared floor under both ways of using Midori: in replay a human
 * clicks buy, in a backtest a strategy calls ctx.buy(). Both end up here, so a
 * result produced by hand and one produced by a bot are directly comparable.
 *
 * The intrabar problem
 * --------------------
 * On a 1h chart, a bar that touches both the stop and the target tells you
 * nothing about which came first. Most backtesters guess — usually by assuming
 * the stop hit first, which is honest but pessimistic, or the target, which
 * quietly inflates every result.
 *
 * Midori does not have to guess. It stores 1m bars for everything, so a fill on
 * a 1h bar is resolved by walking that hour's sixty minutes in order and taking
 * whichever level is reached first. `subBars` carries those minutes.
 *
 * Where no finer data exists — a strategy running on the 1m base timeframe —
 * the order of events inside the minute is genuinely unknowable, and the
 * pessimistic rule applies: the fill that hurts the position happens first.
 * `fill.resolution` records which of the two applied, so a result can always
 * be traced back to how it was decided.
 *
 * Why this is in shared/ and not beside the backtest engine
 * ---------------------------------------------------------
 * Because replay is the other half of the sentence at the top. A backtest runs
 * in the main process, where the bars already are; a replay runs in the
 * renderer, because a click has to become an order and a drawn chart in the
 * same frame rather than after a round trip. Both need this class, and the
 * renderer cannot reach into electron/ — so the class that both of them stand
 * on belongs where both of them can import it, which is here.
 *
 * There are no Node imports below, and there must not be: this file is bundled
 * into the renderer.
 */

let nextId = 1;

export const SIDE = { BUY: 'buy', SELL: 'sell' };

/** Costs are per-instrument and belong to the account, not to an order. */
export const DEFAULT_COSTS = {
  /** Round-trip commission per side, as a fraction of notional. 0.001 = 0.1%. */
  feeRate: 0.001,
  /** Full bid/ask spread as a fraction of price. Half is paid on each side. */
  spreadPct: 0.0002,
  /** Extra adverse move on market and triggered stop orders. */
  slippagePct: 0.0002,
};

export class Broker {
  /**
   * @param {object} [options]
   * @param {number} [options.balance=10000]  starting cash, in quote currency
   * @param {object} [options.costs]          overrides for DEFAULT_COSTS
   */
  constructor(options = {}) {
    const { balance = 10_000, costs = {} } = options;

    if (!(balance > 0)) throw new Error(`Broker: starting balance must be positive, got ${balance}`);

    this.initialBalance = balance;
    this.balance = balance;
    this.costs = { ...DEFAULT_COSTS, ...costs };

    for (const key of ['feeRate', 'spreadPct', 'slippagePct']) {
      const v = this.costs[key];
      if (!Number.isFinite(v) || v < 0) throw new Error(`Broker: ${key} must be a number >= 0, got ${v}`);
    }

    /** @type {Array<object>} orders still waiting to fill */
    this.pending = [];
    /** @type {Array<object>} every order ever placed, in order */
    this.orders = [];
    /** @type {Array<object>} every fill, in order */
    this.fills = [];
    /** @type {Array<object>} closed round trips */
    this.trades = [];

    /** Net position. size > 0 is long, < 0 is short, 0 is flat. */
    this.position = null;

    this.time = null;      // current bar time
    this.lastPrice = null; // last close seen, for mark-to-market
  }

  /* ─── Account ─────────────────────────────────────────────────────────── */

  /** Cash plus the open position's unrealised result. */
  get equity() {
    return this.balance + this.unrealizedPnl;
  }

  get unrealizedPnl() {
    if (!this.position || this.lastPrice == null) return 0;
    return (this.lastPrice - this.position.entryPrice) * this.position.size;
  }

  get isFlat() {
    return this.position === null;
  }

  /* ─── Order placement ─────────────────────────────────────────────────── */

  /**
   * Places an order. It never fills on the bar that placed it — the earliest
   * possible fill is the next bar, which is what stops a strategy from trading
   * on a close it could not have known in time.
   *
   * @param {object} spec
   * @param {'buy'|'sell'} spec.side
   * @param {'market'|'limit'|'stop'} [spec.type='market']
   * @param {number} spec.size            in base units, always positive
   * @param {number} [spec.limitPrice]    required for limit orders
   * @param {number} [spec.stopPrice]     required for stop orders
   * @param {boolean} [spec.reduceOnly]   may only shrink an open position
   * @param {string} [spec.tag]           free label, e.g. 'stop-loss'
   * @param {number} [spec.parentId]      cancelled together with its siblings
   * @param {object} [spec.bracket]       protection to attach the moment it
   *   fills — see `_attachBracket`. Each leg is either an absolute price
   *   (`stopLoss`, `takeProfit`) or a distance from the fill (`stopDistance`,
   *   `targetDistance`), never both.
   */
  placeOrder(spec) {
    const {
      side, type = 'market', size, limitPrice, stopPrice,
      reduceOnly = false, tag = null, parentId = null, bracket = null,
    } = spec;

    if (side !== SIDE.BUY && side !== SIDE.SELL) {
      throw new Error(`placeOrder: side must be "buy" or "sell", got ${JSON.stringify(side)}`);
    }
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(`placeOrder: size must be a positive number, got ${size}`);
    }
    if (type === 'limit' && !Number.isFinite(limitPrice)) {
      throw new Error('placeOrder: a limit order needs a limitPrice');
    }
    if (type === 'stop' && !Number.isFinite(stopPrice)) {
      throw new Error('placeOrder: a stop order needs a stopPrice');
    }
    if (!['market', 'limit', 'stop'].includes(type)) {
      throw new Error(`placeOrder: unknown order type "${type}"`);
    }
    if (bracket) validateBracket(bracket);

    const order = {
      id: nextId++,
      side,
      type,
      size,
      limitPrice: limitPrice ?? null,
      stopPrice: stopPrice ?? null,
      reduceOnly,
      tag,
      parentId,
      /* Attached on fill rather than now. Null on every order that carries no
       * protection, which is most of them. */
      bracket: bracket ?? null,
      status: 'pending',
      placedAt: this.time,
      filledAt: null,
      fillPrice: null,
      fee: null,
    };

    this.orders.push(order);
    this.pending.push(order);
    return order;
  }

  cancelOrder(id) {
    const i = this.pending.findIndex((o) => o.id === id);
    if (i === -1) return false;
    const [order] = this.pending.splice(i, 1);
    order.status = 'cancelled';
    return true;
  }

  /** Cancels every pending order, optionally only those with a given tag. */
  cancelAll(tag = null) {
    const keep = [];
    for (const order of this.pending) {
      if (tag === null || order.tag === tag) order.status = 'cancelled';
      else keep.push(order);
    }
    const cancelled = this.pending.length - keep.length;
    this.pending = keep;
    return cancelled;
  }

  /**
   * Market entry with optional protective orders attached. The stop and target
   * are placed immediately and cancel each other when one of them fills, so a
   * position is never left with a stray order behind it.
   */
  submitEntry({ side, size, stopLoss, takeProfit, tag = null }) {
    // Catch a bad protective level here, where the caller can still see which
    // of the two it was, rather than inside the generic order validation.
    if (stopLoss != null && !Number.isFinite(stopLoss)) {
      throw new Error(`submitEntry: stopLoss must be a finite number, got ${stopLoss}`);
    }
    if (takeProfit != null && !Number.isFinite(takeProfit)) {
      throw new Error(`submitEntry: takeProfit must be a finite number, got ${takeProfit}`);
    }

    const entry = this.placeOrder({ side, size, type: 'market', tag });
    /* Remembered on the entry order so the closed trade can carry them. The
     * protective orders themselves are gone by then — one filled, the other was
     * cancelled — and a review that wants to draw the bracket would otherwise
     * have to reconstruct it from an order log nothing stores. */
    entry.stopLoss = stopLoss ?? null;
    entry.takeProfit = takeProfit ?? null;
    const exitSide = side === SIDE.BUY ? SIDE.SELL : SIDE.BUY;

    if (stopLoss != null) {
      this.placeOrder({
        side: exitSide, size, type: 'stop', stopPrice: stopLoss,
        reduceOnly: true, tag: 'stop-loss', parentId: entry.id,
      });
    }
    if (takeProfit != null) {
      this.placeOrder({
        side: exitSide, size, type: 'limit', limitPrice: takeProfit,
        reduceOnly: true, tag: 'take-profit', parentId: entry.id,
      });
    }
    return entry;
  }

  /** Closes the whole position at market. */
  closePosition(tag = 'close') {
    if (!this.position) return null;
    const side = this.position.size > 0 ? SIDE.SELL : SIDE.BUY;
    return this.placeOrder({
      side, size: Math.abs(this.position.size), type: 'market', reduceOnly: true, tag,
    });
  }

  /* ─── Bar processing ──────────────────────────────────────────────────── */

  /**
   * Advances the broker by one bar: fills what this bar makes fillable, then
   * marks the position to the close.
   *
   * @param {object} bar               the strategy-timeframe bar
   * @param {Array<object>} [subBars]  the 1m bars inside it, in order
   */
  processBar(bar, subBars = null) {
    this.time = bar.time;

    if (this.pending.length > 0) {
      // With sub-bars the sequence inside the bar is known and fills happen in
      // real order. Without them, one pass over the bar decides everything.
      const steps = subBars && subBars.length > 0 ? subBars : [bar];
      const resolution = steps === subBars ? 'intrabar' : 'pessimistic';

      for (const step of steps) {
        if (this.pending.length === 0) break;
        this._fillAgainst(step, resolution);
      }
    }

    this.lastPrice = bar.close;
  }

  /** Runs every pending order against one price step. */
  _fillAgainst(step, resolution) {
    // Snapshot: a fill can cancel siblings, and that must not disturb this pass.
    const candidates = [...this.pending];
    const triggered = [];

    for (const order of candidates) {
      if (order.status !== 'pending') continue;
      const price = this._triggerPrice(order, step);
      if (price === null) continue;
      triggered.push({ order, price });
    }

    if (triggered.length === 0) return;

    /* Two orders triggering in the same step is exactly the ambiguous case.
     * Without sub-bars, settle it against the position: the order that hurts
     * fills first. Never in the strategy's favour — that is how a backtest
     * starts flattering itself. */
    if (triggered.length > 1 && resolution === 'pessimistic') {
      triggered.sort((a, b) => this._adverseRank(b.order, b.price) - this._adverseRank(a.order, a.price));
    }

    for (const { order, price } of triggered) {
      if (order.status !== 'pending') continue; // cancelled by an earlier fill
      this._executeOrder(order, price, step, resolution);
    }
  }

  /**
   * The price at which an order becomes fillable within this step, or null.
   *
   * A gap through the level fills at the open, not at the level — that is the
   * whole point of a gap, and pretending otherwise understates risk.
   */
  _triggerPrice(order, step) {
    switch (order.type) {
      case 'market':
        return step.open;

      case 'limit':
        if (order.side === SIDE.BUY) {
          if (step.open <= order.limitPrice) return step.open; // gapped below: better fill
          return step.low <= order.limitPrice ? order.limitPrice : null;
        }
        if (step.open >= order.limitPrice) return step.open;
        return step.high >= order.limitPrice ? order.limitPrice : null;

      case 'stop':
        if (order.side === SIDE.BUY) {
          if (step.open >= order.stopPrice) return step.open; // gapped through
          return step.high >= order.stopPrice ? order.stopPrice : null;
        }
        if (step.open <= order.stopPrice) return step.open;
        return step.low <= order.stopPrice ? order.stopPrice : null;

      default:
        throw new Error(`Unknown order type: ${order.type}`);
    }
  }

  /** How bad this fill is for the current position — higher fills first. */
  _adverseRank(order, price) {
    if (!this.position) return 0;
    const closing = Math.sign(this.position.size) !== (order.side === SIDE.BUY ? 1 : -1);
    if (!closing) return 0;
    // Closing a long lower is worse; closing a short higher is worse.
    return this.position.size > 0 ? -price : price;
  }

  _executeOrder(order, rawPrice, step, resolution) {
    const { spreadPct, slippagePct, feeRate } = this.costs;
    const dir = order.side === SIDE.BUY ? 1 : -1;

    // Half the spread is paid on every fill; slippage only where the fill is
    // taken at whatever the market offers.
    const takesLiquidity = order.type === 'market' || order.type === 'stop';
    const cost = spreadPct / 2 + (takesLiquidity ? slippagePct : 0);
    const fillPrice = rawPrice * (1 + dir * cost);

    let size = order.size;
    if (order.reduceOnly) {
      const open = this.position ? Math.abs(this.position.size) : 0;
      if (open === 0) {
        // The position is already gone — this is the sibling of a filled exit.
        this._removePending(order);
        order.status = 'cancelled';
        return;
      }
      size = Math.min(size, open);
    }

    const notional = size * fillPrice;
    const fee = notional * feeRate;

    order.status = 'filled';
    order.filledAt = step.time ?? this.time;
    order.fillPrice = fillPrice;
    order.fee = fee;
    this._removePending(order);

    this.balance -= fee;

    const fill = {
      orderId: order.id,
      time: order.filledAt,
      side: order.side,
      size,
      price: fillPrice,
      fee,
      tag: order.tag,
      resolution,
      /* Carried from the entry order, where submitEntry recorded them, so the
       * position and then the closed trade can keep the bracket. Null on every
       * fill that is not an entry, which is what a stop or target fill is. */
      stopLoss: order.stopLoss ?? null,
      takeProfit: order.takeProfit ?? null,
    };
    this.fills.push(fill);

    this._applyToPosition(fill);

    // Protection an entry was carrying goes in now that there is a position.
    if (order.bracket) this._attachBracket(order, fill);

    // A filled bracket leg retires its siblings.
    if (order.parentId != null || order.tag === 'stop-loss' || order.tag === 'take-profit') {
      this._cancelSiblings(order);
    }
  }

  /**
   * Places the stop and target an entry was carrying, now that it has filled.
   *
   * Why this exists at all
   * ----------------------
   * `submitEntry` can place a bracket up front because a market entry fills on
   * the very next bar. A *resting* entry cannot: a stop and a target sitting in
   * the market against a position that does not exist yet would either open a
   * trade in the wrong direction, or — being reduceOnly — quietly cancel
   * themselves the first time price reached one of them, leaving the entry to
   * fill later with nothing behind it.
   *
   * So the levels ride along on the order and become real orders here, at the
   * moment the position does. That is also what an exchange does with an
   * attached OCO.
   *
   * When they become live
   * ---------------------
   * `_fillAgainst` snapshots the pending orders before it starts, so these are
   * not considered on the step that placed them — they are live from the next
   * one. With sub-bars that is the next minute of the same bar, which is close
   * to how quickly real protection arms. Without them it is the next bar, and
   * on that one bar the trade is unprotected in its own favour. That is the
   * same one-step delay every order in this engine is subject to, and the fill
   * still records the resolution it was decided under.
   *
   * Distances, not just levels
   * --------------------------
   * A leg given as a distance is measured from the price this actually filled
   * at, spread and slippage included, so a plan drawn as "risk 500" costs 500
   * however far the market gapped on the way in. A leg given as a price is used
   * as it stands. The two forms are mutually exclusive per leg — see
   * `validateBracket`.
   */
  _attachBracket(order, fill) {
    const position = this.position;
    // Nothing opened — a reduceOnly fill, or one that closed out instead.
    if (!position) return;

    const long = position.size > 0;
    const dir = long ? 1 : -1;
    const { stopLoss, takeProfit, stopDistance, targetDistance } = order.bracket;

    const stop = stopLoss ?? (stopDistance == null ? null : fill.price - dir * stopDistance);
    const target = takeProfit ?? (targetDistance == null ? null : fill.price + dir * targetDistance);
    if (stop == null && target == null) return;

    const exitSide = long ? SIDE.SELL : SIDE.BUY;
    const size = fill.size;

    /* Both under the entry's id, so whichever fills retires the other — the
     * same grouping submitEntry uses, and the reason a position is never left
     * with a stray order behind it. */
    if (stop != null) {
      this.placeOrder({
        side: exitSide, size, type: 'stop', stopPrice: stop,
        reduceOnly: true, tag: 'stop-loss', parentId: order.id,
      });
    }
    if (target != null) {
      this.placeOrder({
        side: exitSide, size, type: 'limit', limitPrice: target,
        reduceOnly: true, tag: 'take-profit', parentId: order.id,
      });
    }

    /* The position keeps them too, because that is what the closed trade
     * carries and what a review draws the bracket from. */
    position.stopLoss = stop;
    position.takeProfit = target;
  }

  _removePending(order) {
    const i = this.pending.indexOf(order);
    if (i !== -1) this.pending.splice(i, 1);
  }

  _cancelSiblings(order) {
    const group = order.parentId ?? order.id;
    for (const other of [...this.pending]) {
      if (other.id === order.id) continue;
      if ((other.parentId ?? other.id) === group) {
        this._removePending(other);
        other.status = 'cancelled';
      }
    }
  }

  /** Applies a fill to the net position, realising P&L on the closed part. */
  _applyToPosition(fill) {
    const signed = fill.side === SIDE.BUY ? fill.size : -fill.size;

    if (!this.position) {
      this.position = {
        size: signed,
        entryPrice: fill.price,
        openedAt: fill.time,
        fees: fill.fee,
        entryFills: [fill],
        stopLoss: fill.stopLoss ?? null,
        takeProfit: fill.takeProfit ?? null,
        /* What the entry order was tagged with, carried to the closed trade.
         * Without it a finished trade only says how it ended — stop or target —
         * and never why it was taken, so a run cannot be broken down by
         * whatever the strategy grouped its entries under. */
        entryTag: fill.tag ?? null,
      };
      return;
    }

    const pos = this.position;
    const sameDirection = Math.sign(pos.size) === Math.sign(signed);

    if (sameDirection) {
      // Adding: the entry becomes the size-weighted average.
      const totalSize = pos.size + signed;
      pos.entryPrice = (pos.entryPrice * pos.size + fill.price * signed) / totalSize;
      pos.size = totalSize;
      pos.fees += fill.fee;
      pos.entryFills.push(fill);
      return;
    }

    // Reducing or reversing.
    const closing = Math.min(Math.abs(signed), Math.abs(pos.size));
    const closedSize = closing * Math.sign(pos.size);
    const pnl = (fill.price - pos.entryPrice) * closedSize;

    this.balance += pnl;
    pos.fees += fill.fee;

    const remaining = pos.size + signed;

    this.trades.push({
      side: pos.size > 0 ? 'long' : 'short',
      size: closing,
      entryPrice: pos.entryPrice,
      exitPrice: fill.price,
      openedAt: pos.openedAt,
      closedAt: fill.time,
      pnl,
      fees: pos.fees,
      netPnl: pnl - pos.fees,
      entryTag: pos.entryTag ?? null,
      stopLoss: pos.stopLoss ?? null,
      takeProfit: pos.takeProfit ?? null,
      exitTag: fill.tag,
    });

    if (remaining === 0) {
      this.position = null;
      return;
    }

    if (Math.sign(remaining) !== Math.sign(pos.size)) {
      // Reversed: what is left opens a fresh position in the other direction.
      this.position = {
        size: remaining,
        entryPrice: fill.price,
        openedAt: fill.time,
        fees: 0,
        entryFills: [fill],
        stopLoss: fill.stopLoss ?? null,
        takeProfit: fill.takeProfit ?? null,
        entryTag: fill.tag ?? null,
      };
    } else {
      pos.size = remaining;
      pos.fees = 0; // fees up to here are settled with the closed trade
    }
  }
}

/**
 * Checks a bracket before it is stored on an order.
 *
 * Refused here rather than at the fill, because that is the only moment the
 * caller can still see which of its own numbers was wrong. A bracket that
 * failed silently would leave an entry to fill hours later with no protection
 * behind it and nothing to say why.
 */
function validateBracket(bracket) {
  if (typeof bracket !== 'object') {
    throw new Error(`placeOrder: bracket must be an object, got ${typeof bracket}`);
  }

  const legs = [
    ['stopLoss', 'stopDistance'],
    ['takeProfit', 'targetDistance'],
  ];

  for (const [priceKey, distanceKey] of legs) {
    const price = bracket[priceKey];
    const distance = bracket[distanceKey];

    if (price != null && distance != null) {
      throw new Error(
        `placeOrder: give ${priceKey} or ${distanceKey}, not both — `
        + 'a level and an offset to the same level cannot both be the answer',
      );
    }
    if (price != null && !Number.isFinite(price)) {
      throw new Error(`placeOrder: ${priceKey} must be a finite number, got ${price}`);
    }
    if (distance != null && !(distance > 0)) {
      throw new Error(`placeOrder: ${distanceKey} must be a positive number, got ${distance}`);
    }
  }
}

/** Resets order ids — tests need runs to be reproducible. */
export function resetOrderIds() {
  nextId = 1;
}
