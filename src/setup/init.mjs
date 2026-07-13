// `claude-code-deepseek-delegator init` — the setup wizard. Wires the
// delegator fully into Claude Code:
//   1. pick a provider (any of the vendored ones, or a custom OpenAI-compatible
//      endpoint), paste + live-validate the API key
//   2. pick task routing (which model handles read/write/reason) and the
//      savings baseline, written to ~/.claude/delegator.json
//   3. register the MCP server, install the CLAUDE.md rules and the
//      settings.json hooks — all named after the chosen provider
//
// Safe by construction: backs up every file it changes, writes atomically,
// never overwrites user content, and is fully reversible with `uninstall`.
// Non-interactive (--yes, CI, no TTY) never prompts and defaults to the exact
// v2 behavior: DeepSeek, v4-pro for everything, Opus baseline.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  paths, backupFile, atomicWrite, readJsonSafe,
  upsertBlock, addHooks, mcpEntry, managedRules, storedMcpEnv,
  PKG_NAME, REPO_URL, AUTHOR,
} from './wiring.mjs';
import {
  listProviders, getProvider, loadProviders, resolveApiKey, keyEnvVar, findModel,
} from '../providers/registry.mjs';
import { saveConfig, TASKS } from '../config.mjs';
import { callModel } from '../client.mjs';
import {
  select, multiselect, input, spinner, isInteractive, AbortError,
  intro, outro, bar, panel, stepDone, stepFail,
} from './tui.mjs';
import { color, bold, dim } from '../colors.mjs';

const VERSION = createRequire(import.meta.url)('../../package.json').version;
const PLACEHOLDER_KEY = 'sk-REPLACE_WITH_YOUR_API_KEY';

const OK = color('green', '✓');
const NO = color('red', '✗');
// One aligned status line on the rail: mark, bold fixed-width label, detail.
function applied(mark, label, detail) {
  bar(`${mark} ${bold(label.padEnd(10))} ${detail}`);
}

function has(cmd, args = ['--version']) {
  try { return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0; } catch { return false; }
}

