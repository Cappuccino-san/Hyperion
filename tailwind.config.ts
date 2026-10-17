import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        argon: {
          bg: "#0b0d17",
          panel: "#111422",
          primary: "#5e72e4",
          info: "#11cdef",
          success: "#2dce89",
          danger: "#f5365c",
          warning: "#fb6340",
          text: "#ced4da",
          muted: "#8898aa",
        },
      },
      boxShadow: {
        argon: "0 0 2rem 0 rgba(0, 0, 0, 0.45)",
        "argon-glow": "0 0 15px rgba(94, 114, 228, 0.55)",
        "argon-info-glow": "0 0 12px rgba(17, 205, 239, 0.5)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
