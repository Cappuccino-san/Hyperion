"use client";

import React, { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useDashboardStore } from "@/store/useDashboardStore";
import { LineChart as LineChartIcon } from "lucide-react";

export function IntradayChart() {
  const activeTicker = useDashboardStore((state) => state.activeTicker);
  const intradayData = useDashboardStore((state) => state.intradayData);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Calculate tight Y domain so walls & spot are clearly visible
  const allValues = intradayData.flatMap((d) => [
    d.spot,
    d.callWall,
    d.putWall,
    d.zeroGamma,
  ]);
  const minVal = allValues.length ? Math.min(...allValues) : 0;
  const maxVal = allValues.length ? Math.max(...allValues) : 100;
  const pad = Math.max(1, (maxVal - minVal) * 0.12);
  const domainMin = Number((minVal - pad).toFixed(1));
  const domainMax = Number((maxVal + pad).toFixed(1));

  return (
    <div className="argon-card rounded-xl p-4 flex flex-col h-full">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <LineChartIcon className="h-4 w-4 text-argon-info" />
          <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-argon-text">
            {activeTicker} Intraday Spot vs. Gamma Walls
          </h3>
        </div>

        {/* Custom Legend matching Hyperion colors */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono">
          <span className="inline-flex items-center gap-1.5 text-white">
            <span className="h-0.5 w-3.5 bg-white inline-block" />
            Spot (#ffffff)
          </span>
          <span className="inline-flex items-center gap-1.5 text-argon-info">
            <span className="h-0.5 w-3.5 border-b-2 border-dashed border-[#11cdef] inline-block" />
            Call Wall (#11cdef)
          </span>
          <span className="inline-flex items-center gap-1.5 text-argon-danger">
            <span className="h-0.5 w-3.5 border-b-2 border-dashed border-[#f5365c] inline-block" />
            Put Wall (#f5365c)
          </span>
          <span className="inline-flex items-center gap-1.5 text-argon-warning">
            <span className="h-0.5 w-3.5 border-b-2 border-dotted border-[#fb6340] inline-block" />
            Zero γ (#fb6340)
          </span>
        </div>
      </div>

      <div className="h-48 w-full">
        {mounted ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={intradayData}
              margin={{ top: 6, right: 12, left: 4, bottom: 2 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(136, 152, 170, 0.12)"
                vertical={false}
              />
              <XAxis
                dataKey="time"
                stroke="#8898aa"
                tick={{ fill: "#8898aa", fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
                axisLine={{ stroke: "rgba(136, 152, 170, 0.2)" }}
                minTickGap={28}
              />
              <YAxis
                domain={[domainMin, domainMax]}
                stroke="#8898aa"
                tick={{ fill: "#8898aa", fontSize: 10, fontFamily: "monospace" }}
                tickLine={false}
                axisLine={{ stroke: "rgba(136, 152, 170, 0.2)" }}
                tickFormatter={(val: number) => `$${val.toFixed(0)}`}
                width={54}
              />
              <Tooltip
                isAnimationActive={false}
                contentStyle={{
                  backgroundColor: "#171941",
                  borderColor: "rgba(94, 114, 228, 0.45)",
                  borderRadius: "0.5rem",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  color: "#ced4da",
                  boxShadow: "0 0 1.5rem 0 rgba(0, 0, 0, 0.45)",
                }}
                formatter={(value: number, name: string) => [
                  `$${Number(value).toFixed(2)}`,
                  name,
                ]}
              />
              <Line
                type="stepAfter"
                dataKey="callWall"
                name="Call Wall"
                stroke="#11cdef"
                strokeWidth={1.75}
                strokeDasharray="6 4"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="stepAfter"
                dataKey="putWall"
                name="Put Wall"
                stroke="#f5365c"
                strokeWidth={1.75}
                strokeDasharray="6 4"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="stepAfter"
                dataKey="zeroGamma"
                name="Zero γ Flip"
                stroke="#fb6340"
                strokeWidth={1.75}
                strokeDasharray="2 3"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="spot"
                name="Spot"
                stroke="#ffffff"
                strokeWidth={2}
                dot={false}
                activeDot={{
                  r: 4,
                  fill: "#ffffff",
                  stroke: "#5e72e4",
                  strokeWidth: 2,
                }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full w-full flex items-center justify-center rounded-lg bg-argon-bg/40 border border-argon-muted/10 font-mono text-xs text-argon-muted">
            Initializing high-frequency telemetry stream...
          </div>
        )}
      </div>
    </div>
  );
}