// CLI-first for MCP wiring, unless the user (or a test) forces the file path.
function cliAvailable() {
  return process.env.CLAUDE_DELEGATOR_FORCE_FILE !== '1' && has('claude');
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

function priceHint(m) {
  return `$${m.cost_per_1m_in ?? 0}/$${m.cost_per_1m_out ?? 0} per 1M`;
}

// The mix-and-match menu: every model of the active provider (bare ids), then
// the flagship + budget model of every OTHER provider whose key is detected,
// as "provider:model" specs — routing and shortlists accept both. Exported
// for tests.
export function buildModelChoices(activeId) {
  const items = [];
  const providers = listProviders();
  const active = providers.find((p) => p.id === activeId);
  for (const m of active?.models ?? []) {
    items.push({
      label: m.id,
      hint: `${((m.context_window ?? 0) / 1024).toFixed(0)}K ctx · ${priceHint(m)}`,
      value: m.id,
    });
  }
  for (const p of providers) {
    if (p.id === activeId || !p.available) continue;
    for (const mid of new Set([p.default_small_model_id, p.default_large_model_id])) {
      const m = findModel(p, mid);
      if (!m) continue;
      items.push({
        label: `${p.id}:${m.id}`,
        hint: `${p.name} · ${priceHint(m)}`,
        value: `${p.id}:${m.id}`,
      });
    }
  }
  return items;
}

function wireMcpViaCli(entry) {
  // remove-then-add keeps it idempotent and ensures the latest config sticks
  spawnSync('claude', ['mcp', 'remove', 'deepseek', '--scope', 'user'], { stdio: 'ignore' });
  const r = spawnSync('claude', ['mcp', 'add-json', 'deepseek', JSON.stringify(entry), '--scope', 'user'], { encoding: 'utf8' });
  return { ok: r.status === 0, detail: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function wireMcpViaFile(p, entry, dryRun) {
  const res = readJsonSafe(p.legacyMcpJson);
  if (!res.ok) return { ok: false, detail: `${p.legacyMcpJson} is not valid JSON — left untouched` };
  const data = res.data || {};
  if (typeof data.mcpServers !== 'object' || data.mcpServers === null) data.mcpServers = {};
  data.mcpServers.deepseek = entry;
  if (!dryRun) {
    const bak = backupFile(p.legacyMcpJson);
    atomicWrite(p.legacyMcpJson, JSON.stringify(data, null, 2) + '\n');
    return { ok: true, detail: `merged into ${p.legacyMcpJson}`, backup: bak };
  }
  return { ok: true, detail: `would merge into ${p.legacyMcpJson}` };
}

// ── wizard steps ───────────────────────────────────────────────────────────

async function chooseProvider({ interactive, flagProvider, p, dryRun, notes }) {
  if (flagProvider) {
    const provider = getProvider(flagProvider);
    if (!provider) {
      stepFail('Provider', `unknown "${flagProvider}" — available: ${listProviders().map((x) => x.id).join(', ')}`);
      return null;
    }
    if (interactive) stepDone('Provider', provider.name);
    return provider;
  }
  if (!interactive) return getProvider('deepseek');

  // Familiar names first, not alphabetical file order.
  const ORDER = ['deepseek', 'moonshot', 'zai', 'zhipu', 'alibaba-singapore', 'groq', 'xai', 'openrouter'];
  const providers = listProviders().sort((a, b) => {
    const ia = ORDER.indexOf(a.id); const ib = ORDER.indexOf(b.id);
    return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib);
  });
  const items = providers.map((prov) => {
    const cheapest = Math.min(...prov.models.map((m) => (typeof m.cost_per_1m_in === 'number' ? m.cost_per_1m_in : Infinity)));
    const price = Number.isFinite(cheapest) ? `from $${cheapest}/M in` : '';
    const keyState = prov.available ? color('green', 'key detected ✓') : `needs ${keyEnvVar(prov) || 'a key'}`;
    return { label: prov.name, hint: `${price} · ${keyState}`, value: prov.id };
  });
  items.push({ label: 'Custom OpenAI-compatible endpoint…', hint: 'ollama, vllm, LM Studio, a proxy', value: '__custom__' });

  const firstWithKey = providers.findIndex((prov) => prov.available);
  const initialIndex = firstWithKey !== -1 ? firstWithKey : Math.max(0, providers.findIndex((prov) => prov.id === 'deepseek'));
  const chosen = await select('Provider', items, { initialIndex });
  if (chosen !== '__custom__') return getProvider(chosen);
  return customProviderFlow({ p, dryRun, notes });
}

async function customProviderFlow({ p, dryRun, notes }) {
  bar(dim('Any endpoint speaking the OpenAI chat-completions API works.'));
  const name = (await input('Provider name', { placeholder: 'Local Ollama' })) || 'Custom';
  let endpoint = '';
  while (true) {
    endpoint = await input('Base URL', { placeholder: 'http://localhost:11434/v1' });
    try { new URL(endpoint); break; } catch { bar(`${NO} ${dim('that is not a valid URL')}`); }
  }
  const modelId = (await input('Model id', { placeholder: 'as the endpoint expects it' })) || 'default';
  const pastedKey = await input('API key (enter to skip if the endpoint needs none)', { mask: true });

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
  const provider = {
    name, id, type: 'openai-compat',
    api_key: pastedKey || 'none', // literal; "none" satisfies endpoints that ignore auth
    api_endpoint: endpoint,
    default_large_model_id: modelId,
    default_small_model_id: modelId,
    models: [{
      id: modelId, name: modelId,
      cost_per_1m_in: 0, cost_per_1m_out: 0,
      context_window: 128_000, default_max_tokens: 8192,
    }],
  };

  if (!dryRun) {
    const existing = readJsonSafe(p.providersJson);
    const list = Array.isArray(existing.data) ? existing.data : (existing.data && existing.data.id ? [existing.data] : []);
    const next = list.filter((x) => x?.id !== id).concat([provider]);
    const bak = backupFile(p.providersJson);
    if (bak) notes.push(`Backed up ${p.providersJson}`);
    atomicWrite(p.providersJson, JSON.stringify(next, null, 2) + '\n');
    loadProviders({ fresh: true });
  }
  stepDone('Custom provider', `${name} ${dim('→ ' + p.providersJson)}`);
  return provider;
}

// Key provenance matters here, so this checks sources EXPLICITLY instead of
// via resolveApiKey (whose keyring fallback would make a stored-only key look
// like a shell env var, and env-ref mode would then write a broken ${VAR}
// self-reference into the config):
//   flag > shell env (env-ref) > provider-entry literal > keyring > paste
async function resolveKey({ provider, interactive, flagKey }) {
  const envVar = keyEnvVar(provider);
  if (flagKey) return { value: flagKey, mode: 'literal', envVar };
  if (envVar && process.env[envVar]) {
    if (interactive) stepDone('API key', `${color('green', `${envVar} detected ✓`)}`);
    return { value: `\${${envVar}}`, mode: 'env-ref', envVar };
  }
  if (!envVar && provider.api_key) {
    if (interactive) stepDone('API key', `${color('green', 'saved with the provider ✓')}`);
    return { value: provider.api_key, mode: 'literal', envVar }; // custom provider, literal key in its entry
  }
  // a key pasted in an earlier init lives in the MCP env block — reuse it
  // (live validation still runs) instead of demanding a re-paste
  const stored = envVar ? storedMcpEnv()[envVar] : null;
  if (stored) {
    if (interactive) stepDone('API key', `${color('green', `${envVar} found in your MCP config ✓`)}`);
    return { value: stored, mode: 'literal', envVar };
  }
  if (interactive) {
    bar(dim(`No ${envVar || 'API key'} found in your environment.`));
    const pasted = await input(`${provider.name} API key (enter to add it later)`, { mask: true });
    if (pasted) return { value: pasted, mode: 'literal', envVar };
  }
  return { value: PLACEHOLDER_KEY, mode: 'placeholder', envVar };
}

// Live 1-shot ping so a typo'd key fails HERE, with the provider's real error,
// instead of on the user's first delegation tomorrow.
async function validateKey({ provider, key, interactive, notes }) {
  const model = findModel(provider, provider.default_small_model_id) || findModel(provider, provider.default_large_model_id);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const apiKey = key.mode === 'literal' ? key.value : resolveApiKey(provider);
    const spin = spinner(`checking the key against ${provider.name}`);
    try {
      await callModel({ provider, model, prompt: 'Reply with the word: pong', maxTokens: 16, temperature: 0, apiKey, timeoutMs: 20_000 });
      spin.stop(true, `Key verified — ${provider.name} answered ${dim('(' + model.id + ')')}`);
      return key;
    } catch (e) {
      spin.stop(false, `Key check failed: ${e.message}`);
      const canRetry = interactive && key.mode === 'literal' && attempt < 3;
      if (!canRetry) {
        notes.push(`The API key could not be verified against ${provider.name} — saved anyway. Fix it and re-run \`doctor\`.`);
        return key;
      }
      const pasted = await input(`${provider.name} API key, take ${attempt + 1} (enter to keep it as-is)`, { mask: true });
      if (!pasted) {
        notes.push(`The API key could not be verified against ${provider.name} — saved anyway. Fix it and re-run \`doctor\`.`);
        return key;
      }
      key = { ...key, value: pasted };
    }
  }
  return key;
}

async function chooseShortlist({ provider, interactive }) {
  const large = provider.default_large_model_id;
  const small = provider.default_small_model_id || large;
  if (!interactive) return [...new Set([large, small])];
  const items = buildModelChoices(provider.id);
  bar(dim('These become the options Claude offers when it asks "Delegate to which model?".'));
  if (items.some((it) => it.value.includes(':'))) {
    bar(dim('Models from every provider with a detected key are listed — mix freely.'));
  }
  return multiselect('Shortlist', items, { initialSelected: [...new Set([large, small])] });
}

// The one model question. No "task routing" vocabulary, no separate mode
// step — the options ARE the explanation. "Smart split" quietly maps to the
// small-digests / large-creates routing; "ask" flips on the shortlist picker.
// `others` = providers beyond the active one that have a usable key: when
// present, Custom and Ask can mix them, and the wizard must SAY so — mixing
// that exists but is invisible does not exist.
async function choosePicking({ provider, interactive, flagMode, flagPreset, others = [] }) {
  const TITLE = 'Which model runs your delegations?';
  const large = provider.default_large_model_id;
  const small = provider.default_small_model_id || large;
  const presets = {
    balanced: { read: small, write: large, reason: large },
    cheapest: { read: small, write: small, reason: small },
    max: { read: large, write: large, reason: large },
  };
  if (flagMode && flagMode !== 'auto' && flagMode !== 'ask') {
    stepFail(TITLE, `unknown mode "${flagMode}" — use: auto, ask`);
    return null;
  }
  if (flagPreset && !presets[flagPreset]) {
    stepFail(TITLE, `unknown preset "${flagPreset}" — use: balanced, cheapest, max`);
    return null;
  }
  if (flagMode === 'ask') return { mode: 'ask', routing: presets.balanced };
  if (flagPreset) return { mode: 'auto', routing: presets[flagPreset] };
  // Non-interactive default is "max" — the exact v2 behavior (one big model
  // for everything), so `init --yes` upgrades never silently change routing.
  if (!interactive) return { mode: 'auto', routing: presets.max };

  const otherNames = others.map((o) => o.name).join(', ');
  if (others.length) {
    bar(`${color('green', '◈')} You also have keys for ${bold(otherNames)} — ${bold('Ask me each time')} and ${bold('Custom…')} can mix their models in.`);
    bar();
  }
  const choice = await select(TITLE, [
    {
      label: 'Smart split (recommended)',
      hint: small !== large ? `${small} digests big files · ${large} writes code and reasons` : `${large} for everything`,
      value: 'balanced',
    },
    {
      label: 'Ask me each time',
      hint: others.length ? `a shortlist across ${provider.name} + ${otherNames}, picked in Claude Code` : 'choose from a shortlist in Claude Code\'s picker',
      value: 'ask',
    },
    { label: 'Always the best', hint: `${large} for everything`, value: 'max' },
    { label: 'Always the cheapest', hint: `${small} for everything`, value: 'cheapest' },
    {
      label: 'Custom…',
      hint: others.length ? `a model per kind of work — mix ${provider.name} with ${otherNames}` : 'a model per kind of work',
      value: 'custom',
    },
  ], { initialIndex: 0 });

  if (choice === 'ask') return { mode: 'ask', routing: presets.balanced };
  if (choice !== 'custom') return { mode: 'auto', routing: presets[choice] };

  const routing = {};
  const items = buildModelChoices(provider.id);
  if (items.some((it) => it.value.includes(':'))) {
    bar(dim('Models from every provider with a detected key are listed — mix freely.'));
  }
  const taskBlurb = { read: 'digest/summarize big inputs', write: 'generate code and docs', reason: 'math, logic, architecture' };
  for (const task of TASKS) {
    routing[task] = await select(`Model when the work is "${task}" — ${taskBlurb[task]}`, items, {
      initialIndex: Math.max(0, items.findIndex((it) => it.value === (task === 'read' ? small : large))),
    });
  }
  return { mode: 'auto', routing };
}

async function chooseBaseline({ interactive, flagBaseline }) {
  const map = { opus: 'opus-4.8', 'opus-4.8': 'opus-4.8', sonnet: 'sonnet-5', 'sonnet-5': 'sonnet-5', none: 'none' };
  if (flagBaseline) {
    if (!map[flagBaseline]) {
      stepFail('Savings baseline', `unknown "${flagBaseline}" — use: opus, sonnet, none`);
      return null;
    }
    return map[flagBaseline];
  }
  if (!interactive) return 'opus-4.8';
  return select('Savings baseline — the "vs Claude" line on cost receipts', [
    { label: 'Opus 4.8 (recommended)', hint: '$5 in / $25 out per 1M', value: 'opus-4.8' },
    { label: 'Sonnet 5', hint: '$3 in / $15 out per 1M', value: 'sonnet-5' },
    { label: "Don't show savings", hint: 'receipts show spend only', value: 'none' },
  ], { initialIndex: 0 });
}

// ── main ───────────────────────────────────────────────────────────────────

export async function runInit(argv = []) {
  try {
    return await wizard(argv);
  } catch (e) {
    if (e instanceof AbortError) {
      outro(dim('Cancelled. Nothing was changed.'));
      return 1;
    }
    throw e;
  }
}

async function wizard(argv) {
  const dryRun = argv.includes('--dry-run');
  const noHooks = argv.includes('--no-hooks');
  const assumeYes = argv.includes('--yes') || argv.includes('-y');
  const flagProvider = flagValue(argv, '--provider');
  const flagKey = flagValue(argv, '--key');
  const flagPreset = flagValue(argv, '--preset');
  const flagBaseline = flagValue(argv, '--baseline');
  const flagMode = flagValue(argv, '--mode');
  const interactive = isInteractive() && !assumeYes;

  const p = paths();
  const notes = [];
  const backups = [];

  console.log('');
  intro(
    `${PKG_NAME} ${dim('v' + VERSION)}${dryRun ? color('yellow', '  dry run — nothing will be written') : ''}`,
    'delegate heavy work from Claude Code to a cheaper model · ~1 minute'
  );

  // 1) provider
  const provider = await chooseProvider({ interactive, flagProvider, p, dryRun, notes });
  if (!provider) return 1;

  // 2) API key (+ live validation when interactive)
  let key = await resolveKey({ provider, interactive, flagKey });
  if (interactive && !dryRun && key.mode !== 'placeholder') {
    key = await validateKey({ provider, key, interactive, notes });
  }

  // 3) which model runs delegations (one question; "ask" adds a shortlist).
  // A key pasted this run isn't in env/keyring yet, so the OTHER providers'
  // availability is what listProviders can see right now.
  const others = listProviders().filter((x) => x.id !== provider.id && x.available);
  const picked = await choosePicking({ provider, interactive, flagMode, flagPreset, others });
  if (!picked) return 1;
  const { mode, routing } = picked;
  let shortlist = [];
  if (mode === 'ask') shortlist = await chooseShortlist({ provider, interactive });
  const baseline = await chooseBaseline({ interactive, flagBaseline });
  if (!baseline) return 1;

  const shortlistDetailed = shortlist.map((spec) => {
    const m = provider.models.find((x) => x.id === spec);
    return { spec, hint: m ? priceHint(m) : '' };
  });

  // ── Full disclosure: show EXACTLY what will change, then ask. Nothing is
  //    written before this point (except a custom provider definition). ──
  panel([
    `${bold('delegator.json')}   provider, routing, baseline`,
    `${bold('CLAUDE.md')}        delegation rules block ${dim('— your content untouched')}`,
    noHooks
      ? `${bold('settings.json')}    ${dim('skipped (--no-hooks)')}`
      : `${bold('settings.json')}    2 nudge hooks + the cost receipt ${dim('— never blocks')}`,
    `${bold('MCP server')}       "deepseek" ${dim('(npx -y ' + PKG_NAME + ')')}`,
  ], { title: bold('4 changes to your Claude Code setup') });
  bar(dim(`reversible anytime: npx ${PKG_NAME} uninstall · timestamped backups are written first`));
  bar();

  if (!dryRun && !assumeYes) {
    if (!isInteractive()) {
      outro('Not an interactive terminal. Re-run with --yes to apply, or --dry-run to preview only.');
      return 1;
    }
    const go = await select('Apply these changes?', [
      { label: 'Apply', value: true },
      { label: 'Cancel', value: false },
    ]);
    if (!go) {
      outro(dim('Cancelled. Nothing was changed.'));
      return 1;
    }
  }

  // delegation config
  if (!dryRun) {
    const bak = backupFile(p.delegatorJson);
    if (bak) backups.push(bak);
    await saveConfig({ provider: provider.id, mode, shortlist, routing, baseline });
  }
  applied(OK, 'config', `${dryRun ? 'would write' : 'wrote'} provider/routing/baseline  ${dim('(' + p.delegatorJson + ')')}`);

  // MCP server registration — preserve keys from earlier setups (the env
  // block is a keyring; switching providers must not lose the old key)
  const existingEnv = {
    ...(readJsonSafe(p.claudeJson).data?.mcpServers?.deepseek?.env || {}),
    ...(readJsonSafe(p.legacyMcpJson).data?.mcpServers?.deepseek?.env || {}),
  };
  // custom providers keep their literal key in the provider entry itself
  const entry = mcpEntry(key.envVar ? key.value : null, key.envVar, existingEnv);
  const keptKeys = Object.keys(entry.env || {}).filter((k) => k !== key.envVar);
  if (keptKeys.length) notes.push(`Kept existing key(s) in the MCP env block: ${keptKeys.join(', ')} — cross-provider routing needs them.`);
  let mcp;
  if (cliAvailable()) {
    mcp = dryRun
      ? { ok: true, detail: 'would register via `claude mcp add-json deepseek --scope user`' }
      : wireMcpViaCli(entry);
    if (!mcp.ok) {
      notes.push('`claude mcp add-json` failed; fell back to file merge.');
      mcp = wireMcpViaFile(p, entry, dryRun);
    }
  } else {
    notes.push('`claude` CLI not found on PATH; used file fallback for MCP config.');
    mcp = wireMcpViaFile(p, entry, dryRun);
  }
  applied(mcp.ok ? OK : NO, 'MCP server', mcp.detail);
  if (mcp.backup) backups.push(mcp.backup);

  // CLAUDE.md rules
  const curMd = existsSync(p.claudeMd) ? readFileSync(p.claudeMd, 'utf8') : '';
  const nextMd = upsertBlock(curMd, managedRules(provider.name, { shortlist: shortlistDetailed }));
  const mdChanged = nextMd !== curMd;
  if (mdChanged && !dryRun) {
    const bak = backupFile(p.claudeMd);
    if (bak) backups.push(bak);
    atomicWrite(p.claudeMd, nextMd);
  }
  applied(OK, 'CLAUDE.md', `${dryRun ? 'would install' : mdChanged ? 'installed' : 'already up to date'} the delegation rules  ${dim('(' + p.claudeMd + ')')}`);

  // settings.json hooks
  if (noHooks) {
    applied(dim('•'), 'hooks', dim('skipped (--no-hooks)'));
  } else {
    const res = readJsonSafe(p.settingsJson);
    if (!res.ok) {
      applied(NO, 'hooks', `${dim(p.settingsJson)} is not valid JSON — left untouched, hooks NOT installed`);
      notes.push(`Fix ${p.settingsJson} then re-run init to enable hard enforcement.`);
    } else {
      const next = addHooks(res.data, provider.name);
      const changed = JSON.stringify(next) !== JSON.stringify(res.data);
      if (changed && !dryRun) {
        const bak = backupFile(p.settingsJson);
        if (bak) backups.push(bak);
        atomicWrite(p.settingsJson, JSON.stringify(next, null, 2) + '\n');
      }
      applied(OK, 'hooks', `${dryRun ? 'would install' : changed ? 'installed' : 'already up to date'} Read + Skill gates + cost display  ${dim('(' + p.settingsJson + ')')}`);
      if (!has('node')) notes.push('`node` was not found on PATH — the PreToolUse hooks run via node, so make sure node is on PATH.');
    }
  }

  // Key guidance
  if (key.mode === 'env-ref') notes.push(`MCP config references \${${key.envVar}}. Make sure that variable is exported in your shell profile so Claude Code can read it.`);
  if (key.mode === 'literal' && key.envVar) notes.push(`Your API key was saved into the MCP config. To keep it out of that file, export ${key.envVar} in your shell profile and re-run init.`);
  if (key.mode === 'placeholder') notes.push(`No API key set. Replace "${PLACEHOLDER_KEY}" in your MCP config, or set ${key.envVar || 'the provider key'} and re-run init.`);

  // Report
  bar();
  if (backups.length) {
    bar(dim('backups (restore to undo manually):'));
    for (const b of backups) bar(dim(`  ${b}`));
    bar();
  }
  if (notes.length) {
    for (const n of notes) bar(`${color('yellow', '!')} ${n}`);
    bar();
  }
  if (dryRun) {
    outro(`${bold('Dry run complete.')} Re-run without ${dim('--dry-run')} to apply.`);
    return 0;
  }

  panel([
    `${bold('provider')}   ${provider.name} ${dim('(' + provider.id + ')')}`,
    ...(mode === 'ask'
      ? [`${bold('picker')}     ask each time ${dim('· ' + shortlist.join(' · '))}`]
      : [
          `${bold('read')}    ${dim('→')}  ${routing.read}`,
          `${bold('write')}   ${dim('→')}  ${routing.write}`,
          `${bold('reason')}  ${dim('→')}  ${routing.reason}`,
        ]),
    `${bold('baseline')}   ${baseline === 'none' ? dim('off') : baseline}`,
  ], { title: color('green', '✓') + ' ' + bold('delegation is wired') });
  bar();
  outro([
    `${color('green', 'Done.')} Restart Claude Code — heavy tasks will prompt ${bold(`"Delegate to ${provider.name}? (y/n)"`)}`,
    '',
    `${dim('try:')}      claude "use delegate to summarize README.md"`,
    `${dim('verify:')}   npx ${PKG_NAME} doctor`,
    `${dim('remove:')}   npx ${PKG_NAME} uninstall`,
    '',
    `${color('yellow', '★')} ${dim(`enjoying it? a star helps others find it →`)} ${REPO_URL}`,
    dim(`  built by ${AUTHOR}`),
  ]);
  return 0;
}
