"use client";

import React, { useEffect, useMemo, useState } from "react";
import { getTickerPreset, useDashboardStore } from "@/store/useDashboardStore";
import { OptionsAnalyticsPayload } from "@/lib/optionsExposure";
import { computeBarFlowGammaVwapSeries } from "@/lib/flowGammaVwap";
import { cn } from "@/lib/utils";

const TIMEFRAMES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "90m",
  "2h",
  "D",
  "W",
] as const;

type Timeframe = (typeof TIMEFRAMES)[number];

interface CandleBar {
  index: number;
  timeLabel: string;
  open: number;
  high: number;
  low: number;
  close: number;
  sma34: number;
  sma5d: number;
}

function seededVal(seed: number): number {
  const x = Math.sin(seed * 37.719 + 19.83) * 49123.5453;
  return x - Math.floor(x);
}

function generateSessionCandles(params: {
  symbol: string;
  spot: number;
  prevClose: number;
  callWall: number;
  putWall: number;
  timeframe: Timeframe;
}): CandleBar[] {
  const { symbol, spot, prevClose, callWall, putWall, timeframe } = params;
  const totalBars = 56;
  const tfMultiplier =
    timeframe === "1m"
      ? 0.45
      : timeframe === "3m"
        ? 0.7
        : timeframe === "5m"
          ? 1
          : timeframe === "15m"
            ? 1.35
            : 1.75;

  const span = Math.max(spot * 0.012, Math.abs(callWall - putWall)) * tfMultiplier;
  const symSeed = symbol
    .split("")
    .reduce((acc, ch) => acc + ch.charCodeAt(0) * 17, 0);

  const rawCloses: number[] = [];
  let cursor = prevClose;

  for (let i = 0; i < totalBars; i++) {
    const progress = i / (totalBars - 1);
    const wave =
      Math.sin(progress * Math.PI * 2.5 + symSeed) * span * 0.14 +
      (seededVal(symSeed + i * 13) - 0.49) * span * 0.09;
    cursor =
      i === totalBars - 1
        ? spot
        : prevClose + (spot - prevClose) * progress + wave;
    rawCloses.push(cursor);
  }

  const bars: CandleBar[] = [];
  for (let i = 0; i < totalBars; i++) {
    const close = rawCloses[i];
    const open = i === 0 ? prevClose : rawCloses[i - 1];
    const wickUp = seededVal(symSeed + i * 29) * span * 0.06;
    const wickDown = seededVal(symSeed + i * 31) * span * 0.06;
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDown;

    // SMA 34 (rolling window)
    const start34 = Math.max(0, i - 16);
    const slice34 = rawCloses.slice(start34, i + 1);
    const sma34 = slice34.reduce((a, b) => a + b, 0) / slice34.length;

    // SMA 5D (slower institutional baseline)
    const sma5d =
      prevClose * 0.65 +
      (rawCloses.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1)) * 0.35;

    const sessionDay = i < 28 ? "Oct 15" : "Oct 16";
    const minsFromOpen = (i % 28) * 14;
    const hh = String(9 + Math.floor((30 + minsFromOpen) / 60)).padStart(2, "0");
    const mm = String((30 + minsFromOpen) % 60).padStart(2, "0");

    bars.push({
      index: i,
      timeLabel: `${sessionDay} ${hh}:${mm}`,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      sma34: Number(sma34.toFixed(2)),
      sma5d: Number(sma5d.toFixed(2)),
    });
  }

  return bars;
}

