# Hyperion — Quant Options & Gamma Intelligence Terminal

**Hyperion** is a real-time institutional options positioning and gamma exposure analytics terminal built with Next.js 14, TypeScript, Tailwind CSS, and Three.js. It visualizes dealer hedging flows across **Gamma Exposure (GEX)**, **Vanna Exposure (VEX)**, **Delta Exposure (DEX)**, and **Charm** using live CBOE and Tradier option chains.

---

## Core Views & Capabilities

### 1. Heatmap (`2D Grid` & `3D Surface`)
- **Multi-Expiration Exposure Matrix:** Virtualized strike-by-expiration heatmap across `All exp`, `0DTE / Next exp`, `This week`, `OPEX`, or specific expiration dates.
- **3-Stop Signature Color Scale:** Deep Purple (`-γ` short gamma valleys), Teal (near-zero plane), and Bright Gold (`+γ` positive gamma peaks) with a glowing gold star (`★`) highlighting the **All-exp King Node**.
- **Interactive 3D Gamma Mountain (`Surface3DView`):** Hardware-accelerated Three.js / WebGL surface topology with upright `+γ` peaks, `-γ` valleys, hover raycasting, and presets (`Front`, `Top`, `Side`, `Iso`, `Auto-Rotate`).
- **Structural Gamma Walls & Intraday Trajectory:** Real-time **Put Wall**, **Zero γ Flip**, **Call Wall**, and **King Node** summary cards paired with an interactive range slider and intraday spot vs. walls chart.

### 2. Quad View
- **Simultaneous 4-Index Positioning (`SPY`, `QQQ`, `SPXW`, `IWM`):** Side-by-side strike ladders with independent metric (`GEX`, `VEX`, `DEX`, `Charm`) and horizon (`All exp`, `0DTE`, `This week`) controls to monitor cross-asset dealer alignment.

### 3. Antaeus — Intraday 5m Gamma Matrix & MTF Divergence Engine
- **Live CBOE Contract Aggregation:** Computes strike-by-strike dollar gamma exposure across all active expirations:
  $$\text{GEX}_K = \frac{(\text{Call OI} \cdot \Gamma_{\text{call}} - \text{Put OI} \cdot \Gamma_{\text{put}}) \times 100 \times S^2 \times 0.01}{10^6}$$
- **Dual King Tracking (`All-exp King` + `Filtered King`):** Simultaneously tracks the global **All-exp King** (`solid gold line` + `Path to King` trajectory in the `outlook` zone) and the active **Filtered King** (`0DTE`, `Next exp`, `This week`, or `Date` with a dashed `#38bdf8` reference line and glowing gold bubble row).
- **Expected Move Cone & Moving Averages:** Overlays the intraday $\pm 1\sigma$ and $\pm 2\sigma$ expected move fan from prior close alongside `SMA 34 (5m)`, `5D SMA`, `21D EMA`, and `55D SMA`.
- **Non-Repainting Multi-Timeframe (MTF) Divergence Strip:** Real-time `5m`, `15m`, `1h`, `4h`, and `1D` RSI/MACD pivot divergence detector (`BULL` / `BEAR` / `NEUT`).

### 4. King Node Scanner
- **50+ Ticker Institutional Universe:** Ranks index ETFs, cash-settled indices (`SPX`, `SPXW`, `NDX`), sector ETFs, and high-beta equities by **Pull Score (0–100)** and **King Strength (0–100)**.
- **Regime & Migration Filters:** Filter by `All`, `Positive γ`, `Negative γ`, `Dominant King`, `Contested King`, or `King Moved`.

### 5. Hyperion Alerts (Discord Webhook Integration)
- Built-in throttled Discord webhook dispatcher (`/api/discord`) that sends rich embed notifications when **Call Wall**, **Put Wall**, **Zero γ Flip**, or **All-exp King Node** levels migrate.

---

## Quantitative Formulas

- **Gamma Exposure ($\text{GEX}$ in $\$M$):**
  $$\text{GEX}_K = \frac{(\text{OI}_C \cdot \Gamma_C - \text{OI}_P \cdot \Gamma_P) \times 100 \times S^2 \times 0.01}{10^6}$$
- **King Strength Score ($0\text{–}100$):**
  $$\text{King Strength} = \underbrace{\max\left(0, \left(1 - \frac{|\Gamma_2|}{|\Gamma_1|}\right) \times 50\right)}_{\text{Lead Over \#2 Strike (0–50 pts)}} + \underbrace{\min\left(1, \frac{|\Gamma_1| / \sum |\Gamma_i|}{0.25}\right) \times 50}_{\text{Board Concentration Share (0–50 pts)}}$$
- **Daily Expected Move ($\pm 1\sigma$):**
  $$\text{EM}_{1\sigma} = S_{\text{prev}} \times \sigma_{\text{ATM}} \times \sqrt{\frac{1}{252}}$$

---

## Getting Started

### Prerequisites
- **Node.js** `18.17+` (or `20+`)
- **npm** `9+`

### Installation & Local Development

```bash
# 1. Clone the repository
git clone https://github.com/Cappuccino-san/Hyperion.git
cd Hyperion

# 2. Install dependencies
npm install

# 3. Start the development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Optional Environment Variables (`.env.local`)

Hyperion works out of the box using live CBOE delayed option chain feeds and Yahoo Finance intraday bars. You can optionally configure Tradier real-time market data or a default Discord webhook in `.env.local`:

```env
# Optional: Tier-1 real-time options chain feed via Tradier API
TRADIER_API_KEY=your_tradier_api_key_here

# Optional: Default Discord Webhook URL for Hyperion Alerts
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

---

## Project Structure

```text
├── app/
│   ├── api/
│   │   ├── antaeus/route.ts       # Live CBOE + 5m/15m/1h/4h/1D Antaeus positioning engine
│   │   ├── discord/route.ts       # Hyperion Terminal Discord webhook dispatcher
│   │   └── options/route.ts       # Tradier & CBOE option chain ingestion route
│   ├── globals.css                # Obsidian theme tokens & custom scrollbars
│   ├── layout.tsx                 # Root layout & Hyperion metadata
│   └── page.tsx                   # Primary single-column terminal shell
├── components/
│   ├── header/                    # TopNavBar, TickerNav (50+ tickers), SpotDisplay
│   ├── heatmap/                   # Virtualized 2D HeatmapTable & Three.js Surface3DView
│   ├── intraday/                  # IntradayChart & real-time AlertsFeed
│   ├── metrics/                   # MetricsRow summary cards & GammaProgressBar
│   ├── modals/                    # GuideModal, CheatCodesModal & SetupModal
│   └── views/                     # AntaeusView, QuadView, ScannerView, ChartsView
├── lib/
│   ├── optionsExposure.ts         # Black-Scholes Greeks & GEX/VEX/DEX/Charm engine
│   └── utils.ts                   # Classname & formatting utilities
└── store/
    └── useDashboardStore.ts       # Zustand global state, filters & alert subscriptions
```

---

## Disclaimer

*For educational and informational purposes only. Not financial advice. Options trading involves substantial risk of loss. Market data may be delayed or inaccurate; trade at your own risk.*
