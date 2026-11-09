import { describe, it } from "node:test";
import assert from "node:assert";
import {
  GaiaSignalFsm,
  GaiaBarData,
  computeCausalEquilibriumDispersion,
} from "../gaiaSignalFsm";

describe("Gaia Signal FSM Non-Repainting Invariants", () => {
  it("Transitions from STAND_ASIDE to LONG on positive equilibrium excursion in Bull Macro", () => {
    const fsm = new GaiaSignalFsm();

    // 5 pre-market bars for dispersion baseline + 1 RTH breakout bar at 9:30 AM (etMins: 570)
    const bars: GaiaBarData[] = [
      { barTimestamp: 1000, open: 760, high: 761, low: 759.5, close: 760.2, chi: 0.52, bias: 0.05, netFlux: 0.02, peclet: 0.5, etMins: 550, isClosed: true },
      { barTimestamp: 1300, open: 760.2, high: 760.8, low: 759.8, close: 760.5, chi: 0.51, bias: 0.03, netFlux: 0.01, peclet: 0.4, etMins: 555, isClosed: true },
      { barTimestamp: 1600, open: 760.5, high: 761.2, low: 760.0, close: 760.9, chi: 0.53, bias: 0.08, netFlux: 0.04, peclet: 0.6, etMins: 560, isClosed: true },
      { barTimestamp: 1900, open: 760.9, high: 761.5, low: 760.4, close: 761.0, chi: 0.52, bias: 0.06, netFlux: 0.03, peclet: 0.5, etMins: 565, isClosed: true },
      { barTimestamp: 2200, open: 761.0, high: 763.5, low: 760.8, close: 763.0, chi: 0.65, bias: 0.35, netFlux: 0.25, peclet: 2.1, etMins: 570, isClosed: true },
    ];

    const { newlyCommitted, snapshot } = fsm.commitSeries(bars, {
      macroRegime: "CALL",
      callDominancePct: 65,
    });

    assert.strictEqual(newlyCommitted.length, 1, "Exactly 1 transition must be emitted on RTH breakout");
    assert.strictEqual(newlyCommitted[0].fromState, "STAND_ASIDE");
    assert.strictEqual(newlyCommitted[0].toState, "LONG");
    assert.strictEqual(newlyCommitted[0].price, 763.0);
    assert.strictEqual(newlyCommitted[0].idempotencyKey, "2200_LONG");
    assert.strictEqual(snapshot.committedState, "LONG");
  });

  it("Transitions from STAND_ASIDE to SHORT on negative equilibrium excursion in Bear Macro", () => {
    const fsm = new GaiaSignalFsm();

    const bars: GaiaBarData[] = [
      { barTimestamp: 1000, open: 765, high: 765.5, low: 764.5, close: 765.0, chi: 0.48, bias: -0.05, netFlux: -0.02, peclet: 0.5, etMins: 550, isClosed: true },
      { barTimestamp: 1300, open: 765.0, high: 765.2, low: 764.2, close: 764.5, chi: 0.49, bias: -0.03, netFlux: -0.01, peclet: 0.4, etMins: 555, isClosed: true },
      { barTimestamp: 1600, open: 764.5, high: 764.8, low: 763.8, close: 764.0, chi: 0.47, bias: -0.08, netFlux: -0.04, peclet: 0.6, etMins: 560, isClosed: true },
      { barTimestamp: 1900, open: 764.0, high: 764.2, low: 763.2, close: 763.5, chi: 0.48, bias: -0.06, netFlux: -0.03, peclet: 0.5, etMins: 565, isClosed: true },
      { barTimestamp: 2200, open: 763.5, high: 763.8, low: 761.0, close: 761.5, chi: 0.35, bias: -0.38, netFlux: -0.28, peclet: 2.4, etMins: 570, isClosed: true },
    ];

    const { newlyCommitted, snapshot } = fsm.commitSeries(bars, {
      macroRegime: "PUT",
      callDominancePct: 35,
    });

    assert.strictEqual(newlyCommitted.length, 1, "Exactly 1 breakdown transition emitted");
    assert.strictEqual(newlyCommitted[0].fromState, "STAND_ASIDE");
    assert.strictEqual(newlyCommitted[0].toState, "SHORT");
    assert.strictEqual(newlyCommitted[0].price, 761.5);
    assert.strictEqual(newlyCommitted[0].idempotencyKey, "2200_SHORT");
    assert.strictEqual(snapshot.committedState, "SHORT");
  });

  it("Macro Regime Exclusivity: SHORT is structurally impossible during Bull Macro (REGIME: CALL)", () => {
    const fsm = new GaiaSignalFsm();

    // Sudden down-spike bar occurs, but macro is Bull
    const bars: GaiaBarData[] = [
      { barTimestamp: 1000, open: 760, high: 761, low: 759.5, close: 760.2, chi: 0.55, bias: 0.10, netFlux: 0.05, peclet: 0.5, etMins: 570, isClosed: true },
      { barTimestamp: 1300, open: 760.2, high: 760.5, low: 757.0, close: 757.2, chi: 0.35, bias: -0.40, netFlux: -0.30, peclet: 2.5, etMins: 575, isClosed: true },
    ];

    const { newlyCommitted, snapshot } = fsm.commitSeries(bars, {
      macroRegime: "CALL", // Bull Macro vetoes counter-trend SHORT
      callDominancePct: 75,
    });

    // In Bull Macro, short-term negative flux CANNOT trigger a SHORT entry
    const shortSignals = newlyCommitted.filter((s) => s.toState === "SHORT");
    assert.strictEqual(shortSignals.length, 0, "Counter-trend SHORT must be vetoed in Bull Macro");
    assert.notStrictEqual(snapshot.committedState, "SHORT", "State must never flip counter-trend to SHORT in Bull Macro");
  });

  it("Adaptive ATR Volatility Envelope: LONG holds through minor pullback inside ATR envelope and exits when adverse excursion breaches 1.5 * ATR with adverse flux confirmation", () => {
    const fsm = new GaiaSignalFsm();

    const bars: GaiaBarData[] = [
      // 1. Long breakout
      { barTimestamp: 1000, open: 760, high: 763, low: 759.5, close: 762.5, chi: 0.65, bias: 0.30, netFlux: 0.20, peclet: 1.8, etMins: 570, isClosed: true },
      // 2. Bar 2: Shallow adverse pullback bar holding well inside 1.5 * ATR
      { barTimestamp: 1300, open: 762.5, high: 762.8, low: 761.0, close: 761.2, chi: 0.48, bias: -0.05, netFlux: -0.05, peclet: 0.9, etMins: 575, isClosed: true },
    ];

    // Evaluate up to Bar 2
    const { snapshot: snapAfterBar2 } = fsm.commitSeries(bars, {
      macroRegime: "CALL",
      callDominancePct: 60,
    });

    // Must STILL hold LONG after shallow pullback inside ATR envelope (no premature suicide)
    assert.strictEqual(snapAfterBar2.committedState, "LONG", "LONG must hold through a shallow pullback inside ATR envelope");

    // 3. Bar 3: Genuine adverse breakdown breaching 1.5 * ATR stop with confirmed negative flux
    const bar3: GaiaBarData = {
      barTimestamp: 1600,
      open: 760.5,
      high: 760.8,
      low: 757.0,
      close: 757.5,
      chi: 0.42,
      bias: -0.25,
      netFlux: -0.20,
      peclet: 1.5,
      etMins: 580,
      isClosed: true,
    };

    const exitSig = fsm.commitClosedBar(
      bar3,
      computeCausalEquilibriumDispersion([...bars, bar3], 2),
      { macroRegime: "CALL", callDominancePct: 55 }
    );

    assert.notStrictEqual(exitSig, null, "Exit signal must be emitted when adverse excursion breaches ATR envelope");
    assert.strictEqual(exitSig?.fromState, "LONG");
    assert.strictEqual(exitSig?.toState, "STAND_ASIDE");
    assert.strictEqual(exitSig?.reason, "ATR_VOLATILITY_ENVELOPE_BREACH");
    assert.strictEqual(fsm.getSnapshot().committedState, "STAND_ASIDE");
  });

  it("Oscillating intra-bar ticks on unclosed bar CANNOT erase or mutate committed signals", () => {
    const fsm = new GaiaSignalFsm();

    const closedBar1: GaiaBarData = {
      barTimestamp: 1000,
      barCloseTimestamp: 1300,
      open: 760.0,
      high: 762.5,
      low: 759.8,
      close: 762.0,
      chi: 0.65,
      bias: 0.32,
      netFlux: 0.22,
      peclet: 1.9,
      etMins: 570,
      isClosed: true,
    };

    const committedSig = fsm.commitClosedBar(closedBar1, undefined, { macroRegime: "CALL" });
    assert.notStrictEqual(committedSig, null);
    assert.strictEqual(committedSig?.toState, "LONG");

    const initialSnapshot = fsm.getSnapshot();
    assert.strictEqual(initialSnapshot.committedCallLog.length, 1);
    assert.strictEqual(initialSnapshot.committedCallLog[0].idempotencyKey, "1000_LONG");
    assert.strictEqual(initialSnapshot.committedCallLog[0].price, 762.0);

    // 50 severe oscillating intra-bar ticks on forming unclosed bar
    for (let tick = 0; tick < 50; tick++) {
      const isExtremeBear = tick % 2 === 0;
      const liveUnclosedBar: GaiaBarData = {
        barTimestamp: 1300,
        barCloseTimestamp: 1600,
        open: 762.0,
        high: 763.5,
        low: 756.0,
        close: isExtremeBear ? 756.5 : 763.0,
        chi: isExtremeBear ? 0.30 : 0.70,
        bias: isExtremeBear ? -0.45 : 0.45,
        netFlux: isExtremeBear ? -0.55 : 0.55,
        peclet: 2.2,
        etMins: 575,
        isClosed: false, // Forming candle
      };

      const tickSnapshot = fsm.getSnapshot(
        liveUnclosedBar,
        { sigmaChi: 0.05, sigmaFlux: 0.05, barDurationSec: 300, atr: 0.8 },
        { macroRegime: isExtremeBear ? "PUT" : "CALL" }
      );

      // Committed history MUST remain 100% frozen and immutable
      assert.strictEqual(
        tickSnapshot.committedCallLog.length,
        1,
        `Tick ${tick}: committedCallLog length must remain exactly 1`
      );
      assert.strictEqual(
        tickSnapshot.committedCallLog[0].idempotencyKey,
        "1000_LONG",
        `Tick ${tick}: initial committed signal cannot be mutated`
      );
      assert.strictEqual(
        tickSnapshot.committedCallLog[0].price,
        762.0,
        `Tick ${tick}: initial entry price must remain strictly $762.00`
      );
    }

    const finalSnapshot = fsm.getSnapshot();
    assert.strictEqual(finalSnapshot.committedCallLog.length, 1);
    assert.strictEqual(finalSnapshot.committedCallLog[0].toState, "LONG");
  });

  it("96% Call Dominance strictly triggers LONG and rejects SHORT across multi-bar rally", () => {
    const fsm = new GaiaSignalFsm();

    // Bars representing Nov 4 rally from $762.88 to $768.55 with 96% Call Dominance
    const bars: GaiaBarData[] = [
      { barTimestamp: 1000, open: 762.0, high: 763.5, low: 761.8, close: 762.88, chi: 0.96, bias: 0.85, netFlux: 0.45, peclet: 25.0, etMins: 570, isClosed: true },
      { barTimestamp: 1300, open: 762.88, high: 765.0, low: 762.5, close: 764.50, chi: 0.95, bias: 0.82, netFlux: 0.40, peclet: 24.0, etMins: 575, isClosed: true },
      // Minor 1-bar pullback pause
      { barTimestamp: 1600, open: 764.50, high: 764.8, low: 763.9, close: 764.10, chi: 0.92, bias: 0.70, netFlux: 0.15, peclet: 18.0, etMins: 580, isClosed: true },
      // Continuation to highs
      { barTimestamp: 1900, open: 764.10, high: 768.8, low: 764.0, close: 768.55, chi: 0.96, bias: 0.90, netFlux: 0.50, peclet: 25.0, etMins: 585, isClosed: true },
    ];

    const { newlyCommitted, snapshot } = fsm.commitSeries(bars, {
      macroRegime: "CALL",
      callDominancePct: 96,
    });

    // 1. Must commit LONG on breakout
    assert.strictEqual(newlyCommitted.length, 1, "Must commit exactly 1 LONG trade");
    assert.strictEqual(newlyCommitted[0].toState, "LONG");
    assert.strictEqual(newlyCommitted[0].price, 762.88);

    // 2. SHORT is strictly impossible
    const shortSignals = newlyCommitted.filter((s) => s.toState === "SHORT");
    assert.strictEqual(shortSignals.length, 0, "Zero SHORT signals permitted under 96% Call Dominance");

    // 3. FSM state remains LONG across the entire rally
    assert.strictEqual(snapshot.committedState, "LONG", "FSM must stay in LONG throughout the bull rally");
  });

  it("VWAP Acceleration Filter: Rejects LONG breakout when price is below Flow VWAP or VWAP slope is negative", () => {
    const fsm = new GaiaSignalFsm();

    // Bar has high chi and flux, but price is below falling Flow VWAP
    const bars: GaiaBarData[] = [
      {
        barTimestamp: 1000,
        open: 760.0,
        high: 761.0,
        low: 759.5,
        close: 760.5,
        chi: 0.65,
        bias: 0.30,
        netFlux: 0.25,
        peclet: 1.8,
        flowVwap: 762.0, // Price (760.5) is BELOW Flow VWAP (762.0)
        vwapSlope: -0.2, // VWAP slope is decelerating / negative
        etMins: 570,
        isClosed: true,
      },
    ];

    const { newlyCommitted, snapshot } = fsm.commitSeries(bars, {
      macroRegime: "CALL",
      callDominancePct: 70,
    });

    assert.strictEqual(newlyCommitted.length, 0, "Breakout below falling VWAP must be rejected");
    assert.strictEqual(snapshot.committedState, "STAND_ASIDE");

    // Second bar closes above accelerating VWAP
    const bar2: GaiaBarData = {
      barTimestamp: 1300,
      open: 761.5,
      high: 764.0,
      low: 761.0,
      close: 763.5,
      chi: 0.70,
      bias: 0.40,
      netFlux: 0.35,
      peclet: 2.2,
      flowVwap: 762.5, // Price (763.5) ABOVE Flow VWAP (762.5)
      vwapSlope: 0.5,  // VWAP slope is positive / accelerating
      etMins: 575,
      isClosed: true,
    };

    const sig2 = fsm.commitClosedBar(bar2, computeCausalEquilibriumDispersion([...bars, bar2], 1), {
      macroRegime: "CALL",
      callDominancePct: 70,
    });

    assert.notStrictEqual(sig2, null, "LONG entry admitted when price clears accelerating Flow VWAP");
    assert.strictEqual(sig2?.toState, "LONG");
  });
});
