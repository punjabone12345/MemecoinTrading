import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatSol(amount: number | undefined | null): string {
  if (amount == null) return "0.0000";
  return amount.toFixed(4);
}

export function formatUsd(amount: number | undefined | null): string {
  if (amount == null) return "$0.00";
  if (amount < 0.001) {
    return "$" + amount.toFixed(8);
  }
  if (amount >= 1_000_000_000) {
    return "$" + (amount / 1_000_000_000).toFixed(2) + "B";
  }
  if (amount >= 1_000_000) {
    return "$" + (amount / 1_000_000).toFixed(2) + "M";
  }
  if (amount >= 1_000) {
    return "$" + (amount / 1_000).toFixed(2) + "k";
  }
  return "$" + amount.toFixed(2);
}

export function formatPercent(amount: number | undefined | null): string {
  if (amount == null) return "0.00%";
  const prefix = amount > 0 ? "+" : "";
  return prefix + amount.toFixed(2) + "%";
}

export function getScoreColor(score: number): string {
  if (score >= 80) return "text-primary border-primary bg-primary/10";
  if (score >= 60) return "text-yellow-500 border-yellow-500 bg-yellow-500/10";
  return "text-destructive border-destructive bg-destructive/10";
}
