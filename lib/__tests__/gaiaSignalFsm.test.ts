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
      { barTimestamp: 2200, open: 761.0, high: 763.5, low: 760.8, close: 763.0, chi: 0.65, bias: 0.35, netFlux: 0.25, peclet: 2.1, etMins: 575, isClosed: true },
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
      { barTimestamp: 2200, open: 763.5, high: 763.8, low: 761.0, close: 761.5, chi: 0.35, bias: -0.38, netFlux: -0.28, peclet: 2.4, etMins: 575, isClosed: true },
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
      { barTimestamp: 1000, open: 760, high: 763, low: 759.5, close: 762.5, chi: 0.65, bias: 0.30, netFlux: 0.20, peclet: 1.8, etMins: 575, isClosed: true },
      // 2. Bar 2: Shallow adverse pullback bar holding well inside 1.5 * ATR
      { barTimestamp: 1300, open: 762.5, high: 762.8, low: 761.0, close: 761.2, chi: 0.48, bias: -0.05, netFlux: -0.05, peclet: 0.9, etMins: 580, isClosed: true },
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
      etMins: 585,
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
      etMins: 575,
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
      { barTimestamp: 1000, open: 762.0, high: 763.5, low: 761.8, close: 762.88, chi: 0.96, bias: 0.85, netFlux: 0.45, peclet: 25.0, etMins: 575, isClosed: true },
      { barTimestamp: 1300, open: 762.88, high: 765.0, low: 762.5, close: 764.50, chi: 0.95, bias: 0.82, netFlux: 0.40, peclet: 24.0, etMins: 580, isClosed: true },
      // Minor 1-bar pullback pause
      { barTimestamp: 1600, open: 764.50, high: 764.8, low: 763.9, close: 764.10, chi: 0.92, bias: 0.70, netFlux: 0.15, peclet: 18.0, etMins: 585, isClosed: true },
      // Continuation to highs
      { barTimestamp: 1900, open: 764.10, high: 768.8, low: 764.0, close: 768.55, chi: 0.96, bias: 0.90, netFlux: 0.50, peclet: 25.0, etMins: 590, isClosed: true },
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

  it("Flux-Field Primary Entry/Exit: Strong Call flux (chi > 0.85, netFlux > 0) enters LONG, holds on aligned flux, and exits on adverse flux reversal", () => {
    const fsm = new GaiaSignalFsm();
    const bars: GaiaBarData[] = [
      { barTimestamp: 1000, open: 760.0, high: 760.5, low: 759.5, close: 760.1, chi: 0.52, bias: 0.04, netFlux: 0.02, peclet: 0.4, etMins: 565, isClosed: true },
      { barTimestamp: 1300, open: 760.1, high: 762.8, low: 760.0, close: 762.4, chi: 0.89, bias: 0.42, netFlux: 0.35, peclet: 2.6, etMins: 575, isClosed: true },
      // Aligned flux pull-in: holds LONG
      { barTimestamp: 1600, open: 762.4, high: 762.6, low: 761.5, close: 761.9, chi: 0.86, bias: 0.25, netFlux: 0.18, peclet: 1.9, etMins: 580, isClosed: true },
      // Adverse flux flip + ATR breach: exits to STAND_ASIDE
      { barTimestamp: 1900, open: 761.9, high: 762.0, low: 757.2, close: 757.6, chi: 0.12, bias: -0.38, netFlux: -0.31, peclet: 2.3, etMins: 585, isClosed: true },
    ];

    const { newlyCommitted, snapshot } = fsm.commitSeries(bars, {
      macroRegime: "CALL",
      callDominancePct: 72,
    });

    assert.strictEqual(newlyCommitted.length, 2, "Expected 1 LONG entry and 1 STAND_ASIDE exit");
    assert.strictEqual(newlyCommitted[0].toState, "LONG");
    assert.strictEqual(newlyCommitted[1].fromState, "LONG");
    assert.strictEqual(newlyCommitted[1].toState, "STAND_ASIDE");
    assert.strictEqual(snapshot.committedState, "STAND_ASIDE");
  });

  it("Stage-2 Trailing Stop retains BE+10% floor and commitClosedBar blocks entries at or after 16:00 ET", () => {
    // 1. Post-16:00 ET firewall: bar with etMins >= 960 must NOT enter a new trade
    const fsmEod = new GaiaSignalFsm();
    const preBar: GaiaBarData = {
      barTimestamp: 1000,
      open: 760.0,
      high: 760.5,
      low: 759.5,
      close: 760.1,
      chi: 0.52,
      bias: 0.04,
      netFlux: 0.02,
      peclet: 0.4,
      etMins: 950,
      isClosed: true,
    };
    const eodSetupBar: GaiaBarData = {
      barTimestamp: 1600,
      open: 760.1,
      high: 763.0,
      low: 760.0,
      close: 762.8,
      chi: 0.90,
      bias: 0.45,
      netFlux: 0.38,
      peclet: 2.7,
      etMins: 960, // 16:00 ET hard cutoff
      isClosed: true,
    };
    const eodSig = fsmEod.commitClosedBar(eodSetupBar, computeCausalEquilibriumDispersion([preBar, eodSetupBar], 1), {
      macroRegime: "CALL",
      callDominancePct: 75,
    });
    assert.strictEqual(eodSig, null, "Must never open a new FSM position at/after 16:00 ET (etMins >= 960)");

    // 2. Stage-2 BE+10% floor invariant on active LONG runner
    const fsmTrail = new GaiaSignalFsm();
    const bars: GaiaBarData[] = [
      { barTimestamp: 1000, open: 760.0, high: 760.4, low: 759.6, close: 760.0, chi: 0.50, bias: 0.0, netFlux: 0.0, peclet: 0.2, etMins: 565, isClosed: true },
      // Entry LONG around 762.0 (stop ~ 760.0 -> initialRisk = 2.0, targetWall = 768.0)
      { barTimestamp: 1300, open: 760.0, high: 762.4, low: 759.9, close: 762.0, chi: 0.88, bias: 0.42, netFlux: 0.35, peclet: 2.5, etMins: 575, isClosed: true },
      // Runner surges > 75% to wall (766.8) on a wide bar (low 761.0 < BE+10% floor 762.2), promoting Stage-2 trail
      { barTimestamp: 1600, open: 762.0, high: 767.0, low: 761.0, close: 766.8, chi: 0.90, bias: 0.45, netFlux: 0.36, peclet: 2.6, etMins: 580, isClosed: true },
      // Next bar pulls back below Stage-2 BE+10% floor (762.20) even though prior bar low was 761.0
      { barTimestamp: 1900, open: 766.5, high: 766.5, low: 762.10, close: 762.15, chi: 0.65, bias: 0.15, netFlux: 0.10, peclet: 1.0, etMins: 585, isClosed: true },
    ];
    const { newlyCommitted } = fsmTrail.commitSeries(bars, {
      macroRegime: "CALL",
      callDominancePct: 75,
      structuralLevels: {
        putWall: 758.0,
        callWall: 768.0,
        zeroGamma: 760.0,
      },
    });
    assert.strictEqual(newlyCommitted[0]?.toState, "LONG", "Expected initial LONG entry");
    const exitSig = newlyCommitted.find((s) => s.fromState === "LONG" && s.toState === "STAND_ASIDE");
    assert.ok(exitSig, "Expected Stage-2 BE+10% floor or stop exit when runner retraces below BE+10% floor");
  });

  it("Full 78-bar RTH session with noisy oscillations produces <= 2 trades (<= 1 same-direction), >= 30m cooldown, and zero <10% reversal micro-scalps", () => {
    const fsm = new GaiaSignalFsm();
    const bars: GaiaBarData[] = [];
    const baseEpoch = 1794580200; // 09:30 ET

    for (let i = 0; i < 78; i++) {
      const etMins = 570 + i * 5;
      const isAfternoon = i >= 36; // 12:30 ET regime flip
      const noise = (i % 2 === 0 ? 1 : -1) * 0.40;
      const close = (isAfternoon ? 757.0 : 763.0) + noise;
      bars.push({
        barTimestamp: baseEpoch + i * 300,
        open: close - noise * 0.5,
        high: close + 0.45,
        low: close - 0.45,
        close,
        chi: isAfternoon ? (i % 3 === 0 ? 0.35 : 0.15) : (i % 3 === 0 ? 0.65 : 0.88),
        bias: isAfternoon ? -0.35 : 0.35,
        netFlux: isAfternoon ? (i % 3 === 0 ? 0.08 : -0.32) : (i % 3 === 0 ? -0.08 : 0.32),
        peclet: 2.2,
        flowVwap: isAfternoon ? 758.5 : 761.5,
        vwapSlope: isAfternoon ? -0.25 : 0.25,
        etMins,
        isClosed: true,
      });
    }

    const allSignals: ReturnType<GaiaSignalFsm["commitSeries"]>["newlyCommitted"] = [];
    for (let i = 0; i < bars.length; i++) {
      const isAfternoon = i >= 36;
      const disp = computeCausalEquilibriumDispersion(bars, i);
      const sig = fsm.commitClosedBar(bars[i], disp, {
        macroRegime: isAfternoon ? "PUT" : "CALL",
        callDominancePct: isAfternoon ? 25 : 75,
        structuralLevels: { putWall: 754, callWall: 766, zeroGamma: 760 },
      });
      if (sig) allSignals.push(sig);
    }

    const entries = allSignals.filter((s) => s.toState === "LONG" || s.toState === "SHORT");
    const longEntries = entries.filter((s) => s.toState === "LONG");
    const shortEntries = entries.filter((s) => s.toState === "SHORT");

    assert.ok(entries.length <= 2, `Expected <= 2 entries over 78-bar RTH session, got ${entries.length}`);
    assert.ok(longEntries.length <= 1, `Expected <= 1 LONG entry, got ${longEntries.length}`);
    assert.ok(shortEntries.length <= 1, `Expected <= 1 SHORT entry, got ${shortEntries.length}`);

    if (entries.length === 2) {
      const firstExit = allSignals.find(
        (s) => s.fromState === entries[0].toState && s.toState === "STAND_ASIDE"
      );
      assert.ok(firstExit, "First trade must exit before second opposite-direction entry");
      assert.ok(
        entries[1].barTimestamp - firstExit!.barTimestamp >= 1800,
        "Phase 2 opposite-direction entry must enforce >= 30-min (1800s) cooldown"
      );
    }

    const microReversalExits = allSignals.filter((s) => {
      if (s.toState !== "STAND_ASIDE" || !s.reason.includes("REVERSAL")) return false;
      const entry = [...entries].reverse().find((e) => e.sequence < s.sequence);
      if (!entry) return false;
      const heldBars = (s.barTimestamp - entry.barTimestamp) / 300;
      const adverseMove = entry.toState === "LONG" ? entry.price - s.price : s.price - entry.price;
      return heldBars < 2 || adverseMove < 0.75;
    });
    assert.strictEqual(microReversalExits.length, 0, "Zero <2-bar or <$0.75 reversal micro-scalps permitted");
  });

  it("Two-Regime Leg 2: Winning morning SHORT does not lock day; >= 30m cooldown + Put Wall / -1σ Bullish Reclaim opens LONG, then LOCKED_FOR_DAY at 2 closed trades", () => {
    const fsm = new GaiaSignalFsm();
    const bars: GaiaBarData[] = [
      // Bar 0 (09:35 ET, 575): Opening Short Flush off Zero Gamma 758 -> entry ~756.0
      { barTimestamp: 1000, open: 757.2, high: 757.5, low: 755.8, close: 756.0, chi: 0.25, bias: -0.45, netFlux: -0.35, peclet: -2.2, flowVwap: 756.8, sma34: 757.0, etMins: 575, isClosed: true },
      // Bar 1 (09:40 ET, 580)
      { barTimestamp: 1300, open: 756.0, high: 756.1, low: 753.0, close: 753.2, chi: 0.20, bias: -0.50, netFlux: -0.40, peclet: -2.5, flowVwap: 755.5, sma34: 756.2, etMins: 580, isClosed: true },
      // Bar 2 (09:50 ET, 590): Holds then sweeps Put Wall 750 -> big winning SHORT (> +0.5% spot = +100%+ option profit)
      { barTimestamp: 1900, open: 753.2, high: 753.3, low: 750.1, close: 750.4, chi: 0.22, bias: -0.45, netFlux: -0.32, peclet: -2.0, flowVwap: 754.0, sma34: 754.5, etMins: 590, isClosed: true },
      // Bar 3 (10:15 ET, 615): Reversal >= $0.75 closes Leg-1 winning SHORT at 751.80
      { barTimestamp: 3400, open: 750.5, high: 752.0, low: 750.4, close: 751.8, chi: 0.56, bias: 0.15, netFlux: 0.10, peclet: 0.4, flowVwap: 751.5, sma34: 751.6, etMins: 615, isClosed: true },
      // Bar 4 (10:35 ET, 635 -> +1200s < 1800s cooldown, < 10:45 ET): Attempted reclaim must stay STAND_ASIDE
      { barTimestamp: 4600, open: 750.2, high: 751.4, low: 749.9, close: 751.2, recentLow4: 749.9, chi: 0.58, impulseChi: 0.68, deltaNetFlux6Bar: 0.18, bias: 0.30, netFlux: 0.22, peclet: 0.8, impulsePeclet: 1.5, flowVwap: 751.0, sma34: 751.1, bullDiv5m: true, etMins: 635, isClosed: true },
      // Bar 5 (11:30 ET, 690 -> +3600s >= 1800s cooldown, >= 10:45 ET): Put Wall 750 / -1σ Bullish Reclaim with impulseChi=0.68 & deltaNetFlux6Bar > 0 opens Leg-2 LONG
      { barTimestamp: 7000, open: 750.3, high: 751.9, low: 750.1, close: 751.7, recentLow4: 750.1, chi: 0.59, impulseChi: 0.68, deltaNetFlux6Bar: 0.20, bias: 0.35, netFlux: 0.25, peclet: 1.0, impulsePeclet: 1.6, flowVwap: 751.2, sma34: 751.4, sigmaMinus1: 750.2, sigmaPlus1: 754.0, bullDiv5m: true, etMins: 690, isClosed: true },
      // Bar 6 (13:00 ET, 780): Reaches Call Wall / King reversal and closes Leg-2 LONG -> LOCKED_FOR_DAY (2 closed)
      { barTimestamp: 12400, open: 754.2, high: 754.5, low: 750.5, close: 750.7, chi: 0.32, bias: -0.35, netFlux: -0.25, peclet: -1.8, flowVwap: 753.0, sma34: 752.8, etMins: 780, isClosed: true },
      // Bar 7 (13:45 ET, 825): Third entry attempt strictly blocked by LOCKED_FOR_DAY
      { barTimestamp: 15100, open: 750.7, high: 753.0, low: 750.1, close: 752.8, recentLow4: 750.1, chi: 0.85, impulseChi: 0.82, deltaNetFlux6Bar: 0.30, bias: 0.45, netFlux: 0.35, peclet: 2.2, impulsePeclet: 2.0, flowVwap: 751.5, sma34: 751.8, bullDiv5m: true, etMins: 825, isClosed: true },
    ];

    const { snapshot, newlyCommitted } = fsm.commitSeries(bars, {
      macroRegime: "PUT",
      callDominancePct: 35,
      structuralLevels: { putWall: 750, callWall: 760, zeroGamma: 758, bookCenter: 755 },
    });

    const entries = newlyCommitted.filter((s) => s.toState === "LONG" || s.toState === "SHORT");
    const exits = newlyCommitted.filter((s) => s.toState === "STAND_ASIDE");
    assert.strictEqual(entries.length, 2, `Expected exactly 2 entries (Leg-1 SHORT + Leg-2 LONG), got ${entries.length}`);
    assert.strictEqual(entries[0].toState, "SHORT");
    assert.strictEqual(entries[1].toState, "LONG");
    assert.strictEqual(entries[1].barTimestamp, 7000, "Leg-2 LONG must wait until >= 10:45 ET & >= 1800s cooldown");
    assert.ok(entries[1].reason.startsWith("LEG2_"), `Expected LEG2_ reason prefix, got ${entries[1].reason}`);
    assert.strictEqual(exits.length, 2, "Both Leg-1 and Leg-2 must close cleanly");
    assert.strictEqual(snapshot.committedState, "STAND_ASIDE", "Session ends FLAT / LOCKED_FOR_DAY after 2 closed trades");
  });

  it("Symmetric Leg-2 SHORT: Winning morning LONG allows afternoon Call Wall / +1σ Bearish Rejection", () => {
    const fsm = new GaiaSignalFsm();
    const bars: GaiaBarData[] = [
      // Bar 0 (09:35 ET, 575): Opening LONG above Zero Gamma 756
      { barTimestamp: 1000, open: 757.0, high: 759.0, low: 756.8, close: 758.5, chi: 0.84, bias: 0.42, netFlux: 0.32, peclet: 2.2, flowVwap: 757.2, sma34: 757.0, etMins: 575, isClosed: true },
      // Bar 1 (10:15 ET, 615): Reaches Call Wall 762 & reverses >= $0.75 to close winning LONG
      { barTimestamp: 3400, open: 761.8, high: 762.1, low: 759.8, close: 760.0, recentHigh3: 762.1, chi: 0.38, bias: -0.25, netFlux: -0.18, peclet: -1.1, flowVwap: 760.5, sma34: 760.8, etMins: 615, isClosed: true },
      // Bar 2 (11:30 ET, 690 -> +3600s >= 1800s cooldown): Tests Call Wall 762 / +1σ with bearDiv5m, impulseChi <= 0.40, deltaNetFlux6Bar < 0, room >= $1.50 to ZG 756 / PW 750
      { barTimestamp: 7000, open: 761.9, high: 762.0, low: 760.2, close: 760.4, recentHigh3: 762.0, chi: 0.41, impulseChi: 0.32, deltaNetFlux6Bar: -0.22, bias: -0.35, netFlux: -0.24, peclet: -0.9, impulsePeclet: -1.6, flowVwap: 760.9, sma34: 761.0, sigmaPlus1: 761.8, sigmaMinus1: 758.0, bearDiv5m: true, etMins: 690, isClosed: true },
    ];

    const { newlyCommitted } = fsm.commitSeries(bars, {
      macroRegime: "CALL",
      callDominancePct: 60,
      structuralLevels: { putWall: 750, callWall: 762, zeroGamma: 756, bookCenter: 756 },
    });

    const entries = newlyCommitted.filter((s) => s.toState === "LONG" || s.toState === "SHORT");
    assert.strictEqual(entries.length, 2, `Expected 2 entries (Leg-1 LONG + Leg-2 SHORT), got ${entries.length}`);
    assert.strictEqual(entries[0].toState, "LONG");
    assert.strictEqual(entries[1].toState, "SHORT");
    assert.strictEqual(entries[1].reason, "LEG2_CALL_WALL_BEAR_REJECTION_PUT");
  });

  it("Positive-Gamma Regime (netGex > 0, spot > Zero Γ, |Pe| < 1.5) prioritizes Wall-to-Wall sweep bounce", () => {
    const fsm = new GaiaSignalFsm();
    const bars: GaiaBarData[] = [
      // Morning positive-gamma sweep to Put Wall 752 / -1σ 752.4 with bullDiv5m and reclaim of Flow VWAP / SMA 34 -> LONG to Book Center
      { barTimestamp: 1000, open: 752.2, high: 753.6, low: 751.9, close: 753.4, recentLow4: 751.9, chi: 0.49, impulseChi: 0.54, bias: 0.12, netFlux: 0.08, peclet: 0.6, netGex: 1_800_000, flowVwap: 753.1, sma34: 753.0, sigmaMinus1: 752.4, sigmaPlus1: 756.5, bullDiv5m: true, etMins: 585, isClosed: true },
    ];

    const { newlyCommitted } = fsm.commitSeries(bars, {
      macroRegime: "CALL",
      callDominancePct: 50,
      netGex: 1_800_000,
      structuralLevels: { putWall: 752, callWall: 758, zeroGamma: 750, bookCenter: 755 },
    });

    assert.strictEqual(newlyCommitted.length, 1);
    assert.strictEqual(newlyCommitted[0].toState, "LONG");
    assert.strictEqual(newlyCommitted[0].reason, "POSITIVE_GAMMA_PUT_WALL_BOUNCE_CALL");
  });
});
