export type PlaybookExecutionStatus =
  | "PENDING"
  | "TRIGGERED"
  | "T1 HIT"
  | "T2 HIT"
  | "STOPPED";

export interface PlaybookPick {
  id: string;
  ticker: string;
  type: "CALL" | "PUT";
  priorClose: number;
  entryTrigger: string;       // e.g. "Break above 56.70" or "Break below 701.85"
  stopLoss: string;           // e.g. "Back below 56.59" or "Back above 704.38"
  entryTriggerPrice: number;  // Numeric entry trigger
  stopLossPrice: number;      // Numeric stop loss
  target1: number;
  target2: number;            // Expected Move boundary (D↑ / D↓ edge)
  gexKing?: number | string;  // Active strike or "n/a"
  vexKing?: number | string;  // Active strike or "n/a"
  expectedMove: {
    value: number;            // e.g. 0.45
    low: number;              // e.g. 56.20
    high: number;             // e.g. 57.10
  };
  why: string;                // Tactical thesis (e.g., "Scanner top bull pick. Sitting 5¢ under trigger...")
  status?: PlaybookExecutionStatus;
  currentSpot?: number;
  score?: number;             // Quantitative conviction score
}

export interface PlaybookPayload {
  sessionTitle: string;       // e.g. "HYPERION 0DTE SCAN — TODAY"
  subtitle: string;           // "Top 3 calls + top 3 puts · Calls trigger on a break above · Puts on a break below"
  picks: PlaybookPick[];
  topCalls?: PlaybookPick[];
  topPuts?: PlaybookPick[];
  rules: string;              // "How to play it: wait for the trigger in the first 15–30 min..."
  updatedAt?: string;
}
