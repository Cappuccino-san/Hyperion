"use client";

import React, { useEffect } from "react";
import { TopNavBar } from "@/components/header/TopNavBar";
import { ScannerView } from "@/components/views/ScannerView";
import { AppFooter } from "@/components/layout/AppFooter";
import { useDashboardStore } from "@/store/useDashboardStore";

export default function ScannerPage() {
  const setActiveView = useDashboardStore((state) => state.setActiveView);

  useEffect(() => {
    setActiveView("Scanner");
  }, [setActiveView]);

  return (
    <div className="min-h-screen bg-[#0b0d17] text-slate-100 flex flex-col">
      <TopNavBar />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4">
        <ScannerView />
      </main>
      <AppFooter />
    </div>
  );
}
