/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ArrowRight,
  Building2,
  Check,
  Info,
  KeyRound,
  Landmark,
  Loader2,
  PenLine,
  Search,
  Sparkles,
  Terminal,
  TrendingUp,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { ConfigStorage } from '@/common/config/storage';
import type { DetectionResult } from '@/common/types/onboarding';
import type { ProviderId } from '@process/providers/types';
import wordmark from '@renderer/assets/logos/darhai-wordmark-white.png';
import anthropicLogo from '@renderer/assets/logos/anthropic.svg';
import claudeLogo from '@renderer/assets/logos/claude.svg';
import codexLogo from '@renderer/assets/logos/codex.svg';
import cursorLogo from '@renderer/assets/logos/cursor.png';
import geminiLogo from '@renderer/assets/logos/gemini.svg';
import groqLogo from '@renderer/assets/logos/groq.svg';
import ollamaLogo from '@renderer/assets/logos/ollama.svg';
import openaiLogo from '@renderer/assets/logos/openai.svg';
import openrouterLogo from '@renderer/assets/logos/openrouter.svg';
import { resolveFocusSelection, type FocusPersonaId } from './focusMap';
import { providerLabel } from './providerLabel';
import styles from './Onboarding.module.css';

type OnboardingFlowProps = {
  detection: DetectionResult;
  /** Onboarding is complete - close the overlay and drop the user into the app. */
  onFinish: () => void;
};

type Screen = 'quickstart' | 'scan' | 'outcome' | 'interests' | 'allset';

/** Provider id → real brand logo (rendered on a white tile). */
const PROVIDER_LOGO: Record<string, string> = {
  openai: openaiLogo,
  anthropic: anthropicLogo,
  'google-gemini': geminiLogo,
  groq: groqLogo,
  openrouter: openrouterLogo,
  ollama: ollamaLogo,
};
/** Detected CLI id → brand logo. */
const CLI_LOGO: Record<string, string> = {
  claude: claudeLogo,
  codex: codexLogo,
  cursor: cursorLogo,
};

type Persona = { id: FocusPersonaId; labelKey: string; accent: string; Icon: LucideIcon };
const PERSONAS: Persona[] = [
  { id: 'content', labelKey: 'onboarding.flow.personas.content', accent: '139,92,246', Icon: PenLine },
  { id: 'sales', labelKey: 'onboarding.flow.personas.sales', accent: '16,185,129', Icon: TrendingUp },
  { id: 'business', labelKey: 'onboarding.flow.personas.business', accent: '244,114,182', Icon: Building2 },
  { id: 'dev', labelKey: 'onboarding.flow.personas.dev', accent: '99,102,241', Icon: Wrench },
  { id: 'finance', labelKey: 'onboarding.flow.personas.finance', accent: '245,158,11', Icon: Landmark },
  { id: 'general', labelKey: 'onboarding.flow.personas.general', accent: '56,189,248', Icon: Sparkles },
];

// Scan animation lines - keyed so the narration is localized. The order here is
// the on-screen sequence; `scanLog` indexes into this array.
const SCAN_LINE_KEYS = [
  'onboarding.flow.scanLines.path',
  'onboarding.flow.scanLines.env',
  'onboarding.flow.scanLines.models',
  'onboarding.flow.scanLines.almost',
];

/** "a, b and c". */
const joinList = (arr: string[]): string =>
  arr.length <= 1 ? (arr[0] ?? '') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;

const accentStyle = (accent: string): React.CSSProperties =>
  ({ ['--accent' as string]: accent }) as React.CSSProperties;

/** Inline Google "G" mark for the "Continue with Google" hero. Brand colors are intentional literals. */
const GoogleMark: React.FC = () => (
  <svg viewBox='0 0 24 24' width={22} height={22} aria-hidden focusable='false'>
    <path fill='#4285F4' d='M22.5 12.2c0-.7-.1-1.4-.2-2H12v4h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2-1.9 3.3-4.7 3.3-8Z' />
    <path
      fill='#34A853'
      d='M12 23c3 0 5.5-1 7.3-2.7l-3.5-2.7c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2v2.8A11 11 0 0 0 12 23Z'
    />
    <path fill='#FBBC05' d='M5.7 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2a11 11 0 0 0 0 9.8l3.7-2.8Z' />
    <path fill='#EA4335' d='M12 5.4c1.6 0 3 .6 4.2 1.6l3.1-3.1A11 11 0 0 0 2 7.1l3.7 2.8C6.6 7.3 9.1 5.4 12 5.4Z' />
  </svg>
);

