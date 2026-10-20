"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDashboardStore } from "@/store/useDashboardStore";
import { normPDF } from "@/lib/optionsExposure";
import type {
  AntaeusExpirationInfo,
  AntaeusIntradayCandle,
  AntaeusLivePayload,
  AntaeusMtfRow,
  AntaeusPivotSignal,
  AntaeusSessionOption,
  AntaeusStrikeExpBucket,
} from "@/app/api/antaeus/route";
import { cn } from "@/lib/utils";

type ExposureMode = "GEX" | "VEX" | "Combined";
type ExpFilterMode = "ALL" | "NEXT" | "WEEK" | string; // string for specific MM-DD date

interface StrikeExposureColumn {
  netGexB: number; // in Billions ($B)
  kingStrike: number;
  kingConcPct: number;
  allExpKingStrike: number;
  allExpKingConcPct: number;
  filteredKingStrike: number;
  filteredKingConcPct: number;
  bookCenter: number;
  strikeValues: Record<number, number>; // value in Millions ($M)
  strikeGexValues?: Record<number, number>;
  strikeVexValues?: Record<number, number>;
  topLevels: { strike: number; valueM: number }[];
}

interface ComputedAntaeusViewData {
  ticker: string;
  sessionDate: string;
  bookLabel: string;
  priorClose: number;
  sigma1Move: number;
  sigma2Move: number;
  yMin: number;
  yMax: number;
  yAxisTicks: number[];
  visibleStrikes: number[];
  candles: AntaeusIntradayCandle[];
  columnsByBar: StrikeExposureColumn[];
  pivotSignals5m: AntaeusPivotSignal[];
  mtfByBar: AntaeusMtfRow[];
}

function formatBookLevelValue(valueM: number): string {
  const absM = Math.abs(valueM);
  const sign = valueM < 0 ? "-" : "+";
  if (absM >= 1000) {
    return `${sign}${(absM / 1000).toFixed(2)}B`;
  }
  return `${sign}${absM.toFixed(2)}M`;
}

function formatPct(pct: number): string {
  return `${Number(pct.toFixed(1))}`;
}

function evaluateBucketExposureM(
  spot: number,
  bucket: AntaeusStrikeExpBucket,
  mode: ExposureMode
): number {
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

  if (mode === "GEX") return netGexM;
  if (mode === "VEX") return netVexM;
  return netGexM + netVexM;
}

interface DivergenceSignal {
  type: string;
  p1: number;
  p2: number;
  t1: number;
  t2: number;
  near?: [string, number][];
}

interface DivergenceRow {
  tf: string;
  name: string;
  state: string;
  signal: DivergenceSignal | null;
  building?: boolean;
  intraday?: boolean;
}

interface DivergencePayload {
  symbol: string;
  rows: DivergenceRow[];
  levels: { King: number; "Call wall": number; "Put wall": number };
}

function divWhen(t: number, intraday?: boolean): string {
  const d = new Date(t * 1000).toISOString();
  return intraday ? `${d.slice(5, 10)} ${d.slice(11, 16)}` : d.slice(0, 10);
}

/**
 * Computes the complete Antaeus chart view dataset strictly from the live API payload.
 */
function buildLiveAntaeusDataset(
  payload: AntaeusLivePayload,
  exposureMode: ExposureMode,
  expFilter: ExpFilterMode
): ComputedAntaeusViewData {
  const {
    ticker,
    sessionDate,
    bookLabel,
    priorClose,
    sigma1Move,
    sigma2Move,
    candles,
    pivotSignals5m,
    mtfByBar,
    expirations,
    optionBuckets,
  } = payload;

  // Filter live option buckets by the selected expiration filter
  const nextExpIso = expirations[0]?.isoDate ?? "";
  const weekIsoSet = new Set(
    expirations.filter((e) => e.isThisWeek).map((e) => e.isoDate)
  );

  const filteredBuckets = optionBuckets.filter((b) => {
    if (expFilter === "ALL") return true;
    if (expFilter === "NEXT") return b.expiration === nextExpIso;
    if (expFilter === "WEEK") {
      return weekIsoSet.size > 0
        ? weekIsoSet.has(b.expiration)
        : b.expiration === nextExpIso;
    }
    return b.dateLabel === expFilter || b.expiration === expFilter;
  });

  const activeBuckets =
    filteredBuckets.length > 0 ? filteredBuckets : optionBuckets;

  // Compute y-domain bounds from live session candles and ±2σ Expected-Move Cone
  const candleHighs = candles.map((c) => c.high);
  const candleLows = candles.map((c) => c.low);
  const maValues = candles.map((c) => c.sma5d);

  const minChartRef = Math.min(
    ...candleLows,
    priorClose - sigma2Move
  );
  const maxChartRef = Math.max(
    ...candleHighs,
    ...maValues,
    priorClose + sigma2Move
  );

  // Extract all live option strikes within the visible vertical price window
  const allUniqueStrikesDesc = Array.from(
    new Set(optionBuckets.map((b) => b.strike))
  ).sort((a, b) => b - a);

  const inWindowStrikes = allUniqueStrikesDesc.filter(
    (s) => s >= minChartRef - sigma1Move * 0.35 && s <= maxChartRef + sigma1Move * 0.35
  );

  const baseVisibleStrikes =
    inWindowStrikes.length >= 5
      ? inWindowStrikes
      : allUniqueStrikesDesc.slice(0, 25);

  const visibleStrikeSet = new Set(baseVisibleStrikes);

  const isLatestSession =
    payload.sessions.length === 0 ||
    sessionDate === payload.sessions[0].isoDate;

  // Evaluate Black-Scholes exposure across both all-expiration buckets and active filtered buckets at each 5m bar
  const columnsByBar: StrikeExposureColumn[] = candles.map((candle, idx) => {
    const spot =
      isLatestSession && idx === candles.length - 1
        ? payload.spotPrice
        : candle.close;

    // 1. Global All-Expiration King calculation across all optionBuckets
    const allExpStrikeTotals = new Map<number, number>();
    for (const bucket of optionBuckets) {
      const valM = evaluateBucketExposureM(spot, bucket, exposureMode);
      allExpStrikeTotals.set(
        bucket.strike,
        (allExpStrikeTotals.get(bucket.strike) ?? 0) + valM
      );
    }

    let totalAllExpAbsBoardM = 0;
    const rankedAllExp: { strike: number; valueM: number }[] = [];
    for (const [strike, valM] of Array.from(allExpStrikeTotals.entries())) {
      const rounded = Number(valM.toFixed(2));
      totalAllExpAbsBoardM += Math.abs(valM);
      rankedAllExp.push({ strike, valueM: rounded });
    }
    rankedAllExp.sort((a, b) => Math.abs(b.valueM) - Math.abs(a.valueM));
    const allExpKingStrike =
      rankedAllExp[0]?.strike ??
      baseVisibleStrikes[baseVisibleStrikes.length - 1] ??
      Math.round(spot);
    const allExpKingAbsM = Math.abs(rankedAllExp[0]?.valueM ?? 0);
    const allExpKingConcPct =
      totalAllExpAbsBoardM > 0
        ? Number(((allExpKingAbsM / totalAllExpAbsBoardM) * 100).toFixed(1))
        : 0;

    // 2. Filtered Expiration King & Active Book calculation across activeBuckets
    const strikeTotals =
      expFilter === "ALL" ? allExpStrikeTotals : new Map<number, number>();
    const strikeGexTotals = new Map<number, number>();
    const strikeVexTotals = new Map<number, number>();

    const bucketsForDual = expFilter === "ALL" ? optionBuckets : activeBuckets;
    for (const bucket of bucketsForDual) {
      const gex = evaluateBucketExposureM(spot, bucket, "GEX");
      const vex = evaluateBucketExposureM(spot, bucket, "VEX");
      strikeGexTotals.set(
        bucket.strike,
        (strikeGexTotals.get(bucket.strike) ?? 0) + gex
      );
      strikeVexTotals.set(
        bucket.strike,
        (strikeVexTotals.get(bucket.strike) ?? 0) + vex
      );
    }

    if (expFilter !== "ALL") {
      for (const bucket of activeBuckets) {
        const valM = evaluateBucketExposureM(spot, bucket, exposureMode);
        strikeTotals.set(
          bucket.strike,
          (strikeTotals.get(bucket.strike) ?? 0) + valM
        );
      }
    }

    let totalNetM = 0;
    let totalAbsBoardM = 0;
    const rankedFiltered: { strike: number; valueM: number }[] = [];
    const strikeValues: Record<number, number> = {};
    const strikeGexValues: Record<number, number> = {};
    const strikeVexValues: Record<number, number> = {};

    for (const [strike, valM] of Array.from(strikeTotals.entries())) {
      const rounded = Number(valM.toFixed(2));
      totalNetM += valM;
      totalAbsBoardM += Math.abs(valM);
      rankedFiltered.push({ strike, valueM: rounded });
      if (visibleStrikeSet.has(strike)) {
        strikeValues[strike] = rounded;
      }
    }

    for (const [strike, valM] of Array.from(strikeGexTotals.entries())) {
      if (visibleStrikeSet.has(strike)) {
        strikeGexValues[strike] = Number(valM.toFixed(2));
      }
    }
    for (const [strike, valM] of Array.from(strikeVexTotals.entries())) {
      if (visibleStrikeSet.has(strike)) {
        strikeVexValues[strike] = Number(valM.toFixed(2));
      }
    }

    rankedFiltered.sort((a, b) => Math.abs(b.valueM) - Math.abs(a.valueM));
    const topLevels = rankedFiltered.slice(0, 3);
    const filteredKingStrike =
      topLevels[0]?.strike ??
      baseVisibleStrikes[baseVisibleStrikes.length - 1] ??
      Math.round(spot);
    const filteredKingAbsM = Math.abs(topLevels[0]?.valueM ?? 0);
    const filteredKingConcPct =
      totalAbsBoardM > 0
        ? Number(((filteredKingAbsM / totalAbsBoardM) * 100).toFixed(1))
        : 0;

    const kingStrike =
      expFilter === "ALL" ? allExpKingStrike : filteredKingStrike;
    const kingConcPct =
      expFilter === "ALL" ? allExpKingConcPct : filteredKingConcPct;

    // Ensure both King strikes are included in strikeValues & visibleStrikeSet
    if (topLevels[0] && strikeValues[filteredKingStrike] === undefined) {
      strikeValues[filteredKingStrike] = topLevels[0].valueM;
      visibleStrikeSet.add(filteredKingStrike);
    }
    if (rankedAllExp[0] && strikeValues[allExpKingStrike] === undefined) {
      const allKingInFiltered = strikeTotals.get(allExpKingStrike) ?? 0;
      strikeValues[allExpKingStrike] = Number(allKingInFiltered.toFixed(2));
      visibleStrikeSet.add(allExpKingStrike);
    }

    // Exposure-weighted Book Center across visible strikes
    let weightedStrikeSum = 0;
    let absWeightTotal = 0;
    for (const s of Array.from(visibleStrikeSet)) {
      const absExp = Math.abs(strikeValues[s] ?? 0);
      weightedStrikeSum += s * absExp;
      absWeightTotal += absExp;
    }
    const bookCenter =
      absWeightTotal > 0
        ? Number((weightedStrikeSum / absWeightTotal).toFixed(2))
        : Number(spot.toFixed(2));

    return {
      netGexB: Number((totalNetM / 1000).toFixed(2)),
      kingStrike,
      kingConcPct,
      allExpKingStrike,
      allExpKingConcPct,
      filteredKingStrike,
      filteredKingConcPct,
      bookCenter,
      strikeValues,
      strikeGexValues,
      strikeVexValues,
      topLevels,
    };
  });

  const visibleStrikes = Array.from(visibleStrikeSet).sort((a, b) => b - a);

  // Include visible strikes, candles, both King strikes, and full ±2σ Expected-Move Cone bounds + padding
  const lastCol = columnsByBar[columnsByBar.length - 1];
  const allExpKingFinal = lastCol?.allExpKingStrike ?? priorClose;
  const filteredKingFinal = lastCol?.filteredKingStrike ?? priorClose;
  const allDomainPrices = [
    ...visibleStrikes,
    ...candleHighs,
    ...candleLows,
    ...maValues,
    priorClose - sigma2Move,
    priorClose + sigma2Move,
    allExpKingFinal,
    filteredKingFinal,
  ];
  const minPrice = Math.min(...allDomainPrices);
  const maxPrice = Math.max(...allDomainPrices);
  const padPts = Math.max(1.5, (maxPrice - minPrice) * 0.06);
  const yMin = Number((minPrice - padPts).toFixed(2));
  const yMax = Number((maxPrice + padPts).toFixed(2));

  // 5 evenly spaced right-axis price ticks across the visible domain
  const tickTop = maxPrice - padPts * 0.55;
  const tickBot = minPrice + padPts * 0.95;
  const tickStep = (tickTop - tickBot) / 4;
  const yAxisTicks = [0, 1, 2, 3, 4].map((idx) =>
    Number((tickTop - idx * tickStep).toFixed(2))
  );

  return {
    ticker,
    sessionDate,
    bookLabel,
    priorClose,
    sigma1Move,
    sigma2Move,
    yMin,
    yMax,
    yAxisTicks,
    visibleStrikes,
    candles,
    columnsByBar,
    pivotSignals5m,
    mtfByBar,
  };
}