function InstitutionalChartCard({
  symbol,
  timeframe,
  payload,
}: {
  symbol: "SPX" | "SPY" | "QQQ" | "IWM";
  timeframe: Timeframe;
  payload?: OptionsAnalyticsPayload;
}) {
  const setTicker = useDashboardStore((state) => state.setTicker);
  const setActiveView = useDashboardStore((state) => state.setActiveView);

  const preset = getTickerPreset(symbol);
  const spot = payload?.spotPrice ?? preset.spotPrice;
  const prevClose = payload?.previousClose ?? preset.previousClose;
  const iv = payload?.impliedVolatility ?? preset.impliedVolatility;
  const netGex = payload?.netMetrics.netGex ?? preset.netMetrics.netGex;
  const callWall = payload?.gammaLevels.callWall ?? preset.gammaLevels.callWall;
  const putWall = payload?.gammaLevels.putWall ?? preset.gammaLevels.putWall;
  const zeroGamma =
    payload?.gammaLevels.zeroGamma ?? preset.gammaLevels.zeroGamma;
  const kingStrike =
    payload?.kingNode.allExpKing ?? preset.kingPreset.allExpKing;
  const kingStrength = payload?.kingNode.kingStrength ?? 64;

  const absChange = spot - prevClose;
  const pctChange = prevClose > 0 ? (absChange / prevClose) * 100 : 0;
  const isPos = absChange >= 0;

  const dailyEm = spot * iv * Math.sqrt(1 / 252);
  const weeklyEm = spot * iv * Math.sqrt(5 / 252);
  const monthlyEm = spot * iv * Math.sqrt(21 / 252);

  const dUp = Number((prevClose + dailyEm).toFixed(2));
  const dDown = Number((prevClose - dailyEm).toFixed(2));
  const wUp = Number((prevClose + weeklyEm).toFixed(2));
  const wDown = Number((prevClose - weeklyEm).toFixed(2));
  const mUp = Number((prevClose + monthlyEm * 0.55).toFixed(2));

  const candles = useMemo(
    () =>
      generateSessionCandles({
        symbol,
        spot,
        prevClose,
        callWall,
        putWall,
        timeframe,
      }),
    [symbol, spot, prevClose, callWall, putWall, timeframe]
  );

  // Compute Flow VWAP & Flux Field PDE series across session candles
  const flowSeries = useMemo(
    () =>
      computeBarFlowGammaVwapSeries(
        candles.map((c, idx) => ({
          timestamp: idx * 300,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: 1500,
        })),
        undefined,
        {
          floorNode: putWall,
          ceilingNode: callWall,
        }
      ),
    [candles, putWall, callWall]
  );

  const latestBar = candles[candles.length - 1];
  const latestFlow = flowSeries[flowSeries.length - 1];

  const allPrices = [
    ...candles.flatMap((c) => [c.high, c.low, c.sma34, c.sma5d]),
    ...flowSeries.flatMap((f) => [f.flowVwap, f.upper2Sigma, f.lower2Sigma]),
    callWall,
    putWall,
    zeroGamma,
    kingStrike,
    dUp,
    dDown,
    wUp,
    wDown,
  ];
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const pad = (maxPrice - minPrice) * 0.08;
  const yMin = minPrice - pad;
  const yMax = maxPrice + pad;

  const svgWidth = 960;
  const svgHeight = 390;
  const plotLeft = 16;
  const plotRight = svgWidth - 92;
  const plotTop = 18;
  const plotBottom = svgHeight - 28;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  const priceToY = (p: number) => {
    const ratio = (p - yMin) / Math.max(0.01, yMax - yMin);
    return plotBottom - ratio * plotH;
  };

  const idxToX = (idx: number) =>
    plotLeft + ((idx + 0.5) / candles.length) * plotW;

  const sma34Points = candles
    .map((c, i) => `${idxToX(i).toFixed(1)},${priceToY(c.sma34).toFixed(1)}`)
    .join(" ");
  const sma5dPoints = candles
    .map((c, i) => `${idxToX(i).toFixed(1)},${priceToY(c.sma5d).toFixed(1)}`)
    .join(" ");

  const flowVwapPoints = flowSeries
    .map((f, i) => `${idxToX(i).toFixed(1)},${priceToY(f.flowVwap).toFixed(1)}`)
    .join(" ");
  const upper1Points = flowSeries
    .map((f, i) => `${idxToX(i).toFixed(1)},${priceToY(f.upper1Sigma).toFixed(1)}`)
    .join(" ");
  const lower1Points = flowSeries
    .map((f, i) => `${idxToX(i).toFixed(1)},${priceToY(f.lower1Sigma).toFixed(1)}`)
    .join(" ");
  const upper2Points = flowSeries
    .map((f, i) => `${idxToX(i).toFixed(1)},${priceToY(f.upper2Sigma).toFixed(1)}`)
    .join(" ");
  const lower2Points = flowSeries
    .map((f, i) => `${idxToX(i).toFixed(1)},${priceToY(f.lower2Sigma).toFixed(1)}`)
    .join(" ");
  const flowBandPolygon = [
    ...flowSeries.map((f, i) => `${idxToX(i).toFixed(1)},${priceToY(f.upper2Sigma).toFixed(1)}`),
    ...flowSeries
      .slice()
      .reverse()
      .map((f, revIdx) => {
        const i = flowSeries.length - 1 - revIdx;
        return `${idxToX(i).toFixed(1)},${priceToY(f.lower2Sigma).toFixed(1)}`;
      }),
  ].join(" ");

  const structuralLevels = [
    {
      label: "M↑",
      price: mUp,
      color: "#fb923c",
      dash: "3 3",
      width: 1,
    },
    {
      label: "W↑",
      price: wUp,
      color: "#facc15",
      dash: "4 3",
      width: 1,
    },
    {
      label: "D↑",
      price: dUp,
      color: "#e2e8f0",
      dash: "3 3",
      width: 1,
    },
    {
      label: "Call wall",
      price: callWall,
      color: "#11cdef",
      dash: "0",
      width: 1.8,
    },
    {
      label: "King",
      price: kingStrike,
      color: "#facc15",
      dash: "0",
      width: 2.2,
    },
    {
      label: "Zero γ",
      price: zeroGamma,
      color: "#94a3b8",
      dash: "5 4",
      width: 1.5,
    },
    {
      label: "Put wall",
      price: putWall,
      color: "#f5365c",
      dash: "0",
      width: 1.8,
    },
    {
      label: "D↓",
      price: dDown,
      color: "#e2e8f0",
      dash: "3 3",
      width: 1,
    },
    {
      label: "W↓",
      price: wDown,
      color: "#facc15",
      dash: "4 3",
      width: 1,
    },
  ];

  return (
    <div className="argon-card rounded-xl p-4 space-y-3">
      {/* Top Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2.5">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <button
            type="button"
            onClick={() => {
              setTicker(symbol);
              setActiveView("Heatmap");
            }}
            className="text-lg font-extrabold text-white hover:text-[#11cdef] transition-colors"
          >
            {symbol}
          </button>
          <span className="font-mono text-xl font-extrabold text-white tabular-nums">
            ${spot.toFixed(2)}
          </span>
          <span
            className={cn(
              "font-mono text-xs font-bold tabular-nums",
              isPos ? "text-emerald-400" : "text-rose-400"
            )}
          >
            {isPos ? "+" : ""}
            {absChange.toFixed(2)} ({isPos ? "+" : ""}
            {pctChange.toFixed(2)}%)
          </span>
          <span className="text-xs font-mono text-slate-400">
            Last 2 sessions · {timeframe}
          </span>
        </div>

        {/* Top Callout Badge + SMA Indicators */}
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
          <div className="rounded-full bg-[#0b0d17] border border-white/15 px-3 py-0.5 text-slate-300">
            <span className="text-orange-300 font-bold">▲ M↑ ${mUp.toFixed(0)}</span>
            {" · "}
            <span className="text-[#11cdef] font-bold">
              Call wall ${callWall.toFixed(0)}
            </span>
            {" · "}
            <span className="text-yellow-300 font-bold">
              King ${kingStrike.toFixed(0)}
            </span>
          </div>

          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-400/35 px-2.5 py-0.5 text-amber-300">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            Flow VWAP: ${latestFlow?.flowVwap.toFixed(1)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 border border-cyan-400/30 px-2.5 py-0.5 text-cyan-300">
            Flux χ: {((latestFlow?.ceilingShareChi ?? 0.5) * 100).toFixed(0)}% (Pe{" "}
            {(latestFlow?.pecletNumber ?? 0) >= 0 ? "+" : ""}
            {(latestFlow?.pecletNumber ?? 0).toFixed(1)})
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 border border-rose-400/30 px-2.5 py-0.5 text-rose-300">
            <span className="h-2 w-2 rounded-full bg-rose-400" />
            SMA 34: ${latestBar.sma34.toFixed(1)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/10 border border-purple-400/30 px-2.5 py-0.5 text-purple-300">
            <span className="h-2 w-2 rounded-full bg-purple-400" />
            SMA 5D: ${latestBar.sma5d.toFixed(1)}
          </span>
        </div>
      </div>

      {/* Main Chart Canvas with Floating Glass HUD */}
      <div className="relative rounded-lg border border-white/10 bg-[#0b0d17] overflow-hidden">
        {/* Floating Glass HUD */}
        <div className="absolute top-3 left-3 z-20 rounded-lg bg-[#111422]/85 backdrop-blur-md border border-white/15 px-3 py-2 text-[11px] font-mono space-y-1 shadow-lg pointer-events-none">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">Net GEX:</span>
            <span
              className={cn(
                "font-bold",
                netGex >= 0 ? "text-teal-300" : "text-purple-300"
              )}
            >
              {netGex >= 0 ? "+" : "-"}${Math.abs(netGex).toFixed(2)}B
            </span>
            <span className="text-slate-600">|</span>
            <span className="text-yellow-300 font-bold">
              King ${kingStrike.toFixed(0)} ({kingStrength}pts)
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-slate-300">
            <span>Levels:</span>
            <span className="text-[#11cdef]">CW ${callWall.toFixed(0)}</span>
            <span>·</span>
            <span className="text-[#f5365c]">PW ${putWall.toFixed(0)}</span>
            <span>·</span>
            <span className="text-slate-300">0γ ${zeroGamma.toFixed(1)}</span>
            <span>·</span>
            <span className="text-amber-300 font-semibold">
              FVWAP ${latestFlow?.flowVwap.toFixed(1)} (χ{" "}
              {((latestFlow?.ceilingShareChi ?? 0.5) * 100).toFixed(0)}%)
            </span>
          </div>
        </div>

        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full h-[360px] block select-none"
        >
          {/* Horizontal Grid Lines */}
          {[0.15, 0.35, 0.5, 0.65, 0.85].map((pct) => {
            const y = plotTop + pct * plotH;
            return (
              <line
                key={pct}
                x1={plotLeft}
                y1={y}
                x2={plotRight}
                y2={y}
                stroke="rgba(255,255,255,0.05)"
                strokeWidth="1"
              />
            );
          })}

          {/* Session Divider Line (Prior Session vs Current Session) */}
          <line
            x1={idxToX(28)}
            y1={plotTop}
            x2={idxToX(28)}
            y2={plotBottom}
            stroke="rgba(148,163,184,0.22)"
            strokeDasharray="4 4"
            strokeWidth="1"
          />

          {/* Horizontal Structural Level Lines + Right-Side Y-Axis Tags */}
          {structuralLevels.map((lvl) => {
            const y = priceToY(lvl.price);
            if (y < plotTop - 6 || y > plotBottom + 6) return null;
            return (
              <g key={lvl.label}>
                <line
                  x1={plotLeft}
                  y1={y}
                  x2={plotRight}
                  y2={y}
                  stroke={lvl.color}
                  strokeWidth={lvl.width}
                  strokeDasharray={lvl.dash === "0" ? undefined : lvl.dash}
                  opacity={0.85}
                />
                <rect
                  x={plotRight + 4}
                  y={y - 8}
                  width={84}
                  height={16}
                  rx={3}
                  fill="#111422"
                  stroke={lvl.color}
                  strokeWidth={0.8}
                />
                <text
                  x={plotRight + 8}
                  y={y + 3}
                  fill={lvl.color}
                  fontSize="9"
                  fontFamily="monospace"
                  fontWeight="bold"
                >
                  {lvl.label} {lvl.price.toFixed(0)}
                </text>
              </g>
            );
          })}

          {/* Intraday Gamma Concentration Dots along King, Call Wall, Put Wall */}
          {candles.map((c, idx) => {
            if (idx % 3 !== 0) return null;
            const x = idxToX(idx);
            return (
              <g key={`dots-${idx}`}>
                <circle
                  cx={x}
                  cy={priceToY(kingStrike)}
                  r={3.2}
                  fill="#facc15"
                  opacity={0.75}
                />
                <circle
                  cx={x}
                  cy={priceToY(putWall)}
                  r={2.8}
                  fill="#a855f7"
                  opacity={0.7}
                />
                <circle
                  cx={x}
                  cy={priceToY(callWall)}
                  r={2.5}
                  fill="#14b8a6"
                  opacity={0.65}
                />
              </g>
            );
          })}

          {/* Flow VWAP ±2σ / ±1σ Dispersion Cloud & Centerline */}
          {flowBandPolygon && (
            <polygon
              points={flowBandPolygon}
              fill="rgba(245, 158, 11, 0.045)"
            />
          )}
          <polyline
            fill="none"
            stroke="rgba(203, 213, 225, 0.5)"
            strokeWidth="1.1"
            strokeDasharray="2 2.5"
            points={upper2Points}
          />
          <polyline
            fill="none"
            stroke="rgba(203, 213, 225, 0.5)"
            strokeWidth="1.1"
            strokeDasharray="2 2.5"
            points={lower2Points}
          />
          <polyline
            fill="none"
            stroke="rgba(148, 163, 184, 0.38)"
            strokeWidth="1.0"
            strokeDasharray="1.5 2.5"
            points={upper1Points}
          />
          <polyline
            fill="none"
            stroke="rgba(148, 163, 184, 0.38)"
            strokeWidth="1.0"
            strokeDasharray="1.5 2.5"
            points={lower1Points}
          />
          <polyline
            fill="none"
            stroke="#f59e0b"
            strokeWidth="2.2"
            points={flowVwapPoints}
            opacity={0.96}
          />

          {/* SMA 5D (Purple) & SMA 34 (Coral) Polylines */}
          <polyline
            fill="none"
            stroke="#c084fc"
            strokeWidth="1.6"
            points={sma5dPoints}
            opacity={0.85}
          />
          <polyline
            fill="none"
            stroke="#fb7185"
            strokeWidth="1.75"
            points={sma34Points}
            opacity={0.95}
          />

          {/* OHLC Candlesticks */}
          {candles.map((c, idx) => {
            const x = idxToX(idx);
            const yHigh = priceToY(c.high);
            const yLow = priceToY(c.low);
            const yOpen = priceToY(c.open);
            const yClose = priceToY(c.close);
            const isBull = c.close >= c.open;
            const color = isBull ? "#2dce89" : "#f5365c";
            const bodyTop = Math.min(yOpen, yClose);
            const bodyH = Math.max(2, Math.abs(yClose - yOpen));

            return (
              <g key={c.index}>
                <line
                  x1={x}
                  y1={yHigh}
                  x2={x}
                  y2={yLow}
                  stroke={color}
                  strokeWidth="1.2"
                />
                <rect
                  x={x - 3.2}
                  y={bodyTop}
                  width={6.4}
                  height={bodyH}
                  rx={1}
                  fill={color}
                />
              </g>
            );
          })}

          {/* Tick-Level Accuracy Wick Markers on ±1σ / ±2σ Flow Bands */}
          {flowSeries.map((f, idx) => {
            if (!f.bandSignal) return null;
            const x = idxToX(idx);
            const isUpper =
              f.bandSignal === "UPPER_2S_REJECT" ||
              f.bandSignal === "UPPER_1S_REJECT";
            const y = priceToY(
              isUpper
                ? candles[idx]?.high ?? f.upper1Sigma
                : candles[idx]?.low ?? f.lower1Sigma
            );
            const color = isUpper ? "#f43f5e" : "#10b981";
            return (
              <g key={`band-sig-${idx}`}>
                <circle
                  cx={x}
                  cy={y}
                  r={5.5}
                  fill="none"
                  stroke="#facc15"
                  strokeWidth="1.2"
                  strokeDasharray="2 2"
                />
                <circle cx={x} cy={y} r={2.5} fill={color} />
              </g>
            );
          })}

          {/* Flow VWAP Tag on Right Y-Axis */}
          {latestFlow && (
            <g>
              <rect
                x={plotRight + 4}
                y={priceToY(latestFlow.flowVwap) - 8}
                width={84}
                height={16}
                rx={3}
                fill="#f59e0b"
              />
              <text
                x={plotRight + 8}
                y={priceToY(latestFlow.flowVwap) + 3}
                fill="#000000"
                fontSize="9"
                fontFamily="monospace"
                fontWeight="bold"
              >
                FVWAP {latestFlow.flowVwap.toFixed(1)}
              </text>
            </g>
          )}

          {/* Live Spot Tag on Right Y-Axis */}
          <g>
            <rect
              x={plotRight + 4}
              y={priceToY(spot) - 9}
              width={84}
              height={18}
              rx={4}
              fill="#3b82f6"
            />
            <text
              x={plotRight + 8}
              y={priceToY(spot) + 3}
              fill="#ffffff"
              fontSize="9.5"
              fontFamily="monospace"
              fontWeight="bold"
            >
              SPOT {spot.toFixed(1)}
            </text>
          </g>
        </svg>
      </div>

      {/* Bottom Legend */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-400 pt-1">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1 text-yellow-300">
            <span className="h-0.5 w-3.5 bg-yellow-400 inline-block" />
            King Node
          </span>
          <span className="inline-flex items-center gap-1 text-[#11cdef]">
            <span className="h-0.5 w-3.5 bg-[#11cdef] inline-block" />
            Call wall
          </span>
          <span className="inline-flex items-center gap-1 text-[#f5365c]">
            <span className="h-0.5 w-3.5 bg-[#f5365c] inline-block" />
            Put wall
          </span>
          <span className="inline-flex items-center gap-1 text-slate-300">
            <span className="h-0.5 w-3.5 border-b border-dashed border-slate-400 inline-block" />
            Zero γ
          </span>
          <span className="inline-flex items-center gap-1 text-amber-300">
            <span className="h-0.5 w-3.5 bg-amber-400 inline-block" />
            Flow VWAP (±1σ/±2σ)
          </span>
          <span className="inline-flex items-center gap-1 text-rose-300">
            <span className="h-0.5 w-3.5 bg-rose-400 inline-block" />
            SMA 34
          </span>
          <span className="inline-flex items-center gap-1 text-purple-300">
            <span className="h-0.5 w-3.5 bg-purple-400 inline-block" />
            SMA 5D
          </span>
        </div>
        <span className="text-[10px] text-slate-500">
          Dots = Intraday Pos γ (Yellow/Teal) & Neg γ (Purple) Strike Nodes
        </span>
      </div>
    </div>
  );
}

const CHART_SYMBOLS = ["SPX", "SPY", "QQQ", "IWM"] as const;

export function ChartsView() {
  const [timeframe, setTimeframe] = useState<Timeframe>("5m");
  const [chartPayloads, setChartPayloads] = useState<
    Record<string, OptionsAnalyticsPayload>
  >({});

  useEffect(() => {
    let active = true;
    CHART_SYMBOLS.forEach(async (sym) => {
      try {
        const res = await fetch(`/api/options?ticker=${sym}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data: OptionsAnalyticsPayload = await res.json();
        if (active) {
          setChartPayloads((prev) => ({ ...prev, [sym]: data }));
        }
      } catch {
        // Fallback to preset
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-4">
      {/* Timeframe Selector Pill Bar */}
      <div className="argon-card rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex flex-wrap items-center gap-1 rounded-full bg-[#0b0d17] p-1 border border-white/10">
          {TIMEFRAMES.map((tf) => {
            const active = timeframe === tf;
            return (
              <button
                key={tf}
                type="button"
                onClick={() => setTimeframe(tf)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-mono font-bold transition-all",
                  active
                    ? "bg-[#1c223a] border border-[#5e72e4] text-white shadow-[0_0_10px_rgba(94,114,228,0.5)]"
                    : "text-slate-400 hover:text-white"
                )}
              >
                {tf}
              </button>
            );
          })}
        </div>

        <span className="text-xs font-mono text-slate-400">
          Institutional Price vs. Gamma Structure Overlay · SPX, SPY, QQQ & IWM
        </span>
      </div>

      {/* 4 Stacked Institutional Chart Cards (SPX, SPY, QQQ, IWM) */}
      {CHART_SYMBOLS.map((sym) => (
        <InstitutionalChartCard
          key={sym}
          symbol={sym}
          timeframe={timeframe}
          payload={chartPayloads[sym]}
        />
      ))}
    </div>
  );
}