/**
 * First-run onboarding. Google-first quick start (the universal floor: even a
 * single click wires Google + Gemini + Wayland Core and tells us their name),
 * then a narrated local scan that auto-wires detected keys, an adaptive outcome
 * (loaded / ready / pick-a-model), a focus pick that seeds the launchpad, and a
 * one-line "you're all set". Matches the approved walkable simulation.
 */
const OnboardingFlow: React.FC<OnboardingFlowProps> = ({ detection, onFinish }) => {
  const { t } = useTranslation();
  const [screen, setScreen] = useState<Screen>('quickstart');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [scanDone, setScanDone] = useState(false);
  const [scanLog, setScanLog] = useState(0);
  const [picks, setPicks] = useState<FocusPersonaId[]>([]);
  const [work, setWork] = useState('');
  const [coldKey, setColdKey] = useState('');
  // Providers connected via the paste field this session - appended to the
  // reveal so a freshly-added key visibly lands "in the pool".
  const [addedProviders, setAddedProviders] = useState<string[]>([]);
  // Detected keys that ACTUALLY connected during the scan auto-wire (and the
  // ones that failed). Detection is a claim; connection is the truth. The
  // "wired and tested" outcome is driven by these, never by the detected list.
  const [wiredProviders, setWiredProviders] = useState<string[]>([]);
  const [wireFailed, setWireFailed] = useState<string[]>([]);
  // Dedicated error for the "Continue with Google" hero, shown inline under the
  // door so it never collides with the paste-field's own status line.
  const [googleErr, setGoogleErr] = useState<string | null>(null);

  // Detection-derived shape (the warm/cold fork is decided by the real machine).
  const hasKeys = detection.envKeys.length > 0;
  const hasOllama = detection.ollama.running && detection.ollama.models.length > 0;
  const warm = hasKeys || hasOllama;
  // Installed execution engines beyond the always-present bundled ones (Wayland
  // Core, Gemini CLI) - a detected Claude Code / Qwen / Kimi / OpenClaw / … means
  // the user can chat now, so it counts toward the ready (cli-only) fork.
  const discoveredAgents = detection.agents.filter((a) => a.kind !== 'wcore' && a.kind !== 'gemini');
  const cliOnly = !warm && (discoveredAgents.length > 0 || detection.clis.length > 0 || detection.claudePro);
  const trueCold = !warm && !cliOnly;

  // Narrated scan + fail-safe auto-wire of detected keys, on entering the scan.
  //
  // The auto-wire is SETTLED, not fire-and-forget: we record which keys actually
  // connected so the outcome can only claim "wired and tested" for those. The
  // scan completes when BOTH a minimum narration beat AND the wiring have
  // resolved - so it can never declare ready before the connects finish (the old
  // fixed 1750ms timer could fire mid-connect and present a false green).
  useEffect(() => {
    if (screen !== 'scan') return;
    setScanDone(false);
    setScanLog(0);
    let cancelled = false;

    const logTimer = setInterval(() => setScanLog((i) => Math.min(i + 1, SCAN_LINE_KEYS.length - 1)), 430);

    const minBeat = new Promise<void>((resolve) => setTimeout(resolve, 1750));
    const wiring = Promise.all(
      detection.envKeys.map((pid) =>
        ipcBridge.modelRegistry.connect
          .invoke({ providerId: pid as ProviderId, creds: { useDiscovered: true } })
          .then((res) => ({ pid, ok: res.ok === true }))
          .catch(() => ({ pid, ok: false }))
      )
    );

    void Promise.all([minBeat, wiring]).then(([, results]) => {
      if (cancelled) return;
      clearInterval(logTimer);
      setWiredProviders(results.filter((r) => r.ok).map((r) => r.pid));
      setWireFailed(results.filter((r) => !r.ok).map((r) => r.pid));
      setScanDone(true);
    });

    return () => {
      cancelled = true;
      clearInterval(logTimer);
    };
  }, [screen, detection.envKeys]);

  /**
   * Connect a pasted key. The provider is auto-detected in the main process via
   * the real `ProviderDetector` + `SkRaceResolver`, so a bare `sk-` key shared
   * by OpenAI/DeepSeek/Moonshot/Qwen is probed live and connected to its true
   * owner (not blindly assumed to be OpenAI). Returns whether it stuck.
   */
  const connectKey = useCallback(
    async (raw: string): Promise<boolean> => {
      // API keys never contain whitespace - strip everything so a stray newline or
      // leading space from a paste never trips the connect.
      const key = raw.replace(/\s+/g, '');
      if (!key) {
        setErrorMsg(t('onboarding.flow.key.notRecognized'));
        return false;
      }
      setBusy('key');
      setErrorMsg(null);
      setSuccessMsg(null);
      const res = await ipcBridge.onboarding.connectPastedKey
        .invoke({ key })
        .catch(() => ({ ok: false as const, error: 'failed' as const }));
      setBusy(null);
      if (res.ok) {
        setSuccessMsg(t('onboarding.flow.key.detected', { label: providerLabel(res.providerId) }));
        setAddedProviders((prev) => (prev.includes(res.providerId) ? prev : [...prev, res.providerId]));
        return true;
      }
      setErrorMsg(
        'error' in res && res.error === 'needs-fields'
          ? t('onboarding.flow.key.needsFields')
          : t('onboarding.flow.key.didNotConnect')
      );
      return false;
    },
    [t]
  );

  /**
   * The zero-AI floor: one click signs the user in with Google and registers the
   * free Gemini (Google-auth) provider, so a fresh machine with no keys/CLIs/models
   * is operational immediately. Reuses the existing `googleAuth.login` OAuth flow
   * and the `google-gemini` + `{ useGoogleAuth: true }` registry connect (same
   * wiring the Settings → Models "Continue with Google" button uses). On success
   * we adopt the account's first name (if the user skipped naming) and advance to
   * the focus pick - the same proceed path the other doors take.
   */
  const connectGoogle = useCallback(async () => {
    setBusy('google');
    setGoogleErr(null);
    try {
      const res = await ipcBridge.googleAuth.login.invoke({});
      if (!res.success) {
        setGoogleErr(t('onboarding.flow.errors.googleFailed'));
        return;
      }
      const connected = await ipcBridge.modelRegistry.connect
        .invoke({ providerId: 'google-gemini', creds: { useGoogleAuth: true } })
        .then((r) => r.ok === true)
        .catch(() => false);
      if (!connected) {
        setGoogleErr(t('onboarding.flow.errors.geminiFailed'));
        return;
      }
      // Greet the user by name (doorGoogleBody's promise) when they skipped the
      // name field - the OAuth profile already knows it.
      const first = res.data?.firstName?.trim();
      if (first && !name.trim()) {
        setName(first);
        void ConfigStorage.set('user.displayName', first);
      }
      setScreen('interests');
    } catch {
      setGoogleErr(t('onboarding.flow.errors.googleFailed'));
    } finally {
      setBusy(null);
    }
  }, [name, t]);

  const togglePick = useCallback((id: FocusPersonaId) => {
    setPicks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const finishInterests = useCallback(async () => {
    const w = work.trim();
    let focus: FocusPersonaId[] = [...picks];
    if (w) {
      void ConfigStorage.set('onboarding.workDescription', w);
      // Extract intent from the free text (cheap fast model, e.g. Gemini Flash,
      // with a keyword fallback) and merge it with any cards the user tapped.
      setBusy('infer');
      const inferred = await ipcBridge.onboarding.inferFocus.invoke({ work: w }).catch(() => [] as string[]);
      setBusy(null);
      const valid = new Set<string>(PERSONAS.map((p) => p.id));
      const add = inferred.filter((id): id is FocusPersonaId => valid.has(id));
      focus = [...new Set([...focus, ...add])];
    }
    if (focus.length > 0) {
      const { launchpadIds } = resolveFocusSelection(focus);
      void ConfigStorage.set('launchpad.barOrder', launchpadIds);
      void ConfigStorage.set('onboarding.focusArea', focus);
    }
    setScreen('allset');
  }, [picks, work]);

  const finishAll = useCallback(() => {
    const n = name.trim();
    if (n) void ConfigStorage.set('user.displayName', n);
    onFinish();
  }, [name, onFinish]);

  const wiredLabel = useMemo(() => {
    const list = [...wiredProviders.map((p) => providerLabel(p)), ...(hasOllama ? ['Ollama'] : [])];
    return joinList(list);
  }, [wiredProviders, hasOllama]);

  // A soft note for keys that were detected but failed to verify - shown in the
  // outcome so a partial failure is honest, not hidden.
  const failedLabel = useMemo(() => joinList(wireFailed.map((p) => providerLabel(p))), [wireFailed]);

  // The outcome may claim "wired up" only when something genuinely connected -
  // a real provider or Ollama. Detected-but-unverified keys do NOT count, so an
  // all-failed auto-wire falls through to an honest recovery branch instead of a
  // false "you're all wired up".
  const wiredWarm = wiredProviders.length > 0 || hasOllama;

  const hi = (base: string) => (name ? `${name}, ${base}` : base.charAt(0).toUpperCase() + base.slice(1));

  // --- reveal chips (agents / models) ---
  const agentChips = useMemo(() => {
    // Map a registry agent to a brand logo where we have one; everything else
    // falls back to the generic terminal tile in renderChip.
    const logoFor = (name: string): string | undefined => {
      const n = name.toLowerCase();
      if (n.includes('claude')) return claudeLogo;
      if (n.includes('codex')) return codexLogo;
      if (n.includes('gemini')) return geminiLogo;
      if (n.includes('cursor')) return cursorLogo;
      return undefined;
    };
    const out: { key: string; label: string; logo?: string }[] = [];
    // Primary source: the app's unified AgentRegistry (finds every backend).
    for (const a of detection.agents) out.push({ key: `agent-${a.id}`, label: a.name, logo: logoFor(a.name) });
    // Defensive fallback to the raw CLI probe if the registry returned nothing.
    if (out.length === 0)
      for (const cli of detection.clis) out.push({ key: `cli-${cli}`, label: providerLabel(cli), logo: CLI_LOGO[cli] });
    // Surface a Claude Pro subscription even when no `claude` engine is listed.
    if (
      detection.claudePro &&
      !detection.agents.some((a) => /claude/i.test(a.name)) &&
      !detection.clis.includes('claude')
    )
      out.push({ key: 'claude-pro', label: t('onboarding.flow.chips.claudePro'), logo: claudeLogo });
    return out;
  }, [detection.agents, detection.clis, detection.claudePro, t]);
  const modelChips = useMemo(() => {
    const out: { key: string; label: string; logo?: string }[] = [];
    const seen = new Set<string>();
    for (const k of wiredProviders) {
      out.push({
        key: `env-${k}`,
        label: t('onboarding.flow.chips.envKey', { label: providerLabel(k) }),
        logo: PROVIDER_LOGO[k],
      });
      seen.add(k);
    }
    // Keys the user pasted in this session that weren't already detected.
    for (const p of addedProviders) {
      if (seen.has(p)) continue;
      out.push({
        key: `added-${p}`,
        label: t('onboarding.flow.chips.envKey', { label: providerLabel(p) }),
        logo: PROVIDER_LOGO[p],
      });
      seen.add(p);
    }
    if (hasOllama)
      out.push({
        key: 'ollama',
        label: t('onboarding.flow.chips.ollama', { count: detection.ollama.models.length }),
        logo: ollamaLogo,
      });
    return out;
  }, [wiredProviders, detection.ollama.models.length, hasOllama, addedProviders, t]);

  const Header: React.FC<{ step: 0 | 1 | 2 }> = ({ step }) => (
    <div className={styles.top}>
      <img className={styles.wordmark} src={wordmark} alt={t('onboarding.flow.logoAlt.wordmark')} />
      <div className={styles.dots}>
        {[0, 1, 2].map((i) => (
          <span key={i} className={`${styles.dot} ${i === step ? styles.dotOn : i < step ? styles.dotDone : ''}`} />
        ))}
      </div>
    </div>
  );

  const renderChip = (c: { key: string; label: string; logo?: string }) => (
    <span key={c.key} className={styles.chip}>
      <span className={styles.tile}>
        {c.logo ? <img src={c.logo} alt='' /> : <Terminal size={18} color='#1a1a1a' />}
      </span>
      <span className={styles.chipName}>{c.label}</span>
      <span className={styles.ok}>
        <Check size={15} strokeWidth={2.6} />
      </span>
    </span>
  );

  const keyField = (onSubmit: (v: string) => void, value: string, setValue: (v: string) => void) => {
    const clean = value.replace(/\s+/g, '');
    const submit = () => {
      if (clean && busy !== 'key') void onSubmit(clean);
    };
    return (
      <div className={styles.keyfield}>
        <span className={styles.kfIc}>
          {busy === 'key' ? <Loader2 size={18} className={styles.spinDark} /> : <KeyRound size={18} />}
        </span>
        <input
          type='password'
          autoComplete='off'
          spellCheck={false}
          value={value}
          placeholder={t('onboarding.flow.key.placeholder')}
          // Strip whitespace as it arrives so a pasted key with a trailing
          // newline or stray spaces is always clean.
          onChange={(e) => {
            setValue(e.target.value.replace(/\s+/g, ''));
            if (errorMsg) setErrorMsg(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          disabled={busy === 'key'}
        />
        <button
          type='button'
          className={styles.kfBtn}
          onClick={submit}
          disabled={!clean || busy === 'key'}
          aria-label={t('onboarding.flow.key.ariaConnect')}
        >
          {busy === 'key' ? <Loader2 size={16} className={styles.spinDark} /> : <ArrowRight size={16} />}
        </button>
      </div>
    );
  };

  /** Inline result line under the paste field: green success or red error. */
  const keyStatus = () =>
    successMsg ? (
      <p className={styles.keyOk}>
        <Check size={15} strokeWidth={2.8} /> {successMsg}
      </p>
    ) : errorMsg ? (
      <p className={styles.keyErr}>{errorMsg}</p>
    ) : null;

  // ---------------- screens ----------------

  if (screen === 'quickstart') {
    const goScan = () => {
      const n = name.trim();
      if (n) void ConfigStorage.set('user.displayName', n);
      setScreen('scan');
    };
    return (
      <div className={styles.shell}>
        <Header step={0} />
        <h1 className={styles.headline}>
          {t('onboarding.flow.quickstart.headline')}
          <span className={styles.pt}>?</span>
        </h1>
        <p className={styles.sub}>{t('onboarding.flow.quickstart.sub')}</p>
        <div
          className={styles.grow}
          style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 16, maxWidth: 460 }}
        >
          <input
            className={styles.bigfield}
            value={name}
            autoFocus
            placeholder={t('onboarding.flow.quickstart.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') goScan();
            }}
          />
        </div>
        <div className={styles.actions}>
          <span className={styles.ghost}>{t('onboarding.flow.quickstart.changeLater')}</span>
          <button type='button' className={styles.btn} onClick={goScan}>
            {t('onboarding.flow.quickstart.continue')} <ArrowRight size={15} />
          </button>
        </div>
      </div>
    );
  }

  if (screen === 'scan') {
    const noFindings = agentChips.length === 0 && modelChips.length === 0;
    return (
      <div className={styles.shell}>
        <Header step={1} />
        <h1 className={styles.headline}>
          {scanDone
            ? noFindings
              ? t('onboarding.flow.scan.headlineCleanSlate')
              : name
                ? t('onboarding.flow.scan.headlineFoundNamed', { name })
                : t('onboarding.flow.scan.headlineFound')
            : name
              ? t('onboarding.flow.scan.headlineScanningNamed', { name })
              : t('onboarding.flow.scan.headlineScanning')}
          <span className={styles.pt}>{scanDone ? '.' : '…'}</span>
        </h1>
        <p className={styles.sub}>
          {scanDone
            ? noFindings
              ? t('onboarding.flow.scan.subCleanSlate')
              : t('onboarding.flow.scan.subFound')
            : t('onboarding.flow.scan.subScanning')}
        </p>

        {!scanDone && (
          <div className={styles.scanwrap}>
            <div className={styles.radar}>
              <span className={styles.radarCore}>
                <Search size={26} />
              </span>
            </div>
            <div className={styles.scanlog}>{t(SCAN_LINE_KEYS[scanLog])}</div>
          </div>
        )}

        {scanDone && !noFindings && (
          <div className={`${styles.block} ${styles.twocol}`}>
            {agentChips.length > 0 && (
              <div className={styles.col}>
                <p className={styles.groupLabel}>{t('onboarding.flow.scan.groupAgents')}</p>
                <div className={styles.chips}>{agentChips.map(renderChip)}</div>
              </div>
            )}
            {modelChips.length > 0 && (
              <div className={styles.col}>
                <p className={styles.groupLabel}>{t('onboarding.flow.scan.groupModels')}</p>
                <div className={styles.chips}>{modelChips.map(renderChip)}</div>
              </div>
            )}
          </div>
        )}

        {scanDone && (
          <>
            <div className={styles.grow} />
            <div className={styles.actions}>
              <span className={styles.ghost}>{t('onboarding.flow.scan.timeNote')}</span>
              <button type='button' className={styles.btn} onClick={() => setScreen('outcome')}>
                {t('onboarding.flow.scan.continue')} <ArrowRight size={15} />
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (screen === 'outcome') {
    return (
      <div className={styles.shell}>
        <Header step={1} />
        {wiredWarm ? (
          <>
            <h1 className={styles.headline}>
              {hi(t('onboarding.flow.outcome.wiredHeadline'))}
              <span className={styles.pt}>.</span>
            </h1>
            <p className={styles.sub}>
              {wiredLabel ? t('onboarding.flow.outcome.wired', { label: wiredLabel }) : ''}
              {t('onboarding.flow.outcome.wiredSubTail')}
            </p>
            {wireFailed.length > 0 && (
              <p className={styles.sub}>
                {t('onboarding.flow.outcome.failedNote', {
                  label: failedLabel,
                  was:
                    wireFailed.length === 1
                      ? t('onboarding.flow.outcome.failedWas')
                      : t('onboarding.flow.outcome.failedWere'),
                  them:
                    wireFailed.length === 1
                      ? t('onboarding.flow.outcome.failedIt')
                      : t('onboarding.flow.outcome.failedThem'),
                })}
              </p>
            )}
            <div className={styles.block}>
              <p className={styles.addlabel}>{t('onboarding.flow.outcome.addMore')}</p>
              {keyField(
                async (v) => {
                  if (await connectKey(v)) setColdKey('');
                },
                coldKey,
                setColdKey
              )}
              {keyStatus()}
            </div>
          </>
        ) : cliOnly ? (
          <>
            <h1 className={styles.headline}>
              {hi(t('onboarding.flow.outcome.cliHeadline'))}
              <span className={styles.pt}>.</span>
            </h1>
            <p className={styles.sub}>{t('onboarding.flow.outcome.cliSub')}</p>
            <div className={`${styles.block} ${styles.note}`}>
              <span className={styles.nIc}>
                <Info size={17} />
              </span>
              <span>{t('onboarding.flow.outcome.cliNote')}</span>
            </div>
          </>
        ) : (
          // no provider connected yet → lead with one-click Google (free Gemini),
          // paste-a-provider-key demoted to a secondary door below the hero.
          <>
            <h1 className={styles.headline}>
              {t('onboarding.flow.outcome.coldHeadline')}
              <span className={styles.pt}>.</span>
            </h1>
            <p className={styles.sub}>
              {wireFailed.length > 0
                ? t('onboarding.flow.outcome.coldSubFailed', {
                    label: failedLabel,
                    them:
                      wireFailed.length === 1
                        ? t('onboarding.flow.outcome.failedIt')
                        : t('onboarding.flow.outcome.failedThem'),
                  })
                : t('onboarding.flow.outcome.coldSub')}
            </p>
            <div className={`${styles.block} ${styles.doors}`}>
              {/* PRIMARY hero: one-click Google → free Gemini, no key, no card. */}
              <button
                type='button'
                className={`${styles.door} ${styles.doorHero}`}
                onClick={() => void connectGoogle()}
                disabled={busy !== null}
              >
                <span className={`${styles.dIc} ${styles.dIcWhite}`}>
                  {busy === 'google' ? <Loader2 size={22} className={styles.spinDark} /> : <GoogleMark />}
                </span>
                <span className={styles.dMain}>
                  <span className={styles.dTitleRow}>
                    <span className={styles.dTitle}>{t('onboarding.flow.outcome.doorGoogleTitle')}</span>
                  </span>
                  <span className={styles.dBody}>{t('onboarding.flow.outcome.doorGoogleBody')}</span>
                  <span className={styles.dFoot}>{t('onboarding.flow.outcome.doorGoogleFoot')}</span>
                </span>
                <ArrowRight size={18} className={styles.dArrow} />
              </button>
              {googleErr && <p className={styles.keyErr}>{googleErr}</p>}

              {/* SECONDARY: already have a provider key? paste it. */}
              <div>
                <p className={styles.addlabel}>{t('onboarding.flow.outcome.readyPasteLabel')}</p>
                {keyField(
                  async (v) => {
                    if (await connectKey(v)) {
                      setColdKey('');
                      setScreen('interests');
                    }
                  },
                  coldKey,
                  setColdKey
                )}
                {keyStatus()}
                <p className={styles.keyhint}>
                  {t('onboarding.flow.outcome.geminiKeyHint')}{' '}
                  <a href='https://aistudio.google.com/apikey' target='_blank' rel='noreferrer'>
                    {t('onboarding.flow.outcome.geminiKeyLink')}
                  </a>
                </p>
              </div>
            </div>
          </>
        )}

        {errorMsg && <p style={{ fontSize: 13, color: '#ef4444', marginTop: 12 }}>{errorMsg}</p>}
        <div className={styles.grow} />
        <div className={styles.actions}>
          {trueCold ? (
            <button type='button' className={styles.ghost} onClick={() => setScreen('interests')}>
              {t('onboarding.flow.outcome.doLater')}
            </button>
          ) : (
            <span className={styles.ghost}>{t('onboarding.flow.outcome.editableLater')}</span>
          )}
          {!trueCold && (
            <button
              type='button'
              className={styles.btn}
              onClick={() => setScreen('interests')}
              disabled={busy !== null}
            >
              {t('onboarding.flow.outcome.continue')} <ArrowRight size={15} />
            </button>
          )}
        </div>
      </div>
    );
  }

  if (screen === 'interests') {
    return (
      <div className={styles.shell}>
        <Header step={2} />
        <h1 className={styles.headline}>
          {name ? t('onboarding.flow.interests.headlineNamed', { name }) : t('onboarding.flow.interests.headline')}
          <span className={styles.pt}>?</span>
        </h1>
        <p className={styles.sub}>{t('onboarding.flow.interests.sub')}</p>
        <div className={`${styles.block} ${styles.pgrid}`}>
          {PERSONAS.map((p) => {
            const sel = picks.includes(p.id);
            return (
              <button
                key={p.id}
                type='button'
                className={`${styles.persona} ${sel ? styles.personaSel : ''}`}
                style={accentStyle(p.accent)}
                aria-pressed={sel}
                onClick={() => togglePick(p.id)}
              >
                <span className={styles.pIc}>
                  <p.Icon size={20} />
                </span>
                <span className={styles.pName}>{t(p.labelKey)}</span>
              </button>
            );
          })}
        </div>
        <div className={styles.block}>
          <input
            className={styles.bigfield}
            value={work}
            placeholder={t('onboarding.flow.interests.workPlaceholder')}
            onChange={(e) => setWork(e.target.value)}
          />
        </div>
        <div className={styles.grow} />
        <div className={styles.actions}>
          <button
            type='button'
            className={styles.ghost}
            onClick={() => setScreen('allset')}
            disabled={busy === 'infer'}
          >
            {t('onboarding.flow.interests.skip')}
          </button>
          <button
            type='button'
            className={styles.btn}
            onClick={() => void finishInterests()}
            disabled={busy === 'infer'}
          >
            {busy === 'infer' ? (
              <>
                {t('onboarding.flow.interests.settingUp')} <Loader2 size={15} className={styles.spinDark} />
              </>
            ) : (
              <>
                {t('onboarding.flow.interests.startInChat')} <ArrowRight size={15} />
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  // allset
  return (
    <div className={styles.shell}>
      <Header step={2} />
      <div
        className={styles.grow}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <h1 className={styles.headline}>
          {hi(t('onboarding.flow.allset.headline'))}
          <span className={styles.pt}>.</span>
        </h1>
        <p className={styles.sub} style={{ margin: 0 }}>
          {t('onboarding.flow.allset.sub')}
        </p>
        <button
          type='button'
          className={styles.btn}
          style={{ padding: '14px 28px', fontSize: 15, marginTop: 6 }}
          onClick={finishAll}
        >
          {t('onboarding.flow.allset.go')} <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
};

export default OnboardingFlow;
