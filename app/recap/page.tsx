"use client";

import React, { useEffect } from "react";
import { TopNavBar } from "@/components/header/TopNavBar";
import { RecapView } from "@/components/views/RecapView";
import { AppFooter } from "@/components/layout/AppFooter";
import { useDashboardStore } from "@/store/useDashboardStore";

export default function RecapPage() {
  const setActiveView = useDashboardStore((state) => state.setActiveView);

  useEffect(() => {
    setActiveView("Recap");
  }, [setActiveView]);

  return (
    <div className="min-h-screen bg-[#0b0d17] text-slate-100 flex flex-col">
      <TopNavBar />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4">
        <RecapView />
      </main>
      <AppFooter />
    </div>
  );
}
