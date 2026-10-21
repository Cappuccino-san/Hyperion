"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import { normPDF } from "@/lib/optionsExposure";
import type {
  AntaeusExpirationInfo,
  AntaeusIntradayCandle,
  AntaeusLivePayload,
  AntaeusStrikeExpBucket,
} from "@/app/api/gaia/route";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  Eye,
  Maximize2,
  Menu,
  Minimize2,
  Move,
  Pause,
  Play,
  RotateCcw,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  Sliders,
  Star,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

export type TimeframeMode = "1m" | "3m" | "5m" | "15m";
export type ExposureMetricMode = "GEX" | "VEX" | "Combined";
export type HorizonFilterMode = "ALL" | "NEXT" | "WEEK";
export type ColorPaletteMode = "ice" | "polarity"; // "Monochrome Ice" vs "Polarity"

const POPULAR_TICKERS = [
  "SPY",
  "QQQ",
  "SPXW",
  "IWM",
  "NVDA",
  "TSLA",
  "AAPL",
  "MSFT",
  "AMD",
  "AMZN",
  "META",
  "GOOGL",
];

interface StrikeWaveformRibbon {
  strike: number;
  exposureM: number;
  gexM: number;
  vexM: number;
  callOi: number;
  putOi: number;
}

interface AtlasBarColumn {
  index: number;
  timeLabel: string;
  candle: AntaeusIntradayCandle;
  strikeRibbons: Record<number, StrikeWaveformRibbon>;
  allExpKingStrike: number;
  filteredKingStrike: number;
  callWallStrike: number;
  putWallStrike: number;
  zeroGammaStrike: number;
  maxAbsExposureM: number;
  macroKingStrike: number;
  macroCallWall: number;
  macroPutWall: number;
}

function computeNicePriceTicks(
  min: number,
  max: number,
  targetCount = 6
): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const rawStep = span / targetCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  let niceStepNorm = 1;
  if (normalized > 1.2 && normalized <= 3.0) niceStepNorm = 2;
  else if (normalized > 3.0 && normalized <= 7.0) niceStepNorm = 5;
  else if (normalized > 7.0) niceStepNorm = 10;
  const niceStep = niceStepNorm * magnitude;

  const firstTick = Math.ceil(min / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let t = firstTick; t <= max + niceStep * 0.01; t += niceStep) {
    ticks.push(Number(t.toFixed(2)));
  }
  return ticks.length >= 2 ? ticks : [min, (min + max) / 2, max];
}

function evaluateBucketExposureM(
  spot: number,
  bucket: AntaeusStrikeExpBucket,
  mode: ExposureMetricMode
): { netM: number; gexM: number; vexM: number } {
  const T = Math.max(1 / 365, (bucket.dteDays + 0.5) / 365);
  const sqrtT = Math.sqrt(T);
  const discountQ = Math.exp(-0.012 * T);

  let callGexM = 0;
  let callVexM = 0;
  if (bucket.callOI > 0) {
    const iv = Math.max(0.02, Math.min(3.5, bucket.callIv));
    const d1 =
      (Math.log(Math.max(1e-4, spot / bucket.strike)) +
        (0.045 - 0.012 + 0.5 * iv * iv) * T) /
      (iv * sqrtT);
    const d2 = d1 - iv * sqrtT;
    const pdf = normPDF(d1);
    const bsGamma = (discountQ * pdf) / (spot * iv * sqrtT);
    const gamma =
      bucket.callGamma && bucket.callGamma > 0 ? bucket.callGamma : bsGamma;
    const vanna = -discountQ * pdf * (d2 / iv);

    callGexM = (bucket.callOI * gamma * 100 * (spot * spot) * 0.01) / 1e6;
    callVexM = (bucket.callOI * vanna * 100 * spot * 0.01) / 1e6;
  }

  let putGexM = 0;
  let putVexM = 0;
  if (bucket.putOI > 0) {
    const iv = Math.max(0.02, Math.min(3.5, bucket.putIv));
    const d1 =
      (Math.log(Math.max(1e-4, spot / bucket.strike)) +
        (0.045 - 0.012 + 0.5 * iv * iv) * T) /
      (iv * sqrtT);
    const d2 = d1 - iv * sqrtT;
    const pdf = normPDF(d1);
    const bsGamma = (discountQ * pdf) / (spot * iv * sqrtT);
    const gamma =
      bucket.putGamma && bucket.putGamma > 0 ? bucket.putGamma : bsGamma;
    const vanna = -discountQ * pdf * (d2 / iv);

    putGexM = (bucket.putOI * gamma * 100 * (spot * spot) * 0.01) / 1e6;
    putVexM = (bucket.putOI * vanna * 100 * spot * 0.01) / 1e6;
  }

  const netGexM = callGexM - putGexM;
  const netVexM = callVexM - putVexM;

  let netM = netGexM;
  if (mode === "VEX") netM = netVexM;
  else if (mode === "Combined") netM = netGexM + netVexM;

  return { netM, gexM: netGexM, vexM: netVexM };
}

function aggregateCandles(
  baseCandles: AntaeusIntradayCandle[],
  timeframe: TimeframeMode
): AntaeusIntradayCandle[] {
  if (!baseCandles || baseCandles.length === 0) return [];
  if (timeframe === "5m") return baseCandles;

  if (timeframe === "15m") {
    const res: AntaeusIntradayCandle[] = [];
    for (let i = 0; i < baseCandles.length; i += 3) {
      const slice = baseCandles.slice(i, i + 3);
      if (slice.length === 0) continue;
      const first = slice[0];
      const last = slice[slice.length - 1];
      const high = Math.max(...slice.map((c) => c.high));
      const low = Math.min(...slice.map((c) => c.low));
      res.push({
        ...first,
        index: res.length,
        timestamp: first.timestamp,
        timeLabel: first.timeLabel,
        open: first.open,
        high,
        low,
        close: last.close,
      });
    }
    return res;
  }

  if (timeframe === "3m") {
    const subBars: { ts: number; price: number }[] = [];
    baseCandles.forEach((c) => {
      subBars.push({ ts: c.timestamp, price: c.open });
      subBars.push({
        ts: c.timestamp + 60,
        price: c.open < c.close ? c.low : c.high,
      });
      subBars.push({ ts: c.timestamp + 120, price: (c.high + c.low) / 2 });
      subBars.push({
        ts: c.timestamp + 180,
        price: c.open < c.close ? c.high : c.low,
      });
      subBars.push({ ts: c.timestamp + 240, price: c.close });
    });

    const res: AntaeusIntradayCandle[] = [];
    const intervalSec = 180;
    const startTs = baseCandles[0].timestamp;
    const endTs = baseCandles[baseCandles.length - 1].timestamp + 300;

    for (let ts = startTs; ts < endTs; ts += intervalSec) {
      const pts = subBars.filter((p) => p.ts >= ts && p.ts < ts + intervalSec);
      if (pts.length === 0) continue;
      const prices = pts.map((p) => p.price);
      const open = prices[0];
      const close = prices[prices.length - 1];
      const high = Math.max(...prices);
      const low = Math.min(...prices);

      const d = new Date(ts * 1000);
      const timeLabel = d.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      res.push({
        index: res.length,
        timestamp: ts,
        timeLabel,
        open,
        high,
        low,
        close,
        sma34: close,
        sma5d: close,
        ema21d: close,
        sma55d: close,
        rsi14: 50,
        macdHist: 0,
      });
    }
    return res.length > 0 ? res : baseCandles;
  }

  if (timeframe === "1m") {
    const res: AntaeusIntradayCandle[] = [];
    baseCandles.forEach((c) => {
      const isUp = c.close >= c.open;
      const m1 = c.open;
      const m2 = isUp ? c.low : c.high;
      const m3 = (c.high + c.low) / 2;
      const m4 = isUp ? c.high : c.low;
      const m5 = c.close;
      const subs = [
        { open: m1, high: Math.max(m1, m2), low: Math.min(m1, m2), close: m2 },
        { open: m2, high: Math.max(m2, m3), low: Math.min(m2, m3), close: m3 },
        { open: m3, high: Math.max(m3, m4), low: Math.min(m3, m4), close: m4 },
        { open: m4, high: Math.max(m4, m5), low: Math.min(m4, m5), close: m5 },
        { open: m4, high: c.high, low: c.low, close: m5 },
      ];
      subs.forEach((s, subIdx) => {
        const ts = c.timestamp + subIdx * 60;
        const d = new Date(ts * 1000);
        const timeLabel = d.toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        res.push({
          index: res.length,
          timestamp: ts,
          timeLabel,
          open: s.open,
          high: s.high,
          low: s.low,
          close: s.close,
          sma34: s.close,
          sma5d: s.close,
          ema21d: s.close,
          sma55d: s.close,
          rsi14: c.rsi14,
          macdHist: c.macdHist,
        });
      });
    });
    return res.length > 0 ? res : baseCandles;
  }

  return baseCandles;
}

