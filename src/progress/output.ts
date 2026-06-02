import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Quality } from "../extract/classify.js";

export type OutputMeta = {
  milestone: string;
  ticketsScanned: number;
  generated: string;
  finished: boolean;
};

export type LeaderboardColumn = "username" | "count" | "quality" | "newContributor" | "country" | "memberSince";

export type LeaderboardRow = {
  username: string;
  count: number;
  quality?: Quality;
  newContributor?: boolean;
  country?: string | null;
  memberSince?: string;
};

type LeaderboardFile = {
  jsonName: string;
  csvName: string;
  rows: LeaderboardRow[];
  /** Columns to write, in order. Defaults to the original 4-column shape. */
  columns?: LeaderboardColumn[];
};

const DEFAULT_COLUMNS: LeaderboardColumn[] = ["username", "count", "newContributor", "country"];

function cellValue(col: LeaderboardColumn, r: LeaderboardRow): string | number | boolean | null | undefined {
  switch (col) {
    case "username": return r.username;
    case "count": return r.count;
    case "quality": return r.quality;
    case "newContributor": return r.newContributor;
    case "country": return r.country ?? null;
    case "memberSince": return r.memberSince;
  }
}

function csvCell(col: LeaderboardColumn, r: LeaderboardRow): string {
  const v = cellValue(col, r);
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return escapeCsv(v);
  return String(v);
}

export async function writeOutputs(
  milestoneDir: string,
  milestone: string,
  files: LeaderboardFile[],
  ticketsScanned: number,
  finished: boolean,
): Promise<void> {
  await mkdir(milestoneDir, { recursive: true });

  const meta: OutputMeta = {
    milestone,
    ticketsScanned,
    generated: new Date().toISOString(),
    finished,
  };

  for (const f of files) {
    const columns = f.columns ?? DEFAULT_COLUMNS;
    const sorted = [...f.rows].sort(
      (a, b) => b.count - a.count || a.username.localeCompare(b.username),
    );

    // JSON: only the requested columns per row
    const jsonRows = sorted.map((r) => {
      const obj: Record<string, unknown> = {};
      for (const col of columns) obj[col] = cellValue(col, r);
      return obj;
    });
    await writeFile(
      join(milestoneDir, f.jsonName),
      JSON.stringify({ meta, counts: jsonRows }, null, 2),
      "utf8",
    );

    // CSV: header + rows
    const csv =
      [columns.join(","), ...sorted.map((r) => columns.map((c) => csvCell(c, r)).join(","))].join("\n") + "\n";
    await writeFile(join(milestoneDir, f.csvName), csv, "utf8");
  }
}

function escapeCsv(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
