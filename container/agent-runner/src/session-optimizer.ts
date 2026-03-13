/**
 * Session Optimizer for NanoClaw agent-runner.
 *
 * Three features, all triggered by injecting hidden instructions into the next
 * normal reply rather than making standalone API calls:
 *
 *   1. Inline Compaction — when cumulative prompt+result content exceeds 80 KB,
 *      asks Claude to append a <compact_summary> block. The summary is extracted,
 *      saved as a seed file, and prepended to the first prompt of the next session.
 *      Extra cost: ~200-400 output tokens vs a full standalone /compact call.
 *
 *   2. Response length control — injects a conciseness constraint every 20 K input
 *      tokens and on drift (avg recent response > 2 000 chars). Self-adjusts a
 *      multiplier: eases off when the constraint is effective, tightens otherwise.
 *
 *   3. CLAUDE.md auto-compression — when CLAUDE.md exceeds 10 KB, asks Claude to
 *      append a <compressed_claude_md> block. Validates all headings are preserved
 *      before writing.
 */

import fs from 'fs';
import path from 'path';

// ─── Thresholds ──────────────────────────────────────────────────────────────

const COMPACT_BYTES_THRESHOLD = 80_000;      // 80 KB of raw prompt+result content
const LENGTH_INPUT_TOKEN_INTERVAL = 20_000;  // tokens between length-control injections
const LENGTH_DRIFT_CHARS = 2_000;            // avg result length that triggers drift check
const CLAUDEMD_SIZE_THRESHOLD = 10 * 1024;  // 10 KB

// ─── Tag literals ─────────────────────────────────────────────────────────────

const COMPACT_START = '<compact_summary>';
const COMPACT_END = '</compact_summary>';
const COMPRESSED_MD_START = '<compressed_claude_md>';
const COMPRESSED_MD_END = '</compressed_claude_md>';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.error(`[session-optimizer] ${msg}`);
}

/**
 * Extracts the last occurrence of startTag…endTag from text.
 * Returns the trimmed content and the text with the block removed, or null.
 */
function extractBetween(
  text: string,
  startTag: string,
  endTag: string,
): { content: string; remaining: string } | null {
  const si = text.lastIndexOf(startTag);
  if (si === -1) return null;
  const ei = text.indexOf(endTag, si);
  if (ei === -1) return null;
  const content = text.slice(si + startTag.length, ei).trim();
  const remaining = (text.slice(0, si) + text.slice(ei + endTag.length)).trim();
  return { content, remaining };
}

// ─── SessionOptimizer ─────────────────────────────────────────────────────────

export class SessionOptimizer {
  private readonly groupDir: string;

  // Byte-level content tracking (prompt chars + result chars)
  private cumulativeContentBytes = 0;

  // Token tracking from SDK usage data
  private cumulativeInputTokens = 0;
  private lastLengthTriggerAt = 0;

  // Response length drift tracking
  private recentResultChars: number[] = [];

  // Length-control self-optimising multiplier (1.0 = no constraint, 0.4 = tight)
  private lengthMultiplier = 1.0;

  // State flags
  private compactionPending = false;
  private compactionDone = false;
  private claudeMdPending = false;
  private claudeMdDone = false;