export function AntaeusView() {
  const storeTicker = useDashboardStore((state) => state.activeTicker);
  const gammaLevels = useDashboardStore((state) => state.gammaLevels);
  const setStoreTicker = useDashboardStore((state) => state.setTicker);
  const fetchOptionsChain = useDashboardStore(
    (state) => state.fetchOptionsChain
  );

  const DIVSYM = useMemo(() => new Set(["SPY", "QQQ", "SPXW", "IWM"]), []);

  const [tickerInput, setTickerInput] = useState<string>(storeTicker || "SPY");
  const [loadedTicker, setLoadedTicker] = useState<string>(storeTicker || "SPY");
  const [guideExpanded, setGuideExpanded] = useState<boolean>(false);
  const [selectedSessionIso, setSelectedSessionIso] = useState<string>("");

  const [livePayload, setLivePayload] = useState<AntaeusLivePayload | null>(
    null
  );
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [exposureMode, setExposureMode] = useState<ExposureMode>("GEX");
  const [expFilter, setExpFilter] = useState<ExpFilterMode>("ALL");
  const [selectedDateExp, setSelectedDateExp] = useState<string>("");
  const [pathToKing, setPathToKing] = useState<boolean>(true);

  const [activeBarIndex, setActiveBarIndex] = useState<number>(0);
  const [hoverBarIndex, setHoverBarIndex] = useState<number | null>(null);
  const [isReplaying, setIsReplaying] = useState<boolean>(false);
  const [openDivTf, setOpenDivTf] = useState<string | null>(null);
  const [divPayload, setDivPayload] = useState<DivergencePayload | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState<number>(1016);

  const fetchLiveAntaeus = useCallback(
    async (tickerSymbol: string, sessionIso?: string) => {
      setIsLoading(true);
      setErrorMsg(null);
      try {
        const qs = new URLSearchParams({ ticker: tickerSymbol });
        if (sessionIso) qs.set("session", sessionIso);
        const res = await fetch(`/api/antaeus?${qs.toString()}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok || data?.error) {
          throw new Error(data?.error ?? `HTTP ${res.status}`);
        }
        const payload = data as AntaeusLivePayload;
        setLivePayload(payload);
        setSelectedSessionIso(payload.sessionDate);
        setActiveBarIndex(Math.max(0, payload.candles.length - 1));
        setHoverBarIndex(null);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "Live market feed unavailable";
        setErrorMsg(msg);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // Initial load and sync when global store ticker changes externally
  useEffect(() => {
    if (storeTicker && storeTicker !== loadedTicker) {
      setTickerInput(storeTicker);
      setLoadedTicker(storeTicker);
      setSelectedSessionIso("");
      fetchLiveAntaeus(storeTicker, "");
    }
  }, [storeTicker, loadedTicker, fetchLiveAntaeus]);

  useEffect(() => {
    fetchLiveAntaeus(loadedTicker, selectedSessionIso);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sym = loadedTicker.toUpperCase();
    if (!DIVSYM.has(sym)) {
      setDivPayload(null);
      return;
    }
    let active = true;
    fetch(`/api/divergence?symbol=${encodeURIComponent(sym)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (active && data && Array.isArray(data.rows)) {
          setDivPayload(data as DivergencePayload);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [loadedTicker, DIVSYM]);

  // Observe chart container width for responsive high-DPI canvas rendering
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateWidth = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 200) {
        setCanvasWidth(Math.floor(rect.width));
      }
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const maxBarIdx = useMemo(
    () => Math.max(0, (livePayload?.candles.length ?? 1) - 1),
    [livePayload]
  );

  // Automatic bar-by-bar replay timer
  useEffect(() => {
    if (!isReplaying) return;
    const timer = setInterval(() => {
      setActiveBarIndex((prev) => {
        if (prev >= maxBarIdx) {
          setIsReplaying(false);
          return maxBarIdx;
        }
        return prev + 1;
      });
    }, 140);
    return () => clearInterval(timer);
  }, [isReplaying, maxBarIdx]);

  const dataset = useMemo(() => {
    if (!livePayload) return null;
    return buildLiveAntaeusDataset(livePayload, exposureMode, expFilter);
  }, [livePayload, exposureMode, expFilter]);

  const handleLoadTicker = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleaned = tickerInput.trim().toUpperCase() || "SPY";
    setTickerInput(cleaned);
    setLoadedTicker(cleaned);
    setStoreTicker(cleaned);
    fetchOptionsChain(cleaned, true);
    setIsReplaying(false);
    setSelectedSessionIso("");
    fetchLiveAntaeus(cleaned, "");
  };

  const handleSessionChange = (newSessionIso: string) => {
    setSelectedSessionIso(newSessionIso);
    setIsReplaying(false);
    fetchLiveAntaeus(loadedTicker, newSessionIso);
  };

  const handleResetView = () => {
    setExposureMode("GEX");
    setExpFilter("ALL");
    setSelectedDateExp("");
    setPathToKing(true);
    setIsReplaying(false);
    setActiveBarIndex(maxBarIdx);
    setHoverBarIndex(null);
  };

  const handleToggleReplay = () => {
    if (isReplaying) {
      setIsReplaying(false);
    } else {
      if (activeBarIndex >= maxBarIdx) {
        setActiveBarIndex(0);
      }
      setIsReplaying(true);
    }
  };

  const safeActiveIdx = dataset
    ? Math.min(activeBarIndex, dataset.candles.length - 1)
    : 0;
  const displayBarIdx =
    hoverBarIndex !== null
      ? Math.min(safeActiveIdx, hoverBarIndex)
      : safeActiveIdx;

  const activeCandle = dataset?.candles[displayBarIdx];
  const activeBookCol = dataset?.columnsByBar[displayBarIdx];
  const mtfDivergence = dataset?.mtfByBar[safeActiveIdx] ?? {
    tf5m: "NO",
    tf30m: "NO",
    tf2h: "NO",
    tfDaily: "NO",
    tfWeekly: "NO",
  };

  const sessionOptions: AntaeusSessionOption[] = livePayload?.sessions ?? [];
  const expirationOptions: AntaeusExpirationInfo[] =
    livePayload?.expirations ?? [];
  const has0DteActive = Boolean(livePayload?.has0DteActive);
  const nextExpPillLabel = has0DteActive ? "0DTE" : "Next exp";
  const nextExpShortDate = expirationOptions[0]?.dateLabel ?? "";

  const canvasFilterBadgePrefix =
    expFilter === "ALL"
      ? "All-exp"
      : expFilter === "NEXT"
        ? has0DteActive
          ? "0DTE"
          : "Next exp"
        : expFilter === "WEEK"
          ? "Week"
          : `${expFilter}`;

  // High-DPI 5-Layer Canvas Rendering Engine
  useEffect(() => {
    if (!dataset || !activeBookCol) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const width = canvasWidth;
    const height = 540;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear canvas background
    ctx.fillStyle = "#0d111a";
    ctx.fillRect(0, 0, width, height);

    // 1. Reserve 64px right-hand axis gutter on the canvas
    const padLeft = 18;
    const rightAxisWidth = 64;
    const outlookRightX = width - rightAxisWidth;
    const padTop = 18;
    const padBottom = 32;
    const plotHeight = height - padTop - padBottom;
    const totalPlotWidth = outlookRightX - padLeft;

    // Left Zone (76% width — Intraday Session) & Right Zone (24% width — outlook Zone)
    const dividerX = Math.round(padLeft + totalPlotWidth * 0.76);
    const sessionWidth = dividerX - padLeft;
    const totalSessionSlots = Math.max(78, dataset.candles.length);

    const { yMin, yMax } = dataset;
    const priceToY = (price: number): number => {
      const ratio = (price - yMin) / Math.max(0.0001, yMax - yMin);
      return padTop + (1 - ratio) * plotHeight;
    };

    const barToX = (barIdx: number): number => {
      const stepX = sessionWidth / totalSessionSlots;
      return padLeft + (barIdx + 0.5) * stepX;
    };

    // Subtle horizontal grid lines at the 5 price axis ticks
    ctx.strokeStyle = "rgba(30, 38, 56, 0.55)";
    ctx.lineWidth = 1;
    dataset.yAxisTicks.forEach((tickPrice) => {
      const y = Math.round(priceToY(tickPrice)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(outlookRightX, y);
      ctx.stroke();
    });

    // Vertical outlook divider line (1px solid #1e2638) and right boundary border at outlookRightX
    ctx.strokeStyle = "#1e2638";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dividerX + 0.5, padTop);
    ctx.lineTo(dividerX + 0.5, height - padBottom);
    ctx.moveTo(outlookRightX + 0.5, padTop);
    ctx.lineTo(outlookRightX + 0.5, height - padBottom);
    ctx.stroke();

    // =========================================================================
    // LAYER 1: Intraday Strike Exposure Bubble Matrix (Non-Linear Power Scaling)
    // =========================================================================
    let maxSessionExposure = 1;
    for (let t = 0; t <= safeActiveIdx; t++) {
      const col = dataset.columnsByBar[t];
      if (!col) continue;
      for (const s of dataset.visibleStrikes) {
        const absVal = Math.abs(col.strikeValues[s] ?? 0);
        if (absVal > maxSessionExposure) maxSessionExposure = absVal;
      }
    }

    const colStepX = sessionWidth / totalSessionSlots;
    const allExpKingStrike = activeBookCol.allExpKingStrike;
    const yAllExpKing = priceToY(allExpKingStrike);
    const isFiltered = expFilter !== "ALL";
    const filteredKingStrike = activeBookCol.filteredKingStrike;
    const yFilteredKing = priceToY(filteredKingStrike);
    const outlookEndX = outlookRightX - 18;

    // 1. Global All-exp King Line: Continuous solid gold horizontal line (#eab308, 1.5px)
    ctx.save();
    ctx.strokeStyle = "#eab308";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padLeft, yAllExpKing);
    ctx.lineTo(outlookEndX, yAllExpKing);
    ctx.stroke();
    ctx.restore();

    const posColor = exposureMode === "VEX" ? "#f59e0b" : "#22d3ee";
    const negColor = exposureMode === "VEX" ? "#8b5cf6" : "#a855f7";

    // Draw exposure ovals for bars t in [0, safeActiveIdx]
    for (let t = 0; t <= safeActiveIdx; t++) {
      const col = dataset.columnsByBar[t];
      if (!col) continue;
      const cx = barToX(t);
      const colKingStrike = isFiltered ? col.filteredKingStrike : col.allExpKingStrike;

      for (const strike of dataset.visibleStrikes) {
        const cy = priceToY(strike);
        const isKing = strike === colKingStrike;

        if (isKing) {
          // King Row: glowing gold ovals (#facc15, shadowBlur = 8, shadowColor = rgba(250, 204, 21, 0.6))
          const rx = Math.min(colStepX * 0.48, 3.6);
          const ry = 4.4;

          ctx.save();
          ctx.shadowColor = "rgba(250, 204, 21, 0.6)";
          ctx.shadowBlur = 8;
          ctx.fillStyle = "#facc15";
          ctx.globalAlpha = 0.95;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          continue;
        }

        if (exposureMode === "Combined") {
          // Dual overlay: render GEX (cyan/purple) and VEX (amber/violet)
          const gVal = col.strikeGexValues?.[strike] ?? 0;
          const vVal = col.strikeVexValues?.[strike] ?? 0;

          if (Math.abs(gVal) > 0.01) {
            const weightG = Math.pow(Math.min(1, Math.abs(gVal) / maxSessionExposure), 1.8);
            let rx = 1.3;
            let ry = 1.3;
            let alpha = 0.22;
            if (weightG >= 0.25) {
              const tScale = Math.min(1, (weightG - 0.25) / 0.55);
              rx = Math.min(colStepX * 0.42, 1.5 + tScale * (3.2 - 1.5));
              ry = 1.5 + tScale * (2.4 - 1.5);
              alpha = 0.35 + tScale * (0.85 - 0.35);
            }
            ctx.save();
            ctx.fillStyle = gVal >= 0 ? "#22d3ee" : "#a855f7";
            ctx.globalAlpha = alpha * 0.82;
            ctx.beginPath();
            ctx.ellipse(cx - 1.2, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }

          if (Math.abs(vVal) > 0.01) {
            const weightV = Math.pow(Math.min(1, Math.abs(vVal) / maxSessionExposure), 1.8);
            let rx = 1.3;
            let ry = 1.3;
            let alpha = 0.22;
            if (weightV >= 0.25) {
              const tScale = Math.min(1, (weightV - 0.25) / 0.55);
              rx = Math.min(colStepX * 0.42, 1.5 + tScale * (3.2 - 1.5));
              ry = 1.5 + tScale * (2.4 - 1.5);
              alpha = 0.35 + tScale * (0.85 - 0.35);
            }
            ctx.save();
            ctx.fillStyle = vVal >= 0 ? "#f59e0b" : "#8b5cf6";
            ctx.globalAlpha = alpha * 0.82;
            ctx.beginPath();
            ctx.ellipse(cx + 1.2, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        } else {
          const val = col.strikeValues[strike] ?? 0;
          const absExposure = Math.abs(val);
          if (absExposure <= 0.01) continue;

          const weight = Math.pow(
            Math.min(1, absExposure / maxSessionExposure),
            1.8
          );
          let rx = 1.3;
          let ry = 1.3;
          let alpha = 0.22;

          if (weight >= 0.25) {
            const tScale = Math.min(1, (weight - 0.25) / 0.55);
            rx = Math.min(colStepX * 0.42, 1.5 + tScale * (3.2 - 1.5));
            ry = 1.5 + tScale * (2.4 - 1.5);
            alpha = 0.35 + tScale * (0.85 - 0.35);
          }

          ctx.save();
          ctx.fillStyle = val >= 0 ? posColor : negColor;
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // =========================================================================
    // LAYER 2: Book Center & Moving Averages
    // =========================================================================
    // 1. Book Center: 1.25px dotted white/silver line (#cbd5e1, lineDash [2, 3])
    if (safeActiveIdx >= 1) {
      ctx.save();
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 1.25;
      ctx.setLineDash([2, 3]);
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let t = 0; t <= safeActiveIdx; t++) {
        const x = barToX(t);
        const y = priceToY(dataset.columnsByBar[t].bookCenter);
        if (t === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 2. Stepped Daily MAs:
    // SMA 5 (D) as a stepped 1.5px solid white line (#ffffff)
    // EMA 21 (D) (#14b8a6, 1.25px) and SMA 55 (D) (#f97316, 1.25px)
    const drawSteppedLine = (
      getPointY: (idx: number) => number,
      strokeColor: string,
      lineWidth: number
    ) => {
      if (safeActiveIdx < 1) return;
      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      for (let t = 0; t <= safeActiveIdx; t++) {
        const x = barToX(t);
        const y = getPointY(t);
        if (t === 0) {
          ctx.moveTo(x - colStepX * 0.4, y);
          ctx.lineTo(x + colStepX * 0.5, y);
        } else {
          ctx.lineTo(x - colStepX * 0.5, y);
          ctx.lineTo(x + colStepX * 0.5, y);
        }
      }
      ctx.stroke();
      ctx.restore();
    };

    drawSteppedLine((t) => priceToY(dataset.candles[t].sma5d), "#ffffff", 1.5);
    drawSteppedLine((t) => priceToY(dataset.candles[t].ema21d), "#14b8a6", 1.25);
    drawSteppedLine((t) => priceToY(dataset.candles[t].sma55d), "#f97316", 1.25);

    // 3. Dynamic Intraday SMA 34 (5m) (1.75px, #ef4444 when close < sma34, #22c55e when close >= sma34)
    if (safeActiveIdx >= 1) {
      ctx.save();
      ctx.lineWidth = 1.75;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (let t = 1; t <= safeActiveIdx; t++) {
        const prevBar = dataset.candles[t - 1];
        const curBar = dataset.candles[t];
        ctx.strokeStyle =
          curBar.close >= curBar.sma34 ? "#22c55e" : "#ef4444";
        ctx.beginPath();
        ctx.moveTo(barToX(t - 1), priceToY(prevBar.sma34));
        ctx.lineTo(barToX(t), priceToY(curBar.sma34));
        ctx.stroke();
      }
      ctx.restore();
    }

    // =========================================================================
    // LAYER 3: 5-Minute Candlesticks & Non-Repainting Pivot Divergence Engine
    // =========================================================================
    const candleBodyWidth = Math.max(3, Math.min(6.5, colStepX * 0.58));

    for (let t = 0; t <= safeActiveIdx; t++) {
      const c = dataset.candles[t];
      const x = barToX(t);
      const yHigh = priceToY(c.high);
      const yLow = priceToY(c.low);
      const yOpen = priceToY(c.open);
      const yClose = priceToY(c.close);
      const isBull = c.close >= c.open;
      const color = isBull ? "#10b981" : "#ef4444";

      // High-Low Wick
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      // Open-Close Body
      const bodyTop = Math.min(yOpen, yClose);
      const bodyH = Math.max(1.8, Math.abs(yClose - yOpen));
      ctx.fillStyle = color;
      ctx.fillRect(
        x - candleBodyWidth / 2,
        bodyTop,
        candleBodyWidth,
        bodyH
      );
    }

    // Non-Repainting 3-Left / 3-Right Pivot Divergence Lines & Triangles
    const drawTriangle = (tx: number, ty: number, isBull: boolean, isNearLevel: boolean = false) => {
      ctx.fillStyle = isBull ? "#22c55e" : "#ef4444";
      ctx.beginPath();
      if (isBull) {
        ctx.moveTo(tx, ty + 3);
        ctx.lineTo(tx - 3.8, ty + 9.5);
        ctx.lineTo(tx + 3.8, ty + 9.5);
      } else {
        ctx.moveTo(tx, ty - 3);
        ctx.lineTo(tx - 3.8, ty - 9.5);
        ctx.lineTo(tx + 3.8, ty - 9.5);
      }
      ctx.closePath();
      ctx.fill();
      if (isNearLevel) {
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    };

    const curKing = dataset.columnsByBar[safeActiveIdx]?.allExpKingStrike ?? 0;
    for (const sig of dataset.pivotSignals5m) {
      if (safeActiveIdx < sig.confirmedAtIndex) continue;

      const x2 = barToX(sig.p2Index);
      const y2 = priceToY(sig.p2Price);
      const isNear = curKing > 0 && Math.abs(sig.p2Price - curKing) / curKing <= 0.0015;

      ctx.save();
      if (sig.p1Index >= 0) {
        const x1 = barToX(sig.p1Index);
        const y1 = priceToY(sig.p1Price);

        // Solid white line (#ffffff, 2px) connecting pivot wicks P1 to P2
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        drawTriangle(x1, y1, sig.type === "BULL", false);
      }

      drawTriangle(x2, y2, sig.type === "BULL", isNear);
      ctx.restore();
    }

    // =========================================================================
    // LAYER 5: Outlook Zone (Expected-Move Cone, Plateau Fills & Path to King)
    // =========================================================================
    const yPriorClose = priceToY(dataset.priorClose);
    const pPlus1 = dataset.priorClose + dataset.sigma1Move;
    const pMinus1 = dataset.priorClose - dataset.sigma1Move;
    const pPlus2 = dataset.priorClose + dataset.sigma2Move;
    const pMinus2 = dataset.priorClose - dataset.sigma2Move;

    const yPlus1 = priceToY(pPlus1);
    const yMinus1 = priceToY(pMinus1);
    const yPlus2 = priceToY(pPlus2);
    const yMinus2 = priceToY(pMinus2);

    ctx.save();
    // Outer ±2σ wings fill (rgba(168, 85, 247, 0.14))
    ctx.fillStyle = "rgba(168, 85, 247, 0.14)";
    ctx.beginPath();
    ctx.moveTo(dividerX, yPriorClose);
    ctx.lineTo(outlookRightX, yPlus2);
    ctx.lineTo(outlookRightX, yPlus1);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(dividerX, yPriorClose);
    ctx.lineTo(outlookRightX, yMinus1);
    ctx.lineTo(outlookRightX, yMinus2);
    ctx.closePath();
    ctx.fill();

    // Subtle horizontal plateau band fills at the right edge of the 2σ cone
    const plateauRatio2 = 0.72;
    const plateauX2 = dividerX + (outlookRightX - dividerX) * plateauRatio2;
    const plateauYTop2 = yPriorClose + (yPlus2 - yPriorClose) * plateauRatio2;
    const plateauYBot2 = yPriorClose + (yMinus2 - yPriorClose) * plateauRatio2;

    ctx.fillStyle = "rgba(168, 85, 247, 0.22)";
    ctx.beginPath();
    ctx.moveTo(plateauX2, plateauYTop2);
    ctx.lineTo(outlookRightX, yPlus2);
    ctx.lineTo(outlookRightX, plateauYTop2);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(plateauX2, plateauYBot2);
    ctx.lineTo(outlookRightX, yMinus2);
    ctx.lineTo(outlookRightX, plateauYBot2);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "rgba(168, 85, 247, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plateauX2, plateauYTop2);
    ctx.lineTo(outlookRightX, plateauYTop2);
    ctx.moveTo(plateauX2, plateauYBot2);
    ctx.lineTo(outlookRightX, plateauYBot2);
    ctx.stroke();

    // Inner ±1σ cone fill (rgba(56, 189, 248, 0.16))
    ctx.fillStyle = "rgba(56, 189, 248, 0.16)";
    ctx.beginPath();
    ctx.moveTo(dividerX, yPriorClose);
    ctx.lineTo(outlookRightX, yPlus1);
    ctx.lineTo(outlookRightX, yMinus1);
    ctx.closePath();
    ctx.fill();

    // Stroke ±2σ rays (#a855f7, 1.25px)
    ctx.strokeStyle = "#a855f7";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(dividerX, yPriorClose);
    ctx.lineTo(outlookRightX, yPlus2);
    ctx.moveTo(dividerX, yPriorClose);
    ctx.lineTo(outlookRightX, yMinus2);
    ctx.stroke();

    // Stroke ±1σ rays (#38bdf8, 1.25px)
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(dividerX, yPriorClose);
    ctx.lineTo(outlookRightX, yPlus1);
    ctx.moveTo(dividerX, yPriorClose);
    ctx.lineTo(outlookRightX, yMinus1);
    ctx.stroke();

    // Crisp white circular vertex dot (#ffffff, radius 3.5px) at Prior Close on outlook divider
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(dividerX, yPriorClose, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Pin (+GEX, cyan tint) and Fast-move (-GEX, purple tint) shading inside right-side outlook cone
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dividerX, yPriorClose);
    ctx.lineTo(outlookRightX, yPlus2);
    ctx.lineTo(outlookRightX, yMinus2);
    ctx.closePath();
    ctx.clip();

    const activeCol = dataset.columnsByBar[safeActiveIdx];
    if (activeCol) {
      // Shade Pin zones (+exposure)
      const posStrikes = dataset.visibleStrikes.filter(
        (k) =>
          (activeCol.strikeValues[k] ?? 0) > 0 &&
          Math.abs(k - dataset.priorClose) <= dataset.sigma2Move
      );
      posStrikes.forEach((k) => {
        const y = priceToY(k);
        ctx.fillStyle = "rgba(34, 211, 238, 0.22)";
        ctx.fillRect(dividerX, y - 4, outlookRightX - dividerX, 8);
      });

      // Shade Fast zones (-exposure)
      const negStrikes = dataset.visibleStrikes.filter(
        (k) =>
          (activeCol.strikeValues[k] ?? 0) < 0 &&
          Math.abs(k - dataset.priorClose) <= dataset.sigma2Move
      );
      negStrikes.forEach((k) => {
        const y = priceToY(k);
        ctx.fillStyle = "rgba(232, 121, 249, 0.24)";
        ctx.fillRect(dividerX, y - 4, outlookRightX - dividerX, 8);
      });
    }
    ctx.restore();
    ctx.restore();

    // Path to King Projection (dashed gold curve #eab308, stroke-dasharray: 4 4, anchored to All-exp King)
    if (pathToKing && dataset.candles[safeActiveIdx]) {
      const startX = barToX(safeActiveIdx);
      const startY = priceToY(dataset.candles[safeActiveIdx].close);
      const endX = outlookEndX;
      const endY = yAllExpKing;

      ctx.save();
      ctx.strokeStyle = "#eab308";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(startX, startY);

      const steps = 16;
      for (let s = 1; s <= steps; s++) {
        const u = s / steps;
        const px = startX + (endX - startX) * u;
        const ease = 1 - Math.pow(1 - u, 1.65);
        const waveOffset =
          s === steps ? 0 : Math.sin(u * Math.PI * 3) * 2.5 * (1 - u);
        const py = startY + (endY - startY) * ease + waveOffset;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Gold terminal dot (#facc15) at (endX, yAllExpKing)
      ctx.fillStyle = "#facc15";
      ctx.beginPath();
      ctx.arc(endX, endY, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Dark pill badges for 1σ, 2σ, and King {Strike}
    const drawBadge = (
      text: string,
      edgeX: number,
      rawCenterY: number,
      options?: {
        bgColor?: string;
        borderColor?: string;
        textColor?: string;
        maskBehind?: boolean;
        align?: "left" | "right";
      }
    ): number => {
      const {
        bgColor = "#0f1522",
        borderColor = "#232d42",
        textColor = "#e2e8f0",
        maskBehind = false,
        align = "right",
      } = options ?? {};
      ctx.save();
      ctx.font = "bold 10px ui-monospace, SFMono-Regular, Menlo, monospace";
      const metrics = ctx.measureText(text);
      const padH = 6;
      const badgeW = metrics.width + padH * 2;
      const badgeH = 18;
      const centerY = Math.max(
        padTop + badgeH / 2 + 2,
        Math.min(height - padBottom - badgeH / 2 - 2, rawCenterY)
      );
      const bx = align === "left" ? edgeX : edgeX - badgeW;
      const by = centerY - badgeH / 2;

      if (maskBehind) {
        ctx.fillStyle = "#0d111a";
        ctx.fillRect(bx - 3, by - 1, badgeW + 6, badgeH + 2);
      }

      ctx.fillStyle = bgColor;
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, badgeW, badgeH, 5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = textColor;
      ctx.textBaseline = "middle";
      ctx.fillText(text, bx + padH, centerY + 0.5);
      ctx.restore();
      return badgeW;
    };

    // 2σ and 1σ badges inside the outlook column
    drawBadge(`2σ ${pPlus2.toFixed(2)}`, outlookRightX - 4, yPlus2 + 9, {
      bgColor: "#111726",
      borderColor: "rgba(168, 85, 247, 0.45)",
      textColor: "#f8fafc",
    });
    drawBadge("1σ", outlookRightX - 4, yPlus1 + 6, {
      bgColor: "#111726",
      borderColor: "rgba(56, 189, 248, 0.45)",
      textColor: "#f8fafc",
    });
    drawBadge("1σ", outlookRightX - 4, yMinus1 - 6, {
      bgColor: "#111726",
      borderColor: "rgba(56, 189, 248, 0.45)",
      textColor: "#f8fafc",
    });
    drawBadge("2σ", outlookRightX - 4, yMinus2 - 9, {
      bgColor: "#111726",
      borderColor: "rgba(168, 85, 247, 0.45)",
      textColor: "#f8fafc",
    });

    // Global All-exp King {Strike} callout badge immediately inside the left edge of the outlook column (outlookStartX + 6px)
    const kingBadgeW = drawBadge(
      `King ${allExpKingStrike}`,
      dividerX + 6,
      yAllExpKing,
      {
        bgColor: "#101520",
        borderColor: "rgba(202, 138, 4, 0.5)",
        textColor: "#facc15",
        maskBehind: true,
        align: "left",
      }
    );

    // Filtered King {Strike} callout badge immediately inside the left edge of the outlook column (outlookStartX + 6px)
    if (isFiltered && Number.isFinite(filteredKingStrike)) {
      const isCloseToAllExpKing = Math.abs(yFilteredKing - yAllExpKing) < 20;
      const filteredBadgeLeftX = isCloseToAllExpKing
        ? dividerX + 6 + kingBadgeW + 6
        : dividerX + 6;
      drawBadge(
        `${canvasFilterBadgePrefix} ${filteredKingStrike}`,
        filteredBadgeLeftX,
        yFilteredKing,
        {
          bgColor: "#151b28",
          borderColor: "#232d42",
          textColor: "#ffffff",
          maskBehind: true,
          align: "left",
        }
      );
    }

    // Right Price Axis Ticks inside the [outlookRightX + 8, width] 64px gutter
    ctx.save();
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#94a3b8";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    dataset.yAxisTicks.forEach((tickPrice) => {
      const y = priceToY(tickPrice);
      ctx.fillText(tickPrice.toFixed(2), outlookRightX + 8, y);
    });
    ctx.restore();

    // Bottom X-Axis Labels: 9:30 AM, 12:45 PM, 3:55 PM, and outlook
    ctx.save();
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#94a3b8";
    ctx.textBaseline = "bottom";

    ctx.textAlign = "left";
    ctx.fillText(dataset.candles[0]?.timeLabel ?? "9:30 AM", padLeft, height - 8);

    const midIdx = Math.min(39, Math.floor(dataset.candles.length / 2));
    ctx.textAlign = "center";
    ctx.fillText(
      dataset.candles[midIdx]?.timeLabel ?? "12:45 PM",
      barToX(midIdx),
      height - 8
    );

    ctx.textAlign = "right";
    ctx.fillText(
      dataset.candles[dataset.candles.length - 1]?.timeLabel ?? "3:55 PM",
      dividerX - 6,
      height - 8
    );

    ctx.textAlign = "center";
    ctx.fillStyle = "#64748b";
    ctx.fillText(
      "outlook",
      dividerX + (outlookRightX - dividerX) / 2,
      height - 8
    );
    ctx.restore();

    // Subtle crosshair on hover
    if (hoverBarIndex !== null && hoverBarIndex <= safeActiveIdx) {
      const hx = barToX(hoverBarIndex);
      ctx.save();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, padTop);
      ctx.lineTo(hx, height - padBottom);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }, [
    dataset,
    safeActiveIdx,
    hoverBarIndex,
    pathToKing,
    canvasWidth,
    activeBookCol,
    exposureMode,
    expFilter,
    canvasFilterBadgePrefix,
  ]);

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dataset) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const padLeft = 18;
    const rightAxisWidth = 64;
    const totalPlotWidth = rect.width - padLeft - rightAxisWidth;
    const dividerX = padLeft + totalPlotWidth * 0.76;

    if (mouseX < padLeft || mouseX > dividerX) {
      setHoverBarIndex(null);
      return;
    }

    const totalSlots = Math.max(78, dataset.candles.length);
    const ratio = (mouseX - padLeft) / Math.max(1, dividerX - padLeft);
    const barIdx = Math.max(
      0,
      Math.min(safeActiveIdx, Math.floor(ratio * totalSlots))
    );
    setHoverBarIndex(barIdx);
  };

  const isSma34Bullish = activeCandle
    ? activeCandle.close >= activeCandle.sma34
    : true;
  const sliderProgressPct =
    maxBarIdx > 0 ? (safeActiveIdx / maxBarIdx) * 100 : 100;

  return (
    <div className="space-y-3.5 pb-4">
      {/* 2A. Section Title & Collapsible Guide */}
      <div className="space-y-2.5">
        <h1 className="text-xl font-bold text-white tracking-tight">Gaia</h1>

        <div className="bg-[#101520] border border-[#1e2638] rounded-xl transition-all duration-150">
          <button
            type="button"
            onClick={() => setGuideExpanded((prev) => !prev)}
            className="w-full text-left px-4 py-2.5 text-xs font-bold text-[#38bdf8] hover:text-sky-300 flex items-center justify-between cursor-pointer"
          >
            <span>? How to read Gaia</span>
          </button>

          {guideExpanded && (
            <div className="px-4 pb-4 pt-1 grid grid-cols-1 md:grid-cols-[150px_1fr] gap-y-2.5 gap-x-4 text-xs leading-relaxed border-t border-[#1e2638]/40">
              <div className="font-bold text-white">Candles</div>
              <div className="text-slate-300">
                One regular session (9:30am–4pm ET) in 5-minute candles. Green closed up, red closed down.
              </div>

              <div className="font-bold text-white">Divergence</div>
              <div className="text-slate-300">
                SPY, QQQ, SPXW and IWM only. The table at the chart&apos;s top-right reads{" "}
                <span className="text-[#22c55e] font-bold">BULL</span> when price made a lower low while RSI(14) and the MACD(12,26,9) histogram both made a higher low on the same two pivots,{" "}
                <span className="text-[#ef4444] font-bold">BEAR</span> for a higher high with both making a lower high, and NO otherwise. Each pivot needs 3 finished bars on each side and a forming bar is never used, so a mark never moves or disappears once drawn. A row stays BULL or BEAR for 30 bars after the second pivot. 5-minute signals are drawn on the chart: a solid white line from the first pivot&apos;s wick to the second&apos;s (down for BULL, up for BEAR) and a small triangle at the second pivot. &quot;near King/Call wall/Put wall&quot; means that pivot sits within 0.15% of today&apos;s level. Not a forecast.
              </div>

              <div className="font-bold text-white">Moving averages</div>
              <div className="text-slate-300">
                <span className="inline-block w-3 h-0.5 bg-white align-middle mr-1" />
                SMA 5 (D, white),{" "}
                <span className="inline-block w-3 h-0.5 bg-[#14b8a6] align-middle mx-1" />
                EMA 21 (D, teal) and{" "}
                <span className="inline-block w-3 h-0.5 bg-[#f97316] align-middle mx-1" />
                SMA 55 (D, orange) are daily averages: prior daily closes plus today&apos;s live price as today&apos;s close. They are drawn as flat levels across the 5-minute candles and step as price moves.{" "}
                <span className="inline-block w-3 h-0.5 bg-[#22c55e] align-middle mx-1" />
                SMA 34 (5m) is the only intraday average, on 5-minute closes, green while price is above it and red while below. The row above the chart shows each one&apos;s current value.
              </div>

              <div className="font-bold text-white">Bubbles</div>
              <div className="text-slate-300">
                Each node strike is a row of bubbles at its price, one bubble per 5-minute candle, filling in left to right as the day goes on. A bigger, brighter bubble is larger net exposure at that candle.{" "}
                <span className="inline-block w-2 h-2 rounded-full bg-[#22d3ee] shadow-[0_0_6px_#22d3ee] align-middle mx-1" />
                Cyan is positive gamma, where dealer hedging tends to slow price down.{" "}
                <span className="inline-block w-2 h-2 rounded-full bg-[#a855f7] align-middle mx-1" />
                Purple is negative gamma, where hedging can speed moves up. The gold row is the King. Every strike with meaningful exposure gets a row; weak strikes are small, dim dots and strong ones are big, bright ovals. The gold bubble at each candle is that candle&apos;s King (largest net exposure), so the gold row can move during the day. When intraday snapshots are available, each candle uses the book at that time, so rows can grow, fade, appear, disappear or flip color; otherwise every candle uses today&apos;s book. The line above the chart shows net exposure and the three largest levels for the candle under your cursor, or the replay candle.
              </div>

              <div className="font-bold text-white">GEX · VEX · Combined</div>
              <div className="text-slate-300">
                GEX shows gamma bubbles. VEX shows vanna bubbles (amber positive, violet negative), how hedging shifts when volatility changes. Combined draws both.
              </div>

              <div className="font-bold text-white">King</div>
              <div className="text-slate-300">
                <span className="inline-block w-3 h-0.5 bg-[#facc15] align-middle mr-1" />
                The large glowing gold bubble, its gold line and the King tag mark the strike with the largest net gamma exposure across the selected expirations, with its label on the right. In VEX view it is the strike with the largest net vanna. VEX reflects volatility-driven, multi-day positioning, not an intraday target.
              </div>

              <div className="font-bold text-white">Center</div>
              <div className="text-slate-300">
                <span className="inline-block w-3 border-b-2 border-dotted border-white align-middle mr-1" />
                The white dotted line is the exposure-weighted center of the book right now.
              </div>

              <div className="font-bold text-white">Expiry filters</div>
              <div className="text-slate-300">
                All exp uses every expiration. 0DTE uses today&apos;s; after the close and on weekends that button reads Next exp and uses the next listed expiration. This week uses expirations through Friday. Date picks one expiration. A filtered King is shown when a filter is on.
              </div>

              <div className="font-bold text-white">Path to King</div>
              <div className="text-slate-300">
                A faint dashed path from the last candle to the King, drawn whenever price is away from the King. It is a projection for orientation, not a prediction. Tap the button to hide it.
              </div>

              <div className="font-bold text-white">Expected-move cone</div>
              <div className="text-slate-300">
                The cone on the right is the options-implied range from the prior close: the inner part is 1σ (about a 68% range), the outer part is 2σ (about 95%). The Range Outlook below lists the numbers. Daily, weekly and monthly moves are on the heatmap and in the guide.
              </div>

              <div className="font-bold text-white">Replay</div>
              <div className="text-slate-300">
                Snapshots are kept for the last 10 sessions; pick a date in the session menu to replay one. A past session is only shown when you pick it. Replay walks through today&apos;s session candle by candle with the King, Center and cone at each step; the bubbles show the book&apos;s strikes. Drag the slider to scrub.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2B. Session Context & Ticker Loader Bar */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 font-mono">
          <span>
            {dataset
              ? `${dataset.ticker} · ${dataset.sessionDate} · ${dataset.bookLabel}`
              : `${loadedTicker} · loading live session...`}
          </span>
          {sessionOptions.length > 0 && (
            <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
              <span>Session:</span>
              <select
                aria-label="Select trading session"
                value={selectedSessionIso}
                onChange={(e) => handleSessionChange(e.target.value)}
                className="bg-[#101520] border border-[#1e2638] rounded-md px-2 py-0.5 text-[11px] font-mono text-slate-300 focus:outline-none focus:border-[#38bdf8]"
              >
                {sessionOptions.map((s) => (
                  <option key={s.isoDate} value={s.isoDate}>
                    {s.isoDate}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <form
          onSubmit={handleLoadTicker}
          className="bg-[#101520] border border-[#1e2638] rounded-xl p-1.5 flex items-center justify-between"
        >
          <input
            type="text"
            value={tickerInput}
            onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
            placeholder="SPY"
            aria-label="Ticker symbol"
            className="bg-transparent text-white font-bold text-sm px-3 py-1 focus:outline-none flex-1 uppercase font-sans"
          />
          <button
            type="submit"
            disabled={isLoading}
            className="bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16] font-bold text-xs px-5 py-2 rounded-lg hover:opacity-95 transition cursor-pointer disabled:opacity-50"
          >
            {isLoading ? "Loading..." : "Load"}
          </button>
        </form>
      </div>

      {/* 2C. Horizontal Pill Filter Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 1. Exposure Mode Group */}
        <div className="bg-[#151b28] border border-[#232d42] rounded-full p-1 flex items-center gap-1">
          {(["GEX", "VEX", "Combined"] as const).map((mode) => {
            const active = exposureMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setExposureMode(mode)}
                className={cn(
                  "px-3.5 py-1 text-xs rounded-full transition cursor-pointer",
                  active
                    ? "bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16] font-bold"
                    : "text-slate-300 hover:text-white"
                )}
              >
                {mode}
              </button>
            );
          })}
        </div>

        {/* 2. Expiration Filter Group */}
        <div className="bg-[#151b28] border border-[#232d42] rounded-full p-1 flex items-center gap-1">
          {[
            { id: "ALL", label: "All exp" },
            { id: "NEXT", label: nextExpPillLabel },
            { id: "WEEK", label: "This week" },
          ].map((item) => {
            const active = expFilter === item.id && selectedDateExp === "";
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSelectedDateExp("");
                  setExpFilter(item.id);
                }}
                className={cn(
                  "px-3.5 py-1 text-xs rounded-full transition cursor-pointer",
                  active
                    ? "bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16] font-bold"
                    : "text-slate-300 hover:text-white"
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {/* 3. Date Dropdown Pill */}
        <div className="relative inline-flex items-center">
          <select
            aria-label="Filter by expiration date"
            value={selectedDateExp}
            onChange={(e) => {
              const val = e.target.value;
              setSelectedDateExp(val);
              if (val) {
                setExpFilter(val);
              } else {
                setExpFilter("ALL");
              }
            }}
            className={cn(
              "appearance-none bg-[#151b28] border border-[#232d42] rounded-full pl-3.5 pr-7 py-1.5 text-xs cursor-pointer focus:outline-none",
              selectedDateExp
                ? "text-[#38bdf8] font-bold border-[#38bdf8]/60"
                : "text-slate-200 hover:text-white"
            )}
          >
            <option value="">Date</option>
            {expirationOptions.map((exp) => (
              <option key={exp.isoDate} value={exp.dateLabel}>
                {exp.dateLabel}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2.5 text-[10px] text-slate-400">
            ▾
          </span>
        </div>

        {/* 4. Path to King Pill */}
        <button
          type="button"
          onClick={() => setPathToKing((prev) => !prev)}
          className={cn(
            "rounded-full px-3.5 py-1.5 text-xs transition cursor-pointer",
            pathToKing
              ? "bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16] font-bold"
              : "bg-[#151b28] border border-[#232d42] text-slate-300 hover:text-white"
          )}
        >
          Path to King
        </button>

        {/* 5. Reset View Pill */}
        <button
          type="button"
          onClick={handleResetView}
          className="bg-[#151b28] border border-[#232d42] text-slate-300 hover:text-white rounded-full px-3.5 py-1.5 text-xs transition cursor-pointer"
        >
          Reset view
        </button>
      </div>

      {/* Error State if Live Feed Fails */}
      {errorMsg && (
        <div className="bg-red-950/40 border border-red-500/40 rounded-xl px-4 py-3 text-xs text-red-200 flex items-center justify-between">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => fetchLiveAntaeus(loadedTicker, selectedSessionIso)}
            className="px-3 py-1 rounded-md bg-red-500/20 hover:bg-red-500/30 text-red-100 font-semibold cursor-pointer"
          >
            Retry Live Feed
          </button>
        </div>
      )}

      {/* 2D. Pre-Chart Telemetry & Legend Strip */}
      {dataset && activeCandle && activeBookCol && (
        <div className="space-y-2 pt-0.5">
          {/* 1. Dual Pre-Chart King Pill Badges */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="bg-yellow-500/12 border border-yellow-500/80 text-[#fde047] rounded-full px-3.5 py-1 text-xs font-bold inline-flex items-center">
              All-exp King {activeBookCol.allExpKingStrike} ·{" "}
              {formatPct(activeBookCol.allExpKingConcPct)}%
            </span>
            {(exposureMode === "VEX" || exposureMode === "Combined") && (
              <span className="bg-amber-500/15 border border-amber-400/80 text-[#fde047] rounded-full px-3.5 py-1 text-xs font-bold inline-flex items-center">
                VEX King (multi-day) {activeBookCol.allExpKingStrike}
              </span>
            )}
            {expFilter !== "ALL" && (
              <span className="bg-[#151b28] border border-slate-500/60 text-white rounded-full px-3.5 py-1 text-xs font-bold inline-flex items-center">
                {expFilter === "NEXT"
                  ? has0DteActive
                    ? `0DTE King ${activeBookCol.filteredKingStrike} · ${formatPct(activeBookCol.filteredKingConcPct)}%`
                    : `Next exp King ${activeBookCol.filteredKingStrike}${nextExpShortDate ? ` (${nextExpShortDate})` : ""} · ${formatPct(activeBookCol.filteredKingConcPct)}%`
                  : expFilter === "WEEK"
                    ? `Week King ${activeBookCol.filteredKingStrike} · ${formatPct(activeBookCol.filteredKingConcPct)}%`
                    : `${expFilter} King ${activeBookCol.filteredKingStrike} · ${formatPct(activeBookCol.filteredKingConcPct)}%`}
              </span>
            )}
          </div>

          {/* 2. Moving Average Readout Row */}
          <div className="text-[11px] font-mono tabular-nums flex flex-wrap items-center gap-4 text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-[2px] bg-[#ffffff]" />
              <span>SMA 5 (D)</span>
              <span className="font-bold text-white">
                {activeCandle.sma5d.toFixed(2)}
              </span>
            </span>

            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-[2px] bg-[#14b8a6]" />
              <span>EMA 21 (D)</span>
              <span className="font-bold text-white">
                {activeCandle.ema21d.toFixed(2)}
              </span>
            </span>

            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-[2px]"
                style={{
                  backgroundColor: isSma34Bullish ? "#22c55e" : "#ef4444",
                }}
              />
              <span>SMA 34 (5m)</span>
              <span className="font-bold text-white">
                {activeCandle.sma34.toFixed(2)}
              </span>
            </span>

            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-[2px] bg-[#f97316]" />
              <span>SMA 55 (D)</span>
              <span className="font-bold text-white">
                {activeCandle.sma55d.toFixed(2)}
              </span>
            </span>
          </div>

          {/* 3. Active Candle Book Readout */}
          <div className="text-[11px] font-mono tabular-nums text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{activeCandle.timeLabel}</span>
            <span>·</span>
            <span>
              Net {exposureMode}{" "}
              <strong className="text-white font-bold">
                {activeBookCol.netGexB >= 0 ? "+" : ""}
                {activeBookCol.netGexB.toFixed(2)}B
              </strong>
            </span>
            <span>·</span>
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>{exposureMode} levels</span>
              {activeBookCol.topLevels.map((lvl, idx) => {
                const isKingLvl = idx === 0;
                const valFormatted = formatBookLevelValue(lvl.valueM);
                if (isKingLvl) {
                  return (
                    <span key={lvl.strike} className="font-bold text-[#facc15]">
                      {lvl.strike} {valFormatted}
                    </span>
                  );
                }
                return (
                  <span key={lvl.strike} className="inline-flex items-center gap-1">
                    <strong className="text-white font-bold">{lvl.strike}</strong>
                    <span
                      className={cn(
                        "font-bold",
                        lvl.valueM >= 0 ? "text-[#22d3ee]" : "text-[#a855f7]"
                      )}
                    >
                      {valFormatted}
                    </span>
                  </span>
                );
              })}
            </span>
            <span>·</span>
            <span>today&apos;s book</span>
          </div>

          {/* 4. Interactive Legend Row */}
          <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#22d3ee] shadow-[0_0_8px_#22d3ee] inline-block" />
              <span>Positive γ</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#a855f7] inline-block" />
              <span>Negative γ</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#facc15] shadow-[0_0_8px_rgba(250,204,21,0.7)] inline-block" />
              <span>King</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#f8fafc] inline-block" />
              <span>Center</span>
            </span>
            {expFilter !== "ALL" && (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#38bdf8] inline-block" />
                <span>Filter</span>
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <span className="w-4 border-b-2 border-dotted border-[#eab308] inline-block" />
              <span>Path to King · projection</span>
            </span>
          </div>
        </div>
      )}

      {/* 3 & 4A. Core Chart Canvas Card + Interactive Session Replay Bar */}
      <div
        ref={containerRef}
        className="bg-[#0d111a] border border-[#1e2638] rounded-2xl p-4 space-y-3"
      >
        <div className="relative w-full overflow-hidden min-h-[540px] flex items-center justify-center">
          {!dataset && isLoading && (
            <div className="text-xs font-mono text-slate-400">
              Loading live intraday candles &amp; options book for {loadedTicker}...
            </div>
          )}

          <canvas
            ref={canvasRef}
            onMouseMove={handleCanvasMouseMove}
            onMouseLeave={() => setHoverBarIndex(null)}
            className={cn(
              "block w-full h-[540px] cursor-crosshair select-none",
              !dataset && "hidden"
            )}
          />

          {/* Layer 4: Multi-Timeframe Divergence HUD Table (top-right of candlestick zone, SPY, QQQ, SPXW, IWM only) */}
          {dataset && DIVSYM.has(loadedTicker.toUpperCase()) && (
            <div
              className="absolute top-3 z-10 bg-[#0d121c]/95 border border-[#232d42] rounded-md text-[11px] font-mono overflow-hidden shadow-lg"
              style={{
                right: `${Math.round(
                  canvasWidth - (18 + (canvasWidth - 18 - 64) * 0.76) + 10
                )}px`,
              }}
            >
              <table className="border-collapse">
                <tbody>
                  {(divPayload?.rows && divPayload.rows.length === 5
                    ? divPayload.rows.map((r) => ({
                        tf: r.tf,
                        label:
                          r.tf === "5"
                            ? "5 min divergence"
                            : r.tf === "30"
                              ? "30 min divergence"
                              : r.tf === "120"
                                ? "2HR divergence"
                                : r.tf === "D"
                                  ? "Daily divergence"
                                  : "Weekly divergence",
                        status: r.state,
                        detail:
                          r.state === "NO" || !r.signal
                            ? "No confirmed divergence in the last 30 bars"
                            : `${r.signal.type.toUpperCase()} · pivots ${divWhen(r.signal.t1, r.intraday)} (${r.signal.p1}) → ${divWhen(r.signal.t2, r.intraday)} (${r.signal.p2})`,
                        near:
                          r.signal?.near && r.signal.near.length > 0
                            ? r.signal.near.map((n) => `${n[0]} ${n[1]}`).join(", ")
                            : null,
                      }))
                    : [
                        { tf: "5", label: "5 min divergence", status: mtfDivergence.tf5m, detail: "No confirmed divergence in the last 30 bars", near: null },
                        { tf: "30", label: "30 min divergence", status: mtfDivergence.tf30m, detail: "No confirmed divergence in the last 30 bars", near: null },
                        { tf: "120", label: "2HR divergence", status: mtfDivergence.tf2h, detail: "No confirmed divergence in the last 30 bars", near: null },
                        { tf: "D", label: "Daily divergence", status: mtfDivergence.tfDaily, detail: "No confirmed divergence in the last 30 bars", near: null },
                        { tf: "W", label: "Weekly divergence", status: mtfDivergence.tfWeekly, detail: "No confirmed divergence in the last 30 bars", near: null },
                      ]
                  ).map((row, idx) => {
                    const isOpen = openDivTf === row.tf;
                    return (
                      <React.Fragment key={row.tf}>
                        <tr
                          onClick={() => setOpenDivTf(isOpen ? null : row.tf)}
                          className={cn(
                            "cursor-pointer hover:bg-white/5 transition-colors",
                            idx > 0 && "border-t border-[#1e2638]"
                          )}
                        >
                          <td className="px-2.5 py-1 text-slate-200 border-r border-[#1e2638]">
                            {row.label}
                          </td>
                          <td
                            className={cn(
                              "px-2.5 py-1 text-center font-bold min-w-[42px]",
                              row.status === "BULL"
                                ? "text-[#22c55e]"
                                : row.status === "BEAR"
                                  ? "text-[#ef4444]"
                                  : "text-slate-400"
                            )}
                          >
                            {row.status}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-t border-[#1e2638]/50 bg-[#080d17]">
                            <td colSpan={2} className="px-2.5 py-1 text-[10px] text-slate-400 max-w-[240px]">
                              <span>{row.detail}</span>
                              {row.near && (
                                <span className="text-[#facc15] font-semibold ml-1">
                                  · near {row.near}
                                </span>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 4A. Interactive Session Replay Bar */}
        {dataset && (
          <div className="bg-[#101520] border border-[#1e2638] rounded-xl px-4 py-2.5 flex items-center gap-4">
            <button
              type="button"
              onClick={handleToggleReplay}
              className="bg-gradient-to-r from-[#38bdf8] to-[#818cf8] text-[#090d16] font-bold text-xs px-4 py-1.5 rounded-full hover:opacity-95 transition cursor-pointer shrink-0"
            >
              {isReplaying ? "Pause" : "Replay"}
            </button>

            {/* Custom Glowing Cyan Range Scrubber */}
            <div className="relative flex-1 flex items-center h-5">
              <div className="w-full h-1.5 rounded-full bg-[#1e2638] overflow-hidden">
                <div
                  className="h-full bg-[#22d3ee] shadow-[0_0_8px_#22d3ee]"
                  style={{ width: `${sliderProgressPct}%` }}
                />
              </div>
              <div
                className="pointer-events-none absolute w-4 h-4 rounded-full bg-[#22d3ee] shadow-[0_0_10px_#22d3ee] -translate-x-1/2"
                style={{ left: `${sliderProgressPct}%` }}
              />
              <input
                type="range"
                min={0}
                max={maxBarIdx}
                value={safeActiveIdx}
                aria-label="Session replay scrubber"
                onChange={(e) => {
                  setIsReplaying(false);
                  setActiveBarIndex(Number(e.target.value));
                }}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>

            <span className="font-mono text-xs text-slate-300 tabular-nums shrink-0">
              {dataset.candles[safeActiveIdx]?.timeLabel ?? "3:55 PM"}
            </span>
          </div>
        )}
      </div>

      {/* 4B. Range Outlook Summary Card */}
      {dataset && (
        <div className="bg-[#101520] border border-[#1e2638] rounded-xl p-4 space-y-2.5">
          <div className="text-[11px] font-bold uppercase tracking-wider text-[#38bdf8]">
            RANGE OUTLOOK
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <span className="bg-[#151b28] border border-[#232d42] rounded-full px-3.5 py-1.5 text-xs font-mono font-bold text-white">
              Prior close ${dataset.priorClose.toFixed(2)}
            </span>
            <span className="bg-[#151b28] border border-[#232d42] rounded-full px-3.5 py-1.5 text-xs font-mono font-bold text-white">
              ±1σ ${(dataset.priorClose - dataset.sigma1Move).toFixed(2)} – $
              {(dataset.priorClose + dataset.sigma1Move).toFixed(2)}
            </span>
            <span className="bg-[#151b28] border border-[#232d42] rounded-full px-3.5 py-1.5 text-xs font-mono font-bold text-white">
              ±2σ ${(dataset.priorClose - dataset.sigma2Move).toFixed(2)} – $
              {(dataset.priorClose + dataset.sigma2Move).toFixed(2)}
            </span>
          </div>

          <p className="text-[11px] text-slate-400">
            Probabilistic range from options pricing. Not a forecast. Not
            financial advice.
          </p>
        </div>
      )}
    </div>
  );
}

export const GaiaView = AntaeusView;