export function AtlasView() {
  const storeTicker = useDashboardStore((state) => state.activeTicker);
  const setStoreTicker = useDashboardStore((state) => state.setTicker);
  const fetchOptionsChain = useDashboardStore(
    (state) => state.fetchOptionsChain
  );

  const [activeTicker, setActiveTicker] = useState<string>(
    storeTicker || "SPY"
  );
  const [livePayload, setLivePayload] = useState<AntaeusLivePayload | null>(
    null
  );
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // View state & user toggles
  const [timeframe, setTimeframe] = useState<TimeframeMode>("3m");
  const [exposureMode, setExposureMode] =
    useState<ExposureMetricMode>("GEX");
  const [horizonFilter, setHorizonFilter] =
    useState<HorizonFilterMode>("NEXT");
  const [paletteMode, setPaletteMode] =
    useState<ColorPaletteMode>("polarity");

  // Replay states
  const [isReplayActive, setIsReplayActive] = useState<boolean>(false);
  const [isReplayPlaying, setIsReplayPlaying] = useState<boolean>(false);
  const [replaySpeed, setReplaySpeed] = useState<1 | 2 | 4>(1);
  const [activeBarIndex, setActiveBarIndex] = useState<number>(0);
  const [hoverBarIndex, setHoverBarIndex] = useState<number | null>(null);

  // Overlays & drawer popovers
  const [levelsDrawerOpen, setLevelsDrawerOpen] = useState<boolean>(false);
  const [tickerSelectorOpen, setTickerSelectorOpen] =
    useState<boolean>(false);
  const [timeframeSelectorOpen, setTimeframeSelectorOpen] =
    useState<boolean>(false);
  const [toolsPopoverOpen, setToolsPopoverOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [isStarred, setIsStarred] = useState<boolean>(false);
  const [tickerSearchQuery, setTickerSearchQuery] = useState<string>("");

  // Settings
  const [sensitivityThreshold, setSensitivityThreshold] =
    useState<number>(0.15); // 0.05 .. 0.40
  const [glowIntensity, setGlowIntensity] = useState<number>(1.0); // 0.2 .. 2.0
  const [showGridlines, setShowGridlines] = useState<boolean>(true);
  const [showPriceRay, setShowPriceRay] = useState<boolean>(true);

  // Interactive Sizing & Zoom/Pan Adjustment States
  const [chartHeight, setChartHeight] = useState<number>(600); // 480 .. 860 px
  const [yScale, setYScale] = useState<number>(1.0); // 0.15 .. 12.0 (vertical zoom multiplier)
  const [yPanOffset, setYPanOffset] = useState<number>(0); // vertical pan in price units
  const [xScale, setXScale] = useState<number>(1.0); // 0.5 .. 4.0 (horizontal zoom)
  const [xPanOffset, setXPanOffset] = useState<number>(0); // horizontal pan in bar units
  const [scopeMode, setScopeMode] = useState<"focus" | "tactical" | "macro">("tactical");

  // Drag interaction state
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragMode, setDragMode] = useState<
    "pan" | "scaleY" | "scaleX" | null
  >(null);
  const [dragStart, setDragStart] = useState<{
    x: number;
    y: number;
    yPan: number;
    xPan: number;
    yScale: number;
    xScale: number;
  }>({
    x: 0,
    y: 0,
    yPan: 0,
    xPan: 0,
    yScale: 1.0,
    xScale: 1.0,
  });

  // Countdown timer for next forming candle in live mode
  const [countdownSec, setCountdownSec] = useState<number>(180);

  // Canvas refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState<number>(1040);
  const [hoverCursor, setHoverCursor] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Fetch /api/gaia?ticker=${activeTicker}
  const fetchLiveAtlas = useCallback(
    async (ticker: string) => {
      try {
        setErrorMsg(null);
        const res = await fetch(
          `/api/gaia?ticker=${encodeURIComponent(ticker)}`,
          {
            cache: "no-store",
          }
        );
        const data = await res.json();
        if (!res.ok || data?.error) {
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        const payload = data as AntaeusLivePayload;
        setLivePayload(payload);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "Live options feed currently unavailable";
        setErrorMsg(msg);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // Sync with global store ticker changes
  useEffect(() => {
    if (storeTicker && storeTicker !== activeTicker) {
      setActiveTicker(storeTicker);
    }
  }, [storeTicker, activeTicker]);

  // Initial fetch
  useEffect(() => {
    fetchLiveAtlas(activeTicker);
  }, [activeTicker, fetchLiveAtlas]);

  // Polling: every 5 seconds when in pure Live Tracking Mode (isReplayActive == false)
  useEffect(() => {
    if (isReplayActive) return;
    const interval = setInterval(() => {
      fetchLiveAtlas(activeTicker);
    }, 5000);
    return () => clearInterval(interval);
  }, [isReplayActive, activeTicker, fetchLiveAtlas]);

  // Handle countdown timer tick (1s interval)
  useEffect(() => {
    const tfSec =
      timeframe === "1m"
        ? 60
        : timeframe === "3m"
          ? 180
          : timeframe === "5m"
            ? 300
            : 900;

    const timer = setInterval(() => {
      const now = new Date();
      const secInHour = now.getMinutes() * 60 + now.getSeconds();
      const remaining = tfSec - (secInHour % tfSec);
      setCountdownSec(remaining === 0 ? tfSec : remaining);
    }, 1000);

    return () => clearInterval(timer);
  }, [timeframe]);

  // ResizeObserver for canvas width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 200) {
        setCanvasWidth(Math.floor(rect.width));
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Aggregated candles based on timeframe
  const candles = useMemo(() => {
    if (!livePayload?.candles) return [];
    return aggregateCandles(livePayload.candles, timeframe);
  }, [livePayload?.candles, timeframe]);

  // Auto-snap activeBarIndex to tip in live mode
  useEffect(() => {
    if (!isReplayActive && candles.length > 0) {
      setActiveBarIndex(candles.length - 1);
    }
  }, [isReplayActive, candles.length]);

  // Filter option buckets according to horizon
  const filteredBuckets = useMemo(() => {
    if (!livePayload?.optionBuckets) return [];
    const all = livePayload.optionBuckets;
    if (horizonFilter === "ALL") return all;

    const expirations = livePayload.expirations || [];
    if (horizonFilter === "NEXT") {
      const nextDate = expirations[0]?.isoDate;
      return nextDate ? all.filter((b) => b.expiration === nextDate) : all;
    }
    if (horizonFilter === "WEEK") {
      const weekDates = new Set(
        expirations.filter((e) => e.isThisWeek).map((e) => e.isoDate)
      );
      return all.filter((b) => weekDates.has(b.expiration));
    }
    return all;
  }, [livePayload?.optionBuckets, livePayload?.expirations, horizonFilter]);

  // Calculate top structural strikes, price domain & columns across all candles
  const atlasModel = useMemo(() => {
    if (!livePayload || candles.length === 0) return null;

    const spot = livePayload.spotPrice;
    const priorClose = livePayload.priorClose;
    const strikeStep = livePayload.strikeStep || 1.0;
    const sigma1Move = livePayload.sigma1Move || spot * 0.012;

    // Identify all unique strikes
    const allStrikes = Array.from(
      new Set(filteredBuckets.map((b) => b.strike))
    ).sort((a, b) => b - a);

    // Macro walls across all option buckets
    let macroKingStrike = 760;
    let maxMacroKingVal = -1;
    let macroCallWall = 780;
    let maxMacroCallGex = -Infinity;
    let macroPutWall = 760;
    let minMacroPutGex = Infinity;

    const macroNetMap = new Map<number, number>();
    const macroCallMap = new Map<number, number>();
    const macroPutMap = new Map<number, number>();

    for (const bucket of livePayload.optionBuckets) {
      const { netM, gexM } = evaluateBucketExposureM(spot, bucket, "GEX");
      macroNetMap.set(
        bucket.strike,
        (macroNetMap.get(bucket.strike) || 0) + netM
      );
      if (bucket.callOI > 0) {
        macroCallMap.set(
          bucket.strike,
          (macroCallMap.get(bucket.strike) || 0) + gexM
        );
      }
      if (bucket.putOI > 0) {
        macroPutMap.set(
          bucket.strike,
          (macroPutMap.get(bucket.strike) || 0) + gexM
        );
      }
    }

    for (const [s, net] of Array.from(macroNetMap.entries())) {
      if (Math.abs(net) > maxMacroKingVal) {
        maxMacroKingVal = Math.abs(net);
        macroKingStrike = s;
      }
    }
    for (const [s, gex] of Array.from(macroCallMap.entries())) {
      if (s >= spot && gex > maxMacroCallGex) {
        maxMacroCallGex = gex;
        macroCallWall = s;
      }
    }
    for (const [s, gex] of Array.from(macroPutMap.entries())) {
      if (s <= spot && gex < minMacroPutGex) {
        minMacroPutGex = gex;
        macroPutWall = s;
      }
    }

    // 1. Core intraday prices from candles
    const candlePrices = candles.flatMap((c) => [c.high, c.low, c.open, c.close]);
    if (candlePrices.length === 0) candlePrices.push(spot);

    const candleMin = Math.min(...candlePrices);
    const candleMax = Math.max(...candlePrices);
    const candleSpan = Math.max(1.0, candleMax - candleMin);

    // 2. Tactical levels near spot (only include in base fit if within ±2.5× daily EM or ±3.5% of spot)
    const maxDistance = Math.max(6 * strikeStep, sigma1Move * 2.2, spot * 0.035);
    const nearLevels = [
      spot,
      priorClose,
      priorClose + sigma1Move,
      priorClose - sigma1Move,
      macroCallWall,
      macroPutWall,
      macroKingStrike,
    ].filter((p) => p != null && Math.abs(p - spot) <= maxDistance);

    const anchorPrices = [...candlePrices, ...nearLevels];
    const baseMin = Math.min(...anchorPrices);
    const baseMax = Math.max(...anchorPrices);
    const baseSpan = Math.max(2.5, baseMax - baseMin);

    // Clean padding around the action (18% above and below)
    const basePad = Math.max(1.0, baseSpan * 0.18);
    const baseCenter = (baseMin + baseMax) / 2;
    const baseRawSpan = baseSpan + basePad * 2;

    // Apply interactive yScale (zoom factor) and yPanOffset (pan delta in price points)
    const effectiveSpan = baseRawSpan / Math.max(0.1, yScale);
    const effectiveCenter = baseCenter + yPanOffset;
    const yMin = Number((effectiveCenter - effectiveSpan / 2).toFixed(2));
    const yMax = Number((effectiveCenter + effectiveSpan / 2).toFixed(2));

    // Dynamic visible strikes that fall within the current viewport window
    const visibleStrikes = allStrikes.filter(
      (s) => s >= yMin - strikeStep * 3 && s <= yMax + strikeStep * 3
    );
    const visibleStrikeSet = new Set(visibleStrikes);

    // Dynamic nice price ticks
    const yAxisTicks = computeNicePriceTicks(yMin, yMax, 6);

    // Compute strike exposures per bar
    let globalMaxExposureM = 1.0;
    const columns: AtlasBarColumn[] = candles.map((candle, cIdx) => {
      const cSpot = candle.close;
      const strikeRibbons: Record<number, StrikeWaveformRibbon> = {};
      const strikeGexMap = new Map<number, number>();
      const strikeVexMap = new Map<number, number>();
      const strikeNetMap = new Map<number, number>();

      for (const bucket of filteredBuckets) {
        const { netM, gexM, vexM } = evaluateBucketExposureM(
          cSpot,
          bucket,
          exposureMode
        );
        strikeNetMap.set(
          bucket.strike,
          (strikeNetMap.get(bucket.strike) || 0) + netM
        );
        strikeGexMap.set(
          bucket.strike,
          (strikeGexMap.get(bucket.strike) || 0) + gexM
        );
        strikeVexMap.set(
          bucket.strike,
          (strikeVexMap.get(bucket.strike) || 0) + vexM
        );
      }

      // Populate ribbons for visible strikes
      for (const s of visibleStrikes) {
        const netVal = strikeNetMap.get(s) || 0;
        const gexVal = strikeGexMap.get(s) || 0;
        const vexVal = strikeVexMap.get(s) || 0;
        const absVal = Math.abs(netVal);
        if (absVal > globalMaxExposureM) globalMaxExposureM = absVal;

        strikeRibbons[s] = {
          strike: s,
          exposureM: Number(netVal.toFixed(2)),
          gexM: Number(gexVal.toFixed(2)),
          vexM: Number(vexVal.toFixed(2)),
          callOi: 0,
          putOi: 0,
        };
      }

      // Determine King strike, Call Wall, Put Wall, Zero Gamma
      let allExpKing = visibleStrikes[0] || Math.round(cSpot);
      let maxKingVal = -1;
      let callWall = cSpot;
      let maxCallGex = -Infinity;
      let putWall = cSpot;
      let minPutGex = Infinity;

      for (const [s, val] of Array.from(strikeNetMap.entries())) {
        if (Math.abs(val) > maxKingVal) {
          maxKingVal = Math.abs(val);
          allExpKing = s;
        }
      }

      for (const [s, gex] of Array.from(strikeGexMap.entries())) {
        if (s >= cSpot && gex > maxCallGex) {
          maxCallGex = gex;
          callWall = s;
        }
        if (s <= cSpot && gex < minPutGex) {
          minPutGex = gex;
          putWall = s;
        }
      }

      // Zero Gamma flip price
      let zeroGamma = cSpot;
      const sortedStrikes = Array.from(strikeGexMap.keys()).sort(
        (a, b) => a - b
      );
      for (let i = 0; i < sortedStrikes.length - 1; i++) {
        const s1 = sortedStrikes[i];
        const s2 = sortedStrikes[i + 1];
        const g1 = strikeGexMap.get(s1) || 0;
        const g2 = strikeGexMap.get(s2) || 0;
        if ((g1 <= 0 && g2 >= 0) || (g1 >= 0 && g2 <= 0)) {
          zeroGamma = Number(((s1 + s2) / 2).toFixed(2));
          break;
        }
      }

      return {
        index: cIdx,
        timeLabel: candle.timeLabel,
        candle,
        strikeRibbons,
        allExpKingStrike: allExpKing,
        filteredKingStrike: allExpKing,
        callWallStrike: callWall,
        putWallStrike: putWall,
        zeroGammaStrike: zeroGamma,
        maxAbsExposureM: maxKingVal,
        macroKingStrike,
        macroCallWall,
        macroPutWall,
      };
    });

    return {
      spot,
      priorClose,
      strikeStep,
      sigma1Move,
      visibleStrikes,
      columns,
      globalMaxExposureM,
      yMin,
      yMax,
      yAxisTicks,
    };
  }, [livePayload, candles, filteredBuckets, exposureMode, yScale, yPanOffset]);

  // Replay playback ticker loop
  useEffect(() => {
    if (!isReplayPlaying || !atlasModel) return;
    const intervalMs =
      replaySpeed === 1 ? 240 : replaySpeed === 2 ? 120 : 60;
    const timer = setInterval(() => {
      setActiveBarIndex((prev) => {
        if (prev >= atlasModel.columns.length - 1) {
          setIsReplayPlaying(false);
          return atlasModel.columns.length - 1;
        }
        return prev + 1;
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [isReplayPlaying, replaySpeed, atlasModel]);

  // Safe display indices
  const maxBarIdx = Math.max(0, (candles.length || 1) - 1);
  const safeActiveIdx = Math.min(activeBarIndex, maxBarIdx);
  const displayIdx =
    hoverBarIndex !== null
      ? Math.min(safeActiveIdx, hoverBarIndex)
      : safeActiveIdx;

  const currentColumn = atlasModel?.columns[displayIdx];
  const activeCandle = currentColumn?.candle ?? candles[displayIdx];
  const activePrice = activeCandle ? activeCandle.close : livePayload?.spotPrice ?? 0;
  const priorClose = livePayload?.priorClose ?? activePrice;
  const change = activePrice - priorClose;
  const changePct = priorClose > 0 ? (change / priorClose) * 100 : 0;

  // Active nodes summary for drawer
  const activeNodes = useMemo(() => {
    if (!currentColumn) {
      return {
        king: 0,
        zeroDteKing: 0,
        callWall: 0,
        putWall: 0,
        zeroGamma: 0,
        macroCallWall: 0,
        macroPutWall: 0,
      };
    }
    return {
      king: currentColumn.macroKingStrike || 760,
      zeroDteKing: currentColumn.filteredKingStrike,
      callWall: currentColumn.callWallStrike,
      putWall: currentColumn.putWallStrike,
      zeroGamma: currentColumn.zeroGammaStrike,
      macroCallWall: currentColumn.macroCallWall || 780,
      macroPutWall: currentColumn.macroPutWall || 760,
    };
  }, [currentColumn]);

  // =========================================================================
  // Canvas Rendering Engine (Pitch-Black #000000, Comet-Tail Acoustic Ribbons)
  // =========================================================================
  useEffect(() => {
    if (!atlasModel || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvasWidth;
    const height = chartHeight;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Pure Pitch-Black Canvas Background
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    // Layout margins
    const padLeft = 14;
    const rightAxisWidth = 74;
    const plotRightX = width - rightAxisWidth;
    const padTop = 38; // space for top telemetry
    const padBottom = 28;
    const plotHeight = height - padTop - padBottom;
    const plotWidth = plotRightX - padLeft;

    const { yMin, yMax, visibleStrikes, strikeStep, globalMaxExposureM } =
      atlasModel;

    const priceToY = (price: number): number => {
      const ratio = (price - yMin) / Math.max(0.0001, yMax - yMin);
      return padTop + (1 - ratio) * plotHeight;
    };

    const totalSlots = Math.max(candles.length, 36);
    const baseStepX = plotWidth / totalSlots;
    const stepX = baseStepX * xScale;
    const barToX = (idx: number): number =>
      padLeft + (idx + 0.5 + xPanOffset) * stepX;

    // 2. Subtle Gridlines (optional)
    if (showGridlines) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
      ctx.lineWidth = 1;
      atlasModel.yAxisTicks.forEach((tickPrice) => {
        const y = Math.round(priceToY(tickPrice)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(plotRightX, y);
        ctx.stroke();
      });

      // Right axis boundary line
      ctx.strokeStyle = "#1a202c";
      ctx.beginPath();
      ctx.moveTo(plotRightX + 0.5, padTop);
      ctx.lineTo(plotRightX + 0.5, height - padBottom);
      ctx.stroke();
    }

    // 3. LAYER 1: Dynamic "Comet-Tail / Acoustic-Waveform" Node Pulse Ribbons
    const sigmaProx = Math.max(
      2.0,
      strikeStep * 2.5,
      atlasModel.sigma1Move * 0.25
    );
    const sigmaProxSq2 = 2 * sigmaProx * sigmaProx;

    // Draw acoustic waveforms up to safeActiveIdx
    for (let t = 0; t <= safeActiveIdx; t++) {
      const col = atlasModel.columns[t];
      if (!col) continue;

      const cx = barToX(t);
      const spotAtBar = col.candle.close;
      const isKingCol = col.allExpKingStrike;

      for (const strike of visibleStrikes) {
        const ribbon = col.strikeRibbons[strike];
        const expVal = ribbon?.exposureM ?? 0;
        const absExp = Math.abs(expVal);

        const cy = priceToY(strike);

        // Price proximity weighting: W = exp(-(K - S_t)^2 / (2 * sigma_prox^2))
        const dist = strike - spotAtBar;
        const proximityWeight = Math.exp(-(dist * dist) / sigmaProxSq2);

        // Base exposure normalized score: e = (|E| / maxE)^0.75
        const expNorm = Math.pow(
          Math.min(1.0, absExp / Math.max(1, globalMaxExposureM)),
          0.75
        );

        // Intensity I in [0, 1]
        const intensity = Math.min(
          1.0,
          Math.max(
            0.0,
            expNorm * (0.2 + 0.8 * proximityWeight) * (1 / sensitivityThreshold)
          )
        );

        // Filter out negligible ribbons
        if (intensity < 0.06) continue;

        const isKingStrike = strike === isKingCol;

        // Waveform capsule dimensions
        const capsuleW = Math.max(
          2.0,
          Math.min(stepX * 0.55, 2.0 + 3.0 * intensity)
        );
        const capsuleH = Math.max(3.0, 3.0 + intensity * 15.0);

        ctx.save();

        if (paletteMode === "ice") {
          // Monochrome Ice (White Glow)
          if (intensity >= 0.65 || isKingStrike) {
            ctx.shadowBlur = Math.round(10 * glowIntensity);
            ctx.shadowColor = "#38bdf8";
            ctx.fillStyle = "#ffffff";
            ctx.globalAlpha = 0.95;
          } else if (intensity >= 0.22) {
            ctx.shadowBlur = Math.round(4 * glowIntensity);
            ctx.shadowColor = "rgba(56, 189, 248, 0.4)";
            ctx.fillStyle = "#bae6fd";
            ctx.globalAlpha = 0.75;
          } else {
            // Low intensity thin dash
            ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
            ctx.globalAlpha = 0.5;
            ctx.fillRect(
              cx - capsuleW * 0.5,
              cy - 0.5,
              Math.max(2, stepX * 0.45),
              1
            );
            ctx.restore();
            continue;
          }
        } else {
          // Polarity (Cyan / Purple / Gold)
          if (isKingStrike) {
            ctx.shadowBlur = Math.round(12 * glowIntensity);
            ctx.shadowColor = "rgba(250, 204, 21, 0.75)";
            ctx.fillStyle = "#facc15";
            ctx.globalAlpha = 0.95;
          } else if (expVal >= 0) {
            // Positive gamma / call wall
            ctx.shadowBlur =
              intensity >= 0.4 ? Math.round(8 * glowIntensity) : 0;
            ctx.shadowColor = "rgba(34, 211, 238, 0.6)";
            ctx.fillStyle = "#22d3ee";
            ctx.globalAlpha = Math.min(0.9, 0.35 + intensity * 0.6);
          } else {
            // Negative gamma / put wall
            ctx.shadowBlur =
              intensity >= 0.4 ? Math.round(8 * glowIntensity) : 0;
            ctx.shadowColor = "rgba(192, 132, 252, 0.6)";
            ctx.fillStyle = "#c084fc";
            ctx.globalAlpha = Math.min(0.9, 0.35 + intensity * 0.6);
          }

          if (intensity < 0.22 && !isKingStrike) {
            // Low intensity dash
            ctx.fillRect(
              cx - capsuleW * 0.5,
              cy - 0.5,
              Math.max(2, stepX * 0.45),
              1
            );
            ctx.restore();
            continue;
          }
        }

        // Draw vertical acoustic capsule centered at (cx, cy)
        const rx = capsuleW / 2;
        const topY = cy - capsuleH / 2;
        ctx.beginPath();
        ctx.roundRect(cx - rx, topY, capsuleW, capsuleH, rx);
        ctx.fill();
        ctx.restore();
      }
    }

    // Horizontal benchmark line at All-exp King node
    if (currentColumn) {
      const kingY = priceToY(currentColumn.allExpKingStrike);
      ctx.save();
      ctx.strokeStyle = "rgba(234, 179, 8, 0.65)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(padLeft, kingY);
      ctx.lineTo(plotRightX, kingY);
      ctx.stroke();
      ctx.restore();
    }

    // 4. LAYER 2: Candlesticks Overlay
    const candleWidth = Math.max(3.0, Math.min(stepX * 0.62, 7.5));
    for (let t = 0; t <= safeActiveIdx; t++) {
      const c = candles[t];
      if (!c) continue;

      const cx = barToX(t);
      const yOpen = priceToY(c.open);
      const yClose = priceToY(c.close);
      const yHigh = priceToY(c.high);
      const yLow = priceToY(c.low);
      const isGreen = c.close >= c.open;

      const wickColor = isGreen ? "#10b981" : "#f43f5e";
      const bodyColor = isGreen ? "#10b981" : "#f43f5e";

      // Wick
      ctx.strokeStyle = wickColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, yHigh);
      ctx.lineTo(cx, yLow);
      ctx.stroke();

      // Body
      const topBody = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));
      ctx.fillStyle = bodyColor;
      ctx.fillRect(cx - candleWidth / 2, topBody, candleWidth, bodyHeight);
    }

    // 5. Forming Candle Pulsing Indicator & Live Price Ray
    if (activeCandle && showPriceRay) {
      const tipX = barToX(safeActiveIdx);
      const tipY = priceToY(activeCandle.close);
      const isGreen = activeCandle.close >= activeCandle.open;

      // Price Ray across to right axis
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = isGreen
        ? "rgba(16, 185, 129, 0.65)"
        : "rgba(244, 63, 94, 0.65)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(plotRightX, tipY);
      ctx.stroke();
      ctx.restore();

      // Pulsing dot at forming candle tip
      ctx.save();
      ctx.shadowBlur = 8;
      ctx.shadowColor = isGreen ? "#10b981" : "#f43f5e";
      ctx.fillStyle = isGreen ? "#10b981" : "#f43f5e";
      ctx.beginPath();
      ctx.arc(tipX, tipY, 3.5, 0, Math.PI * 2);
      ctx.fill();

      // Subtle outer ring
      ctx.strokeStyle = isGreen
        ? "rgba(16, 185, 129, 0.5)"
        : "rgba(244, 63, 94, 0.5)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 7.0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 6. Crosshair on Hover
    if (hoverCursor) {
      const hx = Math.max(padLeft, Math.min(plotRightX, hoverCursor.x));
      const hy = Math.max(padTop, Math.min(height - padBottom, hoverCursor.y));

      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);

      // Vertical line
      ctx.beginPath();
      ctx.moveTo(hx, padTop);
      ctx.lineTo(hx, height - padBottom);
      ctx.stroke();

      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(padLeft, hy);
      ctx.lineTo(plotRightX, hy);
      ctx.stroke();
      ctx.restore();
    }

    // 7. Right Price Axis Gutter & Badges
    ctx.fillStyle = "#000000";
    ctx.fillRect(plotRightX, 0, rightAxisWidth, height);

    ctx.strokeStyle = "#1a202c";
    ctx.beginPath();
    ctx.moveTo(plotRightX + 0.5, 0);
    ctx.lineTo(plotRightX + 0.5, height);
    ctx.stroke();

    // Standard y-ticks
    ctx.fillStyle = "#64748b";
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    atlasModel.yAxisTicks.forEach((tickPrice) => {
      const y = priceToY(tickPrice);
      if (y >= padTop && y <= height - padBottom) {
        ctx.fillText(tickPrice.toFixed(2), plotRightX + 8, y + 3);
      }
    });

    // King Badge on Right Axis
    if (currentColumn) {
      const kingPrice = currentColumn.allExpKingStrike;
      const ky = priceToY(kingPrice);
      if (ky >= padTop - 6 && ky <= height - padBottom + 6) {
        ctx.save();
        ctx.fillStyle = "rgba(234, 179, 8, 0.2)";
        ctx.strokeStyle = "#eab308";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(plotRightX + 4, ky - 8, rightAxisWidth - 8, 16, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#facc15";
        ctx.font = "bold 9px ui-monospace, monospace";
        ctx.fillText(`★ ${kingPrice.toFixed(0)}`, plotRightX + 8, ky + 3);
        ctx.restore();
      }
    }

    // Live Spot Price Badge on Right Axis
    if (activeCandle) {
      const rawSy = priceToY(activeCandle.close);
      const sy = Math.max(padTop + 9, Math.min(height - padBottom - 9, rawSy));
      const isGreen = activeCandle.close >= activeCandle.open;
      ctx.save();
      ctx.fillStyle = isGreen ? "#10b981" : "#f43f5e";
      ctx.beginPath();
      ctx.roundRect(plotRightX + 3, sy - 9, rightAxisWidth - 6, 18, 4);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px ui-monospace, monospace";
      ctx.fillText(activeCandle.close.toFixed(2), plotRightX + 6, sy + 4);
      ctx.restore();
    }

    // Hover Price Badge on Right Axis
    if (
      hoverCursor &&
      hoverCursor.x >= padLeft &&
      hoverCursor.x <= plotRightX &&
      hoverCursor.y >= padTop &&
      hoverCursor.y <= height - padBottom
    ) {
      const cursorRatio = 1 - (hoverCursor.y - padTop) / plotHeight;
      const cursorPrice = yMin + cursorRatio * (yMax - yMin);
      ctx.save();
      ctx.fillStyle = "#1e293b";
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(plotRightX + 3, hoverCursor.y - 8, rightAxisWidth - 6, 16, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#38bdf8";
      ctx.font = "bold 9px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(cursorPrice.toFixed(2), plotRightX + 6, hoverCursor.y + 3);
      ctx.restore();
    }

    // 8. Time Axis along bottom
    ctx.fillStyle = "#64748b";
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "center";
    const timeStep = Math.max(
      1,
      Math.floor(candles.length / 7 / Math.max(0.4, xScale))
    );
    for (let t = 0; t <= safeActiveIdx; t += timeStep) {
      const c = candles[t];
      if (!c) continue;
      const cx = barToX(t);
      if (cx >= padLeft && cx <= plotRightX) {
        ctx.fillText(c.timeLabel, cx, height - 10);
      }
    }

    // Hover Time Badge on Bottom Axis
    if (hoverBarIndex !== null && candles[hoverBarIndex]) {
      const barX = barToX(hoverBarIndex);
      if (barX >= padLeft && barX <= plotRightX) {
        const lbl = candles[hoverBarIndex].timeLabel;
        ctx.save();
        ctx.fillStyle = "#1e293b";
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 1;
        const tw = ctx.measureText(lbl).width + 10;
        ctx.beginPath();
        ctx.roundRect(barX - tw / 2, height - padBottom + 2, tw, 15, 3);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#38bdf8";
        ctx.font = "bold 9px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(lbl, barX, height - padBottom + 13);
        ctx.restore();
      }
    }

    ctx.restore();
  }, [
    atlasModel,
    canvasWidth,
    chartHeight,
    candles,
    safeActiveIdx,
    activeCandle,
    hoverCursor,
    showGridlines,
    showPriceRay,
    sensitivityThreshold,
    glowIntensity,
    paletteMode,
    xScale,
    xPanOffset,
  ]);

  // Window mouseup listener to end any active drag even outside canvas
  useEffect(() => {
    const onWindowMouseUp = () => {
      setIsDragging(false);
      setDragMode(null);
    };
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => window.removeEventListener("mouseup", onWindowMouseUp);
  }, []);

  // Canvas Mouse Down: Start Pan or Y-Scale / X-Scale Drag
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !atlasModel) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const rightAxisWidth = 74;
    const plotRightX = canvasWidth - rightAxisWidth;
    const padBottom = 28;

    if (x >= plotRightX) {
      // User clicked on the right price axis -> Vertical Scale drag
      setIsDragging(true);
      setDragMode("scaleY");
      setDragStart({ x, y, yPan: yPanOffset, xPan: xPanOffset, yScale, xScale });
    } else if (y >= chartHeight - padBottom) {
      // User clicked on the bottom time axis -> Horizontal Scale drag
      setIsDragging(true);
      setDragMode("scaleX");
      setDragStart({ x, y, yPan: yPanOffset, xPan: xPanOffset, yScale, xScale });
    } else {
      // User clicked on the plot -> Pan drag
      setIsDragging(true);
      setDragMode("pan");
      setDragStart({ x, y, yPan: yPanOffset, xPan: xPanOffset, yScale, xScale });
    }
  };

  // Canvas Mouse Move & Hover / Drag handler
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !atlasModel) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setHoverCursor({ x, y });

    const padLeft = 14;
    const rightAxisWidth = 74;
    const plotRightX = canvasWidth - rightAxisWidth;
    const plotWidth = plotRightX - padLeft;
    const padTop = 38;
    const padBottom = 28;
    const plotHeight = chartHeight - padTop - padBottom;

    if (isDragging && dragMode) {
      if (dragMode === "scaleY") {
        // Dragging up = zoom in (taller candles), dragging down = zoom out (compressed candles)
        const dy = dragStart.y - y;
        const scaleMultiplier = Math.exp(dy * 0.008);
        const nextScale = Math.min(
          12.0,
          Math.max(0.15, dragStart.yScale * scaleMultiplier)
        );
        setYScale(nextScale);
      } else if (dragMode === "scaleX") {
        // Dragging right = stretch bars, dragging left = compress bars
        const dx = x - dragStart.x;
        const scaleMultiplier = Math.exp(dx * 0.008);
        const nextScale = Math.min(
          6.0,
          Math.max(0.3, dragStart.xScale * scaleMultiplier)
        );
        setXScale(nextScale);
      } else if (dragMode === "pan") {
        const dy = y - dragStart.y;
        const dx = x - dragStart.x;
        const { yMin, yMax } = atlasModel;
        const pricePerPx = (yMax - yMin) / Math.max(1, plotHeight);
        const totalSlots = Math.max(candles.length, 36);
        const slotsPerPx = totalSlots / Math.max(1, plotWidth * xScale);

        setYPanOffset(dragStart.yPan + dy * pricePerPx);
        setXPanOffset(dragStart.xPan + dx * slotsPerPx);
      }
      return;
    }

    const totalSlots = Math.max(candles.length, 36);
    const stepX = (plotWidth / totalSlots) * xScale;
    const barIdx = Math.floor(
      (x - padLeft - xPanOffset * stepX) / Math.max(1, stepX)
    );
    if (barIdx >= 0 && barIdx <= safeActiveIdx) {
      setHoverBarIndex(barIdx);
    } else {
      setHoverBarIndex(null);
    }
  };

  const handleCanvasMouseUp = () => {
    setIsDragging(false);
    setDragMode(null);
  };

  const handleCanvasMouseLeave = () => {
    setHoverCursor(null);
    setHoverBarIndex(null);
  };

  // Mouse wheel zoom
  const handleCanvasWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    const y = rect ? e.clientY - rect.top : 0;
    const padBottom = 28;

    // Shift key or hovering bottom time axis -> horizontal zoom
    if (e.shiftKey || (rect && y >= chartHeight - padBottom)) {
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
      setXScale((prev) => Math.min(6.0, Math.max(0.3, prev * zoomFactor)));
    } else {
      // Standard wheel -> vertical zoom
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
      setYScale((prev) => Math.min(12.0, Math.max(0.15, prev * zoomFactor)));
    }
  };

  // Double-click to auto-fit / reset
  const handleCanvasDoubleClick = (e?: React.MouseEvent<HTMLElement>) => {
    if (!e) {
      setYScale(1.0);
      setYPanOffset(0);
      setXScale(1.0);
      setXPanOffset(0);
      setScopeMode("tactical");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      setYScale(1.0);
      setYPanOffset(0);
      setXScale(1.0);
      setXPanOffset(0);
      setScopeMode("tactical");
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const rightAxisWidth = 74;
    const plotRightX = canvasWidth - rightAxisWidth;
    const padBottom = 28;

    if (x >= plotRightX) {
      // Reset vertical scale & pan
      setYScale(1.0);
      setYPanOffset(0);
    } else if (y >= chartHeight - padBottom) {
      // Reset horizontal scale & pan
      setXScale(1.0);
      setXPanOffset(0);
    } else {
      // Reset all
      setYScale(1.0);
      setYPanOffset(0);
      setXScale(1.0);
      setXPanOffset(0);
      setScopeMode("tactical");
    }
  };

  const cursorStyle = isDragging
    ? dragMode === "scaleY"
      ? "ns-resize"
      : dragMode === "scaleX"
        ? "ew-resize"
        : "grabbing"
    : hoverCursor && hoverCursor.x >= canvasWidth - 74
      ? "ns-resize"
      : hoverCursor && hoverCursor.y >= chartHeight - 28
        ? "ew-resize"
        : "crosshair";

  // Replay handlers
  const handleToggleReplay = () => {
    if (isReplayActive) {
      // Exit Replay mode
      setIsReplayActive(false);
      setIsReplayPlaying(false);
      setActiveBarIndex(maxBarIdx);
    } else {
      // Enter Replay mode
      setIsReplayActive(true);
      setIsReplayPlaying(false);
    }
  };

  const handleExitToLive = () => {
    setIsReplayActive(false);
    setIsReplayPlaying(false);
    setActiveBarIndex(maxBarIdx);
    fetchLiveAtlas(activeTicker);
  };

  const handleStepBack = () => {
    setIsReplayPlaying(false);
    setActiveBarIndex((prev) => Math.max(0, prev - 1));
  };

  const handleStepForward = () => {
    setIsReplayPlaying(false);
    setActiveBarIndex((prev) => Math.min(maxBarIdx, prev + 1));
  };

  const handleSelectTicker = (ticker: string) => {
    const cleaned = ticker.trim().toUpperCase();
    setActiveTicker(cleaned);
    setStoreTicker(cleaned);
    fetchOptionsChain(cleaned, true);
    setTickerSelectorOpen(false);
    setIsReplayPlaying(false);
    setIsReplayActive(false);
    fetchLiveAtlas(cleaned);
  };

  const filteredTickersList = useMemo(() => {
    if (!tickerSearchQuery.trim()) return POPULAR_TICKERS;
    const q = tickerSearchQuery.trim().toUpperCase();
    return POPULAR_TICKERS.filter((t) => t.includes(q));
  }, [tickerSearchQuery]);

  // Format countdown string
  const countdownFormatted = useMemo(() => {
    const m = Math.floor(countdownSec / 60);
    const s = countdownSec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }, [countdownSec]);

  return (
    <div className="w-full flex flex-col gap-3 font-sans select-none">
      {/* =========================================================================
          PITCH-BLACK ATLAS CANVAS CONTAINER (bg-[#000000] border border-[#1a202c])
          ========================================================================= */}
      <div
        ref={containerRef}
        className="relative w-full bg-[#000000] border border-[#1a202c] rounded-2xl overflow-hidden shadow-[0_12px_40px_rgba(0,0,0,0.85)]"
      >
        {/* Top-Left Live Telemetry Overlay */}
        <div className="absolute top-3 left-3.5 z-20 flex flex-wrap items-center gap-2 pointer-events-auto">
          {/* Ticker & Live Price Readout */}
          <div className="flex items-center gap-2">
            <span className="text-base font-mono font-bold text-white tabular-nums tracking-tight">
              {activeTicker} {activePrice.toFixed(2)}
            </span>
          </div>

          {/* Signed Change Pill */}
          <div
            className={cn(
              "px-2.5 py-0.5 rounded-md text-xs font-mono font-bold border tabular-nums transition-colors",
              change >= 0
                ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-400"
                : "bg-rose-500/15 border-rose-500/30 text-rose-400"
            )}
          >
            {change >= 0 ? "+" : ""}
            {change.toFixed(2)} ({change >= 0 ? "+" : ""}
            {changePct.toFixed(2)}%)
          </div>

          {/* Session Mode Pill */}
          <div className="bg-[#11151c] border border-white/10 text-slate-200 px-2.5 py-0.5 rounded-md text-xs font-semibold flex items-center gap-1 shadow-sm">
            <span>RTH+</span>
            <span className="text-slate-400">&gt;</span>
          </div>

          {/* Live countdown timer until next bar */}
          {!isReplayActive && (
            <div className="hidden sm:flex items-center gap-1 bg-[#0b0e14]/90 border border-white/10 text-slate-400 px-2 py-0.5 rounded-md text-[11px] font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/80 animate-pulse" />
              <span>bar {countdownFormatted}</span>
            </div>
          )}
        </div>

        {/* Top-Right Status Badge */}
        <div className="absolute top-3 right-3.5 z-20 pointer-events-auto flex items-center gap-2">
          {isReplayActive ? (
            <div className="bg-cyan-500/15 border border-cyan-400/50 text-cyan-300 px-2.5 py-0.5 rounded-md text-xs font-mono font-bold flex items-center gap-1.5 shadow-[0_0_12px_rgba(34,211,238,0.2)]">
              <RotateCcw className="w-3 h-3 text-cyan-300 animate-spin-slow" />
              <span>
                REPLAY MODE · {activeCandle?.timeLabel ?? `Bar ${safeActiveIdx}`}
              </span>
            </div>
          ) : (
            <div className="bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 px-2.5 py-0.5 rounded-md text-xs font-mono font-bold flex items-center gap-1.5 shadow-[0_0_12px_rgba(16,185,129,0.2)]">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>LIVE</span>
            </div>
          )}
        </div>

        {/* Active Structural Nodes Drawer / Watchlist Toggle Popover */}
        {levelsDrawerOpen && (
          <div className="absolute top-12 left-3 z-30 w-72 bg-[#0b0e14]/95 backdrop-blur-md border border-white/15 rounded-xl p-3 shadow-2xl text-xs space-y-2.5 text-slate-200">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="font-semibold text-white flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-400" /> Session Active Nodes
              </span>
              <button
                type="button"
                onClick={() => setLevelsDrawerOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="space-y-1.5 font-mono text-[11px]">
              <div className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider">
                0DTE Tactical Nodes
              </div>
              <div className="flex justify-between items-center bg-[#141923] p-1.5 rounded-lg border border-amber-500/30">
                <span className="text-amber-300 font-bold flex items-center gap-1">
                  ★ 0DTE King
                </span>
                <span className="text-white font-bold">
                  ${activeNodes.zeroDteKing.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center bg-[#141923] p-1.5 rounded-lg border border-cyan-500/30">
                <span className="text-cyan-300 font-bold">Tactical Call Wall</span>
                <span className="text-white font-bold">
                  ${activeNodes.callWall.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center bg-[#141923] p-1.5 rounded-lg border border-purple-500/30">
                <span className="text-purple-300 font-bold">Tactical Put Wall</span>
                <span className="text-white font-bold">
                  ${activeNodes.putWall.toFixed(2)}
                </span>
              </div>

              <div className="text-[10px] text-amber-400 font-bold uppercase tracking-wider pt-2 border-t border-white/10">
                All-Exp Structural Walls
              </div>
              <div className="flex justify-between items-center bg-[#141923] p-1.5 rounded-lg border border-amber-500/30">
                <span className="text-amber-300 font-bold flex items-center gap-1">
                  ★ All-exp King
                </span>
                <span className="text-white font-bold">
                  ${activeNodes.king.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center bg-[#141923] p-1.5 rounded-lg border border-cyan-500/30">
                <span className="text-cyan-300 font-bold">Macro Call Wall</span>
                <span className="text-white font-bold">
                  ${activeNodes.macroCallWall.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center bg-[#141923] p-1.5 rounded-lg border border-purple-500/30">
                <span className="text-purple-300 font-bold">Macro Put Wall</span>
                <span className="text-white font-bold">
                  ${activeNodes.macroPutWall.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center bg-[#141923] p-1.5 rounded-lg border border-slate-700">
                <span className="text-amber-400">Zero γ Flip</span>
                <span className="text-white">
                  ${activeNodes.zeroGamma.toFixed(2)}
                </span>
              </div>
            </div>

            <div className="pt-1 text-[10px] text-slate-400 border-t border-white/10">
              Ribbon swell intensity dynamically indicates dealer hedging pressure as price nears node levels.
            </div>
          </div>
        )}

        {/* Hover Crosshair HUD Tooltip */}
        {hoverBarIndex !== null && activeCandle && (
          <div className="absolute bottom-4 left-3 z-20 bg-[#090d14]/90 backdrop-blur-md border border-cyan-500/40 rounded-lg px-3 py-1.5 shadow-xl text-xs font-mono text-slate-200 flex flex-wrap items-center gap-3">
            <span className="text-cyan-300 font-bold">
              {activeCandle.timeLabel}
            </span>
            <span>
              O: <b className="text-white">{activeCandle.open.toFixed(2)}</b>
            </span>
            <span>
              H: <b className="text-emerald-400">{activeCandle.high.toFixed(2)}</b>
            </span>
            <span>
              L: <b className="text-rose-400">{activeCandle.low.toFixed(2)}</b>
            </span>
            <span>
              C: <b className="text-white">{activeCandle.close.toFixed(2)}</b>
            </span>
            <span className="text-amber-400">
              King: ${currentColumn?.allExpKingStrike.toFixed(2)}
            </span>
          </div>
        )}

        {/* Floating Auto-Fit Reset Button on Canvas when zoomed / panned */}
        {(yScale !== 1.0 || yPanOffset !== 0 || xScale !== 1.0 || xPanOffset !== 0) && (
          <button
            type="button"
            onClick={() => handleCanvasDoubleClick()}
            title="Click to Auto-Fit scale (or double-click canvas)"
            className="absolute bottom-10 right-24 z-20 px-2.5 py-1 rounded-md bg-[#0e131d]/90 border border-cyan-400/50 text-[10px] font-mono font-bold text-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.25)] backdrop-blur-md hover:bg-cyan-500/20 transition flex items-center gap-1.5 cursor-pointer"
          >
            <RotateCcw className="w-3 h-3 text-cyan-400" />
            <span>Auto-Fit · Y:{(yScale * 100).toFixed(0)}% X:{(xScale * 100).toFixed(0)}%</span>
          </button>
        )}

        {/* The Core HTML5 Canvas */}
        <canvas
          ref={canvasRef}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={handleCanvasMouseLeave}
          onWheel={handleCanvasWheel}
          onDoubleClick={handleCanvasDoubleClick}
          className="w-full block select-none"
          style={{ cursor: cursorStyle }}
        />

        {/* Loading Spinner / Error Toast */}
        {isLoading && (
          <div className="absolute inset-0 z-30 bg-black/60 backdrop-blur-sm flex items-center justify-center">
            <div className="flex items-center gap-2.5 text-sm font-mono text-cyan-300">
              <span className="w-3 h-3 rounded-full bg-cyan-400 animate-ping" />
              <span>Loading Atlas positioning stream...</span>
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="absolute bottom-16 right-4 z-30 bg-rose-950/90 border border-rose-500/50 rounded-xl px-3 py-2 text-xs text-rose-200 flex items-center gap-2 shadow-lg">
            <span>{errorMsg}</span>
          </div>
        )}
      </div>

      {/* Draggable Chart Height Resizer Grip */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          const startY = e.clientY;
          const startH = chartHeight;
          const onMove = (moveEvt: MouseEvent) => {
            const delta = moveEvt.clientY - startY;
            setChartHeight(
              Math.max(380, Math.min(960, Math.round(startH + delta)))
            );
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
        title="Drag up or down to adjust chart height (or use dock height presets)"
        className="w-full h-3 -my-1 flex items-center justify-center cursor-row-resize hover:bg-cyan-500/10 active:bg-cyan-500/20 rounded transition-colors group z-20 select-none"
      >
        <div className="w-16 h-1 rounded-full bg-white/15 group-hover:bg-cyan-400/60 group-active:bg-cyan-400 transition-colors" />
      </div>

      {/* =========================================================================
          REPLAY CONTROL BAR (Revealed above bottom dock when Replay is active)
          ========================================================================= */}
      {isReplayActive && (
        <div className="bg-[#0e131d] border border-cyan-500/40 rounded-xl px-4 py-2 flex flex-wrap items-center justify-between gap-3 shadow-[0_0_20px_rgba(34,211,238,0.15)] animate-in fade-in slide-in-from-top-1 duration-200">
          {/* Replay Actions (Play/Pause, Step Back/Forward) */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setIsReplayPlaying(!isReplayPlaying)}
              title={isReplayPlaying ? "Pause Replay" : "Play Replay"}
              className="p-1.5 rounded-lg bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 hover:bg-cyan-500/30 transition cursor-pointer"
            >
              {isReplayPlaying ? (
                <Pause className="w-4 h-4 fill-current" />
              ) : (
                <Play className="w-4 h-4 fill-current ml-0.5" />
              )}
            </button>

            <button
              type="button"
              onClick={handleStepBack}
              title="Step Back 1 Candle"
              className="p-1.5 rounded-lg bg-[#151c28] border border-white/10 text-slate-300 hover:text-white transition cursor-pointer"
            >
              <SkipBack className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={handleStepForward}
              title="Step Forward 1 Candle"
              className="p-1.5 rounded-lg bg-[#151c28] border border-white/10 text-slate-300 hover:text-white transition cursor-pointer"
            >
              <SkipForward className="w-4 h-4" />
            </button>

            {/* Replay Speed Selector Pill (1x | 2x | 4x) */}
            <div className="flex items-center bg-[#151c28] border border-white/10 rounded-lg p-0.5 ml-1">
              {([1, 2, 4] as const).map((spd) => (
                <button
                  key={spd}
                  type="button"
                  onClick={() => setReplaySpeed(spd)}
                  className={cn(
                    "px-2 py-0.5 rounded text-[11px] font-mono font-bold transition cursor-pointer",
                    replaySpeed === spd
                      ? "bg-cyan-500/30 text-cyan-300 border border-cyan-400/40"
                      : "text-slate-400 hover:text-slate-200"
                  )}
                >
                  {spd}x
                </button>
              ))}
            </div>
          </div>

          {/* Interactive Range Slider Truncating Chart to Bar k */}
          <div className="flex-1 min-w-[200px] flex items-center gap-3">
            <span className="text-xs font-mono text-cyan-300 font-semibold shrink-0">
              Bar {safeActiveIdx} / {maxBarIdx}
            </span>
            <input
              type="range"
              min={0}
              max={maxBarIdx}
              value={safeActiveIdx}
              onChange={(e) => {
                setIsReplayPlaying(false);
                setActiveBarIndex(parseInt(e.target.value, 10));
              }}
              className="w-full accent-cyan-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
            />
            <span className="text-xs font-mono text-slate-400 shrink-0">
              {candles[safeActiveIdx]?.timeLabel ?? ""}
            </span>
          </div>

          {/* Exit to Live Button */}
          <button
            type="button"
            onClick={handleExitToLive}
            className="px-3 py-1 rounded-lg bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 hover:bg-emerald-500/30 text-xs font-mono font-bold flex items-center gap-1.5 transition cursor-pointer shadow-sm"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Exit to Live ●</span>
          </button>
        </div>
      )}

      {/* =========================================================================
          BOTTOM CONTROL DOCK (With Separate Replay Button)
          bg-[#0b0e14] border-t border-white/10 px-3 py-2.5
          ========================================================================= */}
      <div className="bg-[#0b0e14] border border-white/10 rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2 shadow-lg">
        {/* Left Side Controls: Drawer, Ticker Selector, Timeframe, Exposure Tools */}
        <div className="flex flex-wrap items-center gap-2">
          {/* 1. Left Watchlist / Levels Drawer Toggle [ ☰ ] */}
          <button
            type="button"
            onClick={() => setLevelsDrawerOpen(!levelsDrawerOpen)}
            title="Toggle Structural Active Nodes Drawer"
            className={cn(
              "p-2 rounded-lg border text-xs font-mono font-bold flex items-center justify-center transition cursor-pointer",
              levelsDrawerOpen
                ? "bg-cyan-500/20 border-cyan-400/50 text-cyan-300"
                : "bg-[#141923] border-white/10 text-slate-300 hover:text-white"
            )}
          >
            <Menu className="w-4 h-4" />
          </button>

          {/* 2. Ticker Selector Pill [ SPY • ⌄ ] */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setTickerSelectorOpen(!tickerSelectorOpen)}
              className="px-3 py-1.5 rounded-lg bg-[#141923] border border-white/10 text-slate-100 hover:border-cyan-400/50 text-xs font-mono font-bold flex items-center gap-2 transition cursor-pointer"
            >
              <span>{activeTicker}</span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {tickerSelectorOpen && (
              <div className="absolute bottom-full mb-2 left-0 z-40 w-52 bg-[#0e131d] border border-white/15 rounded-xl p-2 shadow-2xl space-y-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                  <input
                    type="text"
                    placeholder="Search ticker..."
                    value={tickerSearchQuery}
                    onChange={(e) => setTickerSearchQuery(e.target.value)}
                    className="w-full bg-[#161c28] border border-white/10 rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                  />
                </div>

                <div className="grid grid-cols-3 gap-1 pt-1 max-h-48 overflow-y-auto">
                  {filteredTickersList.map((sym) => (
                    <button
                      key={sym}
                      type="button"
                      onClick={() => handleSelectTicker(sym)}
                      className={cn(
                        "py-1 px-1.5 rounded text-xs font-mono font-bold text-center transition cursor-pointer",
                        sym === activeTicker
                          ? "bg-cyan-500/25 border border-cyan-400/50 text-cyan-300"
                          : "text-slate-300 hover:bg-[#1a2332] hover:text-white"
                      )}
                    >
                      {sym}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 3. Timeframe Selector Pill [ 3m ⌄ ] */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setTimeframeSelectorOpen(!timeframeSelectorOpen)}
              className="px-2.5 py-1.5 rounded-lg bg-[#141923] border border-white/10 text-slate-200 hover:border-white/20 text-xs font-mono font-semibold flex items-center gap-1.5 transition cursor-pointer"
            >
              <span>{timeframe}</span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {timeframeSelectorOpen && (
              <div className="absolute bottom-full mb-2 left-0 z-40 bg-[#0e131d] border border-white/15 rounded-xl p-1.5 shadow-2xl flex flex-col gap-1 w-24">
                {(["1m", "3m", "5m", "15m"] as const).map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => {
                      setTimeframe(tf);
                      setTimeframeSelectorOpen(false);
                    }}
                    className={cn(
                      "py-1 px-2 rounded text-xs font-mono text-left transition cursor-pointer",
                      timeframe === tf
                        ? "bg-cyan-500/25 text-cyan-300 font-bold"
                        : "text-slate-300 hover:bg-[#161c28] hover:text-white"
                    )}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 4. Exposure & Color Mode Button [ Tools / γ ⌄ ] */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setToolsPopoverOpen(!toolsPopoverOpen)}
              className="px-3 py-1.5 rounded-lg bg-[#141923] border border-white/10 text-slate-200 hover:border-white/20 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
            >
              <Sliders className="w-3.5 h-3.5 text-cyan-400" />
              <span>
                {exposureMode} · {paletteMode === "ice" ? "Ice" : "Polarity"}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {toolsPopoverOpen && (
              <div className="absolute bottom-full mb-2 left-0 z-40 w-64 bg-[#0e131d] border border-white/15 rounded-xl p-3 shadow-2xl space-y-3 text-xs">
                {/* Metric */}
                <div>
                  <div className="text-[11px] font-semibold text-slate-400 mb-1">
                    EXPOSURE METRIC
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {(["GEX", "VEX", "Combined"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setExposureMode(m)}
                        className={cn(
                          "py-1 rounded text-xs font-mono font-bold text-center transition cursor-pointer",
                          exposureMode === m
                            ? "bg-cyan-500/25 border border-cyan-400/50 text-cyan-300"
                            : "bg-[#141923] text-slate-400 hover:text-white"
                        )}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Horizon */}
                <div>
                  <div className="text-[11px] font-semibold text-slate-400 mb-1">
                    EXPIRATION HORIZON
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {(
                      [
                        { id: "NEXT", label: "0DTE / Tactical" },
                        { id: "WEEK", label: "This week" },
                        { id: "ALL", label: "All exp" },
                      ] as const
                    ).map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => setHorizonFilter(h.id)}
                        className={cn(
                          "py-1 rounded text-[11px] font-medium text-center transition cursor-pointer",
                          horizonFilter === h.id
                            ? "bg-cyan-500/25 border border-cyan-400/50 text-cyan-300"
                            : "bg-[#141923] text-slate-400 hover:text-white"
                        )}
                      >
                        {h.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Palette */}
                <div>
                  <div className="text-[11px] font-semibold text-slate-400 mb-1">
                    COLOR PALETTE
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      onClick={() => setPaletteMode("polarity")}
                      className={cn(
                        "py-1.5 px-2 rounded text-xs font-semibold text-center transition cursor-pointer",
                        paletteMode === "polarity"
                          ? "bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border border-cyan-400/50 text-white"
                          : "bg-[#141923] text-slate-400 hover:text-white"
                      )}
                    >
                      Polarity (RGB)
                    </button>
                    <button
                      type="button"
                      onClick={() => setPaletteMode("ice")}
                      className={cn(
                        "py-1.5 px-2 rounded text-xs font-semibold text-center transition cursor-pointer",
                        paletteMode === "ice"
                          ? "bg-sky-500/20 border border-sky-400/50 text-sky-200"
                          : "bg-[#141923] text-slate-400 hover:text-white"
                      )}
                    >
                      Ice Glow (White)
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 5. Zoom & Scale Adjustments */}
          <div className="flex items-center gap-0.5 bg-[#141923] border border-white/10 rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => {
                setYScale((s) => Math.max(0.15, s * 0.8));
                setScopeMode("tactical");
              }}
              title="Zoom Out (Expand Price Range)"
              className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-white/10 transition cursor-pointer"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleCanvasDoubleClick()}
              title="Auto-Fit / Reset Scale (Double-Click)"
              className={cn(
                "px-2 py-0.5 rounded text-[11px] font-mono font-bold transition cursor-pointer flex items-center gap-1",
                yScale !== 1.0 || yPanOffset !== 0
                  ? "bg-cyan-500/20 text-cyan-300 border border-cyan-400/40"
                  : "text-slate-400 hover:text-white hover:bg-white/5"
              )}
            >
              <span>{(yScale * 100).toFixed(0)}%</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setYScale((s) => Math.min(12.0, s * 1.25));
                setScopeMode("tactical");
              }}
              title="Zoom In (Focus on Price Action)"
              className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-white/10 transition cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 6. Scope Presets (Focus | Tactical | Macro) */}
          <div className="hidden sm:flex items-center bg-[#141923] border border-white/10 rounded-lg p-0.5 text-xs font-mono">
            <button
              type="button"
              onClick={() => {
                setScopeMode("focus");
                setYScale(2.2);
                setYPanOffset(0);
              }}
              className={cn(
                "px-2 py-1 rounded transition cursor-pointer",
                scopeMode === "focus"
                  ? "bg-sky-500/20 text-sky-200 font-bold border border-sky-400/40"
                  : "text-slate-400 hover:text-white"
              )}
              title="Focus: Tight view centered on candles"
            >
              Focus
            </button>
            <button
              type="button"
              onClick={() => {
                setScopeMode("tactical");
                setYScale(1.0);
                setYPanOffset(0);
              }}
              className={cn(
                "px-2 py-1 rounded transition cursor-pointer",
                scopeMode === "tactical"
                  ? "bg-sky-500/20 text-sky-200 font-bold border border-sky-400/40"
                  : "text-slate-400 hover:text-white"
              )}
              title="Tactical: Intraday candles + near-term Call/Put walls"
            >
              Tactical
            </button>
            <button
              type="button"
              onClick={() => {
                setScopeMode("macro");
                setYScale(0.35);
                setYPanOffset(0);
              }}
              className={cn(
                "px-2 py-1 rounded transition cursor-pointer",
                scopeMode === "macro"
                  ? "bg-sky-500/20 text-sky-200 font-bold border border-sky-400/40"
                  : "text-slate-400 hover:text-white"
              )}
              title="Macro: Full option board structure"
            >
              Macro
            </button>
          </div>
        </div>

        {/* Right Side Controls: Favorite Star, Separate Replay Button, Settings */}
        <div className="flex items-center gap-2">
          {/* 5. Favorite / Watchlist Star Bar [ ☆ ] */}
          <button
            type="button"
            onClick={() => setIsStarred(!isStarred)}
            title={isStarred ? "Remove from favorites" : "Favorite ticker"}
            className={cn(
              "p-2 rounded-lg border text-xs transition cursor-pointer",
              isStarred
                ? "bg-amber-500/20 border-amber-400/50 text-amber-300 shadow-[0_0_10px_rgba(250,204,21,0.2)]"
                : "bg-[#141923] border-white/10 text-slate-400 hover:text-white"
            )}
          >
            <Star
              className={cn(
                "w-4 h-4",
                isStarred ? "fill-amber-400 text-amber-400" : ""
              )}
            />
          </button>

          {/* 6. Separate Replay Toggle Button [ ⟲ ] */}
          <button
            type="button"
            onClick={handleToggleReplay}
            title={
              isReplayActive
                ? "Exit Replay Mode (Return to Live)"
                : "Activate Intraday Replay Scrubber"
            }
            className={cn(
              "p-2 rounded-lg border text-xs transition cursor-pointer flex items-center justify-center",
              isReplayActive
                ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-300 shadow-[0_0_14px_rgba(34,211,238,0.3)] ring-1 ring-cyan-400/40"
                : "bg-[#141923] border-white/10 text-slate-200 hover:text-white hover:border-white/20"
            )}
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          {/* 7. Height Expand / Collapse Toggle [ ⤢ ] */}
          <button
            type="button"
            onClick={() => {
              if (chartHeight >= 760) {
                setChartHeight(600);
              } else {
                setChartHeight(780);
              }
            }}
            title={
              chartHeight >= 760
                ? "Collapse chart height"
                : "Expand chart height (or drag resize handle below chart)"
            }
            className={cn(
              "p-2 rounded-lg border text-xs transition cursor-pointer flex items-center justify-center",
              chartHeight >= 760
                ? "bg-cyan-500/20 border-cyan-400/50 text-cyan-300"
                : "bg-[#141923] border-white/10 text-slate-200 hover:text-white hover:border-white/20"
            )}
          >
            {chartHeight >= 760 ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>

          {/* 8. Settings Button [ ⚙️ ] */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setSettingsOpen(!settingsOpen)}
              title="Atlas Visual Preferences"
              className="p-2 rounded-lg bg-[#141923] border border-white/10 text-slate-200 hover:text-white transition cursor-pointer"
            >
              <Settings className="w-4 h-4" />
            </button>

            {settingsOpen && (
              <div className="absolute bottom-full mb-2 right-0 z-40 w-64 bg-[#0e131d] border border-white/15 rounded-xl p-3 shadow-2xl space-y-3 text-xs text-slate-200">
                <div className="flex items-center justify-between border-b border-white/10 pb-2">
                  <span className="font-semibold text-white">
                    Atlas Preferences
                  </span>
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(false)}
                    className="text-slate-400 hover:text-white"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Sensitivity threshold */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Waveform Sensitivity</span>
                    <span className="font-mono text-cyan-300">
                      {sensitivityThreshold.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.05}
                    max={0.35}
                    step={0.01}
                    value={sensitivityThreshold}
                    onChange={(e) =>
                      setSensitivityThreshold(parseFloat(e.target.value))
                    }
                    className="w-full accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                  />
                </div>

                {/* Glow intensity */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Glow Luminance</span>
                    <span className="font-mono text-cyan-300">
                      {glowIntensity.toFixed(1)}x
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.2}
                    max={2.0}
                    step={0.1}
                    value={glowIntensity}
                    onChange={(e) => setGlowIntensity(parseFloat(e.target.value))}
                    className="w-full accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                  />
                </div>

                {/* Toggles */}
                <div className="pt-2 border-t border-white/10 space-y-2">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-slate-300">Show Gridlines</span>
                    <input
                      type="checkbox"
                      checked={showGridlines}
                      onChange={(e) => setShowGridlines(e.target.checked)}
                      className="accent-cyan-400 rounded"
                    />
                  </label>
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-slate-300">Live Price Ray</span>
                    <input
                      type="checkbox"
                      checked={showPriceRay}
                      onChange={(e) => setShowPriceRay(e.target.checked)}
                      className="accent-cyan-400 rounded"
                    />
                  </label>
                </div>

                {/* Chart Height Adjustment */}
                <div className="space-y-1.5 pt-2 border-t border-white/10">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Chart Height</span>
                    <span className="font-mono text-cyan-300">{chartHeight}px</span>
                  </div>
                  <input
                    type="range"
                    min={380}
                    max={960}
                    step={20}
                    value={chartHeight}
                    onChange={(e) =>
                      setChartHeight(parseInt(e.target.value, 10))
                    }
                    className="w-full accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                  />
                  <div className="grid grid-cols-3 gap-1">
                    {[
                      { label: "Compact 480p", h: 480 },
                      { label: "Standard 600p", h: 600 },
                      { label: "Tall 760p", h: 760 },
                    ].map(({ label, h }) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => setChartHeight(h)}
                        className={cn(
                          "py-1 rounded text-[11px] font-semibold text-center transition cursor-pointer",
                          chartHeight === h
                            ? "bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 font-bold"
                            : "bg-[#141923] text-slate-400 hover:text-white"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