  constructor(groupDir: string) {
    this.groupDir = groupDir;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns the compact seed text to prepend to the first prompt of a new
   * session, or null if no seed exists yet.
   */
  getInitialContext(): string | null {
    const p = this.seedPath();
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch { /* non-fatal */ }
    return null;
  }

  /**
   * Called for every SDK message. Updates internal token/usage counters.
   */
  onMessage(message: unknown): void {
    const msg = message as Record<string, unknown>;

    // Extract token usage from result messages
    if (msg['type'] === 'result') {
      const usage = msg['usage'] as { input_tokens?: number } | undefined;
      if (usage?.input_tokens) {
        this.cumulativeInputTokens += usage.input_tokens;
      }
    }
  }

  /**
   * Accounts for prompt bytes sent to the SDK this turn.
   * Call this with the raw prompt string before pushing to the stream.
   */
  trackPromptBytes(prompt: string): void {
    this.cumulativeContentBytes += prompt.length;
  }

  /**
   * Appends hidden <system_note> instructions to prompt based on current state.
   * Call after trackPromptBytes so counters are up to date.
   */
  injectInstructions(prompt: string): string {
    const extras: string[] = [];

    // 1. Inline compaction
    if (
      !this.compactionDone &&
      !this.compactionPending &&
      this.cumulativeContentBytes >= COMPACT_BYTES_THRESHOLD
    ) {
      this.compactionPending = true;
      extras.push(
        `After your reply, append a ${COMPACT_START} block with a dense summary of this ` +
          `conversation's key facts, decisions, and ongoing context (≤500 words). ` +
          `Do not mention that you are including it. ` +
          `Format: ${COMPACT_START}…${COMPACT_END}`,
      );
      log(`Inline compaction triggered at ${this.cumulativeContentBytes} bytes`);
    }

    // 2. Response length control
    if (this.shouldControlLength()) {
      this.lastLengthTriggerAt = this.cumulativeInputTokens;
      const constraint = this.buildLengthConstraint();
      extras.push(constraint);
      log(`Length control injected (multiplier=${this.lengthMultiplier.toFixed(2)})`);
    }

    // 3. CLAUDE.md auto-compression
    if (!this.claudeMdDone && !this.claudeMdPending && this.isClaudeMdLarge()) {
      this.claudeMdPending = true;
      extras.push(
        `After your reply, append a ${COMPRESSED_MD_START} block with a compressed version ` +
          `of your CLAUDE.md. Remove redundant prose but preserve every directive, constraint, ` +
          `and section heading verbatim. ` +
          `Format: ${COMPRESSED_MD_START}…${COMPRESSED_MD_END}`,
      );
      log('CLAUDE.md compression triggered');
    }

    if (extras.length === 0) return prompt;

    return `${prompt}\n\n<system_note>${extras.join('\n\n')}</system_note>`;
  }

  /**
   * Strips hidden tags from a result, processes their content, and returns the
   * cleaned text to send to the user. Also call this to update drift tracking.
   */
  processResult(result: string): string {
    let text = result;

    // Extract compact_summary
    if (this.compactionPending) {
      const extracted = extractBetween(text, COMPACT_START, COMPACT_END);
      if (extracted) {
        this.saveCompactSeed(extracted.content);
        text = extracted.remaining;
        this.compactionDone = true;
        log('Compact seed extracted and saved');
      } else {
        log('compact_summary tag not found in result (model may have omitted it)');
      }
      this.compactionPending = false;
    }

    // Extract compressed_claude_md
    if (this.claudeMdPending) {
      const extracted = extractBetween(text, COMPRESSED_MD_START, COMPRESSED_MD_END);
      if (extracted) {
        this.applyClaudeMdCompression(extracted.content);
        text = extracted.remaining;
        this.claudeMdDone = true;
      } else {
        log('compressed_claude_md tag not found in result (model may have omitted it)');
        // Allow retry on next turn
        this.claudeMdPending = false;
      }
      this.claudeMdPending = false;
    }

    // Strip any leaked <system_note> blocks
    text = text.replace(/<system_note>[\s\S]*?<\/system_note>/g, '').trim();

    // Track result length and update the length-control multiplier
    const resultLen = text.length;
    this.cumulativeContentBytes += resultLen;
    this.recentResultChars.push(resultLen);
    if (this.recentResultChars.length > 5) this.recentResultChars.shift();
    this.updateMultiplier(resultLen);

    return text;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private shouldControlLength(): boolean {
    // Periodic trigger
    const tokensSinceLast = this.cumulativeInputTokens - this.lastLengthTriggerAt;
    const periodic =
      this.cumulativeInputTokens > 0 &&
      tokensSinceLast >= LENGTH_INPUT_TOKEN_INTERVAL;

    // Drift trigger: recent results are consistently long
    const drift = this.detectDrift();

    return periodic || drift;
  }

  private detectDrift(): boolean {
    if (this.recentResultChars.length < 3) return false;
    const avg = this.recentResultChars.slice(-3).reduce((a, b) => a + b, 0) / 3;
    return avg > LENGTH_DRIFT_CHARS;
  }

  private buildLengthConstraint(): string {
    if (this.lengthMultiplier >= 0.95) return 'Keep your response concise.';
    const pct = Math.round((1 - this.lengthMultiplier) * 100);
    return `Keep your response ${pct}% shorter than you otherwise would.`;
  }

  /**
   * Adjusts the multiplier based on whether the last constraint was effective.
   * Compares current result length against the rolling average of prior results.
   */
  private updateMultiplier(currentLen: number): void {
    if (this.recentResultChars.length < 2) return;
    const prior = this.recentResultChars.slice(0, -1);
    const prevAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
    if (currentLen < prevAvg * 0.85) {
      // Constraint effective — ease off
      this.lengthMultiplier = Math.min(1.0, this.lengthMultiplier + 0.15);
    } else {
      // Not effective — tighten
      this.lengthMultiplier = Math.max(0.4, this.lengthMultiplier - 0.1);
    }
  }

  private isClaudeMdLarge(): boolean {
    const p = path.join(this.groupDir, 'CLAUDE.md');
    try {
      return fs.existsSync(p) && fs.statSync(p).size > CLAUDEMD_SIZE_THRESHOLD;
    } catch {
      return false;
    }
  }

  private seedPath(): string {
    return path.join(this.groupDir, 'conversations', 'compact-seed.md');
  }

  private saveCompactSeed(summary: string): void {
    const p = this.seedPath();
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(
        p,
        `# Session Context\n\nGenerated: ${new Date().toISOString()}\n\n${summary}\n`,
      );
    } catch (err) {
      log(`Failed to save compact seed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private applyClaudeMdCompression(compressed: string): void {
    const p = path.join(this.groupDir, 'CLAUDE.md');
    try {
      const original = fs.readFileSync(p, 'utf-8');
      if (!this.validateCompression(original, compressed)) {
        log('CLAUDE.md compression failed validation — skipping write');
        return;
      }
      fs.writeFileSync(p, compressed);
      log(`Compressed CLAUDE.md: ${original.length} → ${compressed.length} chars`);
    } catch (err) {
      log(`Failed to apply CLAUDE.md compression: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Validates that compressed is smaller and all original headings are present.
   */
  private validateCompression(original: string, compressed: string): boolean {
    // Must actually reduce size
    if (compressed.length >= original.length * 0.95) return false;

    // Every heading line must survive verbatim
    const headings = original.split('\n').filter(l => /^#{1,6}\s/.test(l));
    return headings.every(h => compressed.includes(h));
  }
}
