import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { logger } from "../lib/logger.js";

const BLACKLIST_PATH = resolve(process.cwd(), "permanent_blacklist.json");

function loadBlacklist(): Set<string> {
  try {
    if (!existsSync(BLACKLIST_PATH)) {
      writeFileSync(BLACKLIST_PATH, "[]", "utf-8");
      return new Set();
    }
    const raw = readFileSync(BLACKLIST_PATH, "utf-8");
    const arr: string[] = JSON.parse(raw);
    return new Set(arr);
  } catch (err) {
    logger.error({ err, path: BLACKLIST_PATH }, "Blacklist: failed to load — starting with empty set");
    return new Set();
  }
}

function saveBlacklist(set: Set<string>): void {
  try {
    writeFileSync(BLACKLIST_PATH, JSON.stringify(Array.from(set), null, 2), "utf-8");
  } catch (err) {
    logger.error({ err, path: BLACKLIST_PATH }, "Blacklist: failed to save");
  }
}

class BlacklistService {
  private blacklist: Set<string> = loadBlacklist();

  isBlacklisted(contractAddress: string): boolean {
    return this.blacklist.has(contractAddress);
  }

  add(contractAddress: string): void {
    if (this.blacklist.has(contractAddress)) return;
    this.blacklist.add(contractAddress);
    saveBlacklist(this.blacklist);
    logger.info({ contractAddress, total: this.blacklist.size }, "Blacklist: CA permanently blacklisted");
  }

  size(): number {
    return this.blacklist.size;
  }
}

export const blacklistService = new BlacklistService();
