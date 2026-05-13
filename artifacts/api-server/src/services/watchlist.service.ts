import type { WatchlistEntry } from "../types/index.js";

class WatchlistService {
  private entries: Map<string, WatchlistEntry> = new Map();

  add(pairAddress: string, note?: string): WatchlistEntry {
    const existing = this.entries.get(pairAddress);
    if (existing) return existing;
    const entry: WatchlistEntry = { pairAddress, addedAt: Date.now(), note };
    this.entries.set(pairAddress, entry);
    return entry;
  }

  remove(pairAddress: string): boolean {
    return this.entries.delete(pairAddress);
  }

  has(pairAddress: string): boolean {
    return this.entries.has(pairAddress);
  }

  getAll(): WatchlistEntry[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => b.addedAt - a.addedAt,
    );
  }

  updateNote(pairAddress: string, note: string): boolean {
    const entry = this.entries.get(pairAddress);
    if (!entry) return false;
    entry.note = note;
    return true;
  }
}

export const watchlistService = new WatchlistService();
