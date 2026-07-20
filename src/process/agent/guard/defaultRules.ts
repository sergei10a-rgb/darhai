/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The built-in ruleset - ECC's highest-value guards ported as native regex
 * rules. Three tiers, chosen so a guard bug can never brick the agent:
 *
 *   1. DESTRUCTIVE_FLOOR (deny) - a small, deterministic set of obviously
 *      catastrophic shell commands (root/home recursive delete, fork bomb,
 *      mkfs, dd/redirect to a raw disk device, DROP TABLE/DATABASE). Always
 *      evaluated, even when the config ruleset is empty. Patterns are written
 *      to avoid false positives on ordinary deletions (`rm -rf ./build`,
 *      `dd of=/dev/null`, `> /dev/null` all pass).
 *   2. RISKY (warn, never deny) - recoverable-but-dangerous git operations
 *      (force push, hard reset). Surfaced, never blocked.
 *   3. SECRET_WRITE (warn, never deny) - write/edit content that looks like a
 *      leaked credential (OpenAI-style key, AWS access-key id, PEM private
 *      key). Warn only: a false positive must never block a legitimate write.
 *
 * All patterns are compiled case-insensitively by HookGuardService, so the
 * flag classes below are for clarity only.
 */

import type { GuardRule } from './types';

// A whole-disk / catastrophic filesystem target for a recursive-force `rm`.
// Deliberately narrow: bare root, root glob, bare home, $HOME, or an explicit
// `--no-preserve-root`. `rm -rf ~/project` and `rm -rf ./build` do NOT match.
const CATASTROPHIC_RM_TARGET = String.raw`(?:\/(?:\s|$)|\/\*|~(?:\s|$)|\$HOME(?:\s|$)|\$\{HOME\}|--no-preserve-root)`;

// `rm` that carries BOTH a recursive flag (r/R) and a force flag (f/F) in any
// flag arrangement (`-rf`, `-fr`, `-r -f`, `-Rf`, `--recursive --force`, ...),
// then targets a catastrophic path. Two lookaheads assert the flags exist; the
// consuming tail walks flag tokens to reach the target.
const RM_CATASTROPHIC = String.raw`\brm\b(?=(?:\s+-\S+)*\s+-\S*[rR])(?=(?:\s+-\S+)*\s+-\S*[fF])(?:\s+-\S+)*\s+${CATASTROPHIC_RM_TARGET}`;

// Raw block-device prefixes under /dev that indicate a whole disk (never
// /dev/null, /dev/zero, /dev/random - those are safe sinks/sources).
const RAW_DISK_DEVICE = String.raw`\/dev\/(?:sd|nvme|hd|vd|xvd|mmcblk|disk)`;

/**
 * Tier 1 - the hardcoded destructive DENY floor. Always merged in by
 * HookGuardService regardless of config. Command-string matches only.
 */
export const DESTRUCTIVE_FLOOR_RULES: readonly GuardRule[] = [
  {
    id: 'destructive-rm-root',
    event: 'pre',
    action: 'deny',
    commandPattern: RM_CATASTROPHIC,
    message: 'Илт хор хөнөөлтэй устгах команд (rm -rf үндэс/гэр хавтас) — Дархайн хамгаалалт хориглов.',
  },
  {
    id: 'destructive-fork-bomb',
    event: 'pre',
    action: 'deny',
    commandPattern: String.raw`:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`,
    message: 'Fork bomb илэрлээ — Дархайн хамгаалалт хориглов.',
  },
  {
    id: 'destructive-mkfs',
    event: 'pre',
    action: 'deny',
    commandPattern: String.raw`\bmkfs(?:\.[a-z0-9]+)?\b`,
    message: 'Файлын систем форматлах (mkfs) команд — Дархайн хамгаалалт хориглов.',
  },
  {
    id: 'destructive-dd-device',
    event: 'pre',
    action: 'deny',
    commandPattern: String.raw`\bdd\b[^\n]*\bof=["']?` + RAW_DISK_DEVICE,
    message: 'Дискний төхөөрөмж рүү шууд бичих (dd of=/dev/…) — Дархайн хамгаалалт хориглов.',
  },
  {
    id: 'destructive-redirect-device',
    event: 'pre',
    action: 'deny',
    commandPattern: String.raw`>\s*` + RAW_DISK_DEVICE,
    message: 'Дискний төхөөрөмж рүү дахин чиглүүлэх (> /dev/sd…) — Дархайн хамгаалалт хориглов.',
  },
  {
    id: 'destructive-drop-database',
    event: 'pre',
    action: 'deny',
    commandPattern: String.raw`\bDROP\s+(?:TABLE|DATABASE)\b`,
    message: 'Өгөгдлийн сан/хүснэгт устгах (DROP TABLE/DATABASE) — Дархайн хамгаалалт хориглов.',
  },
];

/**
 * Tier 2 - risky-but-recoverable git operations. WARN only, never deny.
 */
export const RISKY_RULES: readonly GuardRule[] = [
  {
    id: 'risky-git-force-push',
    event: 'pre',
    action: 'warn',
    commandPattern: String.raw`\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b)`,
    message: 'Анхаар: git push --force түүхийг дарж бичнэ.',
  },
  {
    id: 'risky-git-reset-hard',
    event: 'pre',
    action: 'warn',
    commandPattern: String.raw`\bgit\s+reset\b[^\n]*--hard\b`,
    message: 'Анхаар: git reset --hard хадгалагдаагүй өөрчлөлтийг устгана.',
  },
];

/**
 * Tier 3 - probable secret in write/edit content. WARN only, never deny, so a
 * false positive can never block a legitimate write.
 */
export const SECRET_WRITE_RULES: readonly GuardRule[] = [
  {
    id: 'secret-openai-key',
    event: 'pre',
    action: 'warn',
    contentPattern: String.raw`sk-[A-Za-z0-9]{20,}`,
    message: 'Анхаар: бичих агуулга API түлхүүр (sk-…) агуулж болзошгүй.',
  },
  {
    id: 'secret-aws-access-key',
    event: 'pre',
    action: 'warn',
    contentPattern: String.raw`\bAKIA[0-9A-Z]{16}\b`,
    message: 'Анхаар: бичих агуулга AWS access-key id (AKIA…) агуулж болзошгүй.',
  },
  {
    id: 'secret-private-key',
    event: 'pre',
    action: 'warn',
    contentPattern: String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`,
    message: 'Анхаар: бичих агуулга PEM хувийн түлхүүр агуулж болзошгүй.',
  },
];

/**
 * The complete built-in ruleset (floor + risky + secret). HookGuardService
 * always evaluates these; a config-provided ruleset is additive on top.
 */
export const DEFAULT_RULES: readonly GuardRule[] = [...DESTRUCTIVE_FLOOR_RULES, ...RISKY_RULES, ...SECRET_WRITE_RULES];
