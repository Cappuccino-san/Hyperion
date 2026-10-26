"use client";

import React, { useEffect, useRef, useState } from "react";
import { FlowGammaVwapSnapshot } from "@/lib/flowGammaVwap";
import {
  drawFlowGammaVwapOverlay,
  ConfluenceLevel,
} from "./FlowGammaVwapOverlay";

export interface AntaeusCanvasCandle {
  timestamp: number;
  timeLabel: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface AntaeusCanvasProps {
  candles: AntaeusCanvasCandle[];
  flowVwapPoints: FlowGammaVwapSnapshot[];
  safeActiveIdx?: number;
  yMin: number;
  yMax: number;
  chartHeight?: number;
  kingStrike?: number;
  callWallStrike?: number;
  putWallStrike?: number;
  showFlowVwap?: boolean;
  className?: string;
}

export function AntaeusCanvas({
  candles,
  flowVwapPoints,
  safeActiveIdx,
  yMin,
  yMax,
  chartHeight = 520,
  kingStrike,
  callWallStrike,
  putWallStrike,
  showFlowVwap = true,
  className,
}: AntaeusCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState<number>(1040);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setCanvasWidth(Math.floor(entry.contentRect.width));
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const activeIdx =
    typeof safeActiveIdx === "number"
      ? safeActiveIdx
      : Math.max(0, candles.length - 1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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

    // 1. Pure Pitch-Black Background
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    const padLeft = 14;
    const rightAxisWidth = 74;
    const plotRightX = width - rightAxisWidth;
    const padTop = 38;
    const padBottom = 28;
    const plotHeight = height - padTop - padBottom;
    const plotWidth = plotRightX - padLeft;

    const priceToY = (price: number): number => {
      const ratio = (price - yMin) / Math.max(0.0001, yMax - yMin);
      return padTop + (1 - ratio) * plotHeight;
    };

    const totalSlots = Math.max(candles.length, 36);
    const stepX = plotWidth / totalSlots;
    const barToX = (idx: number): number => padLeft + (idx + 0.5) * stepX;

    // 2. Candlesticks Layer
    const candleWidth = Math.max(3.0, Math.min(stepX * 0.62, 7.5));
    for (let t = 0; t <= activeIdx; t++) {
      const c = candles[t];
      if (!c) continue;

      const cx = barToX(t);
      const yOpen = priceToY(c.open);
      const yClose = priceToY(c.close);
      const yHigh = priceToY(c.high);
      const yLow = priceToY(c.low);
      const isGreen = c.close >= c.open;
      const color = isGreen ? "#10b981" : "#f43f5e";

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, yHigh);
      ctx.lineTo(cx, yLow);
      ctx.stroke();

      const topBody = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));
      ctx.fillStyle = color;
      ctx.fillRect(cx - candleWidth / 2, topBody, candleWidth, bodyHeight);
    }

    // 3. Flow VWAP x Gamma & Dynamic Dispersion Bands Overlay
    if (showFlowVwap && flowVwapPoints && flowVwapPoints.length > 0) {
      const confluenceLevels: ConfluenceLevel[] = [];
      if (kingStrike && kingStrike > 0) confluenceLevels.push({ name: "King Node", strike: kingStrike });
      if (callWallStrike && callWallStrike > 0) confluenceLevels.push({ name: "Call Wall", strike: callWallStrike });
      if (putWallStrike && putWallStrike > 0) confluenceLevels.push({ name: "Put Wall", strike: putWallStrike });

      drawFlowGammaVwapOverlay({
        ctx,
        points: flowVwapPoints,
        safeActiveIdx: activeIdx,
        barToX,
        priceToY,
        padLeft,
        plotRightX,
        padTop,
        padBottom,
        chartHeight: height,
        rightAxisWidth,
        confluenceLevels,
        showCenterline: true,
        showBands: true,
        showShading: true,
        showConfluenceMarkers: true,
      });
    }

    // 4. Right Price Axis Gutter
    ctx.fillStyle = "#000000";
    ctx.fillRect(plotRightX, 0, rightAxisWidth, height);
    ctx.strokeStyle = "#1a202c";
    ctx.beginPath();
    ctx.moveTo(plotRightX + 0.5, 0);
    ctx.lineTo(plotRightX + 0.5, height);
    ctx.stroke();

    ctx.restore();
  }, [
    candles,
    flowVwapPoints,
    activeIdx,
    yMin,
    yMax,
    chartHeight,
    canvasWidth,
    kingStrike,
    callWallStrike,
    putWallStrike,
    showFlowVwap,
  ]);

  return (
    <div ref={containerRef} className={`w-full relative overflow-hidden ${className ?? ""}`}>
      <canvas ref={canvasRef} className="w-full block select-none" />
    </div>
  );
}
