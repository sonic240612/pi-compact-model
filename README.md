# pi-compact-model

Pi extension that runs **context compaction and branch summaries on a different model** than the one you are chatting with.

Chat on a local model, summarize on a fast hosted one:

```
session model   openrouter/qwen/qwen3.8-27b:free   (or a local llama.cpp model)
compact model   openrouter/nvidia/nemotron-3.5-super-vl:free
```

Pi's compaction normally summarizes with the model the conversation is using. With a local
LLM that one call can take minutes. This extension keeps Pi's own compaction code path —
`compact()` and `generateBranchSummary()` from `pi-coding-agent`, i.e. the same prompts,
the same structured summary sections, the same file tracking, cut points, and retry policy —
and swaps only the model, thinking level, and request path of the summarization call.

The conversation, tool calls, and `/model` selection are untouched. If no compact model is
configured, the extension does nothing.

## Install

```bash
git clone https://github.com/sonic240612/pi-compact-model.git
cd pi-compact-model
pi install .                    # or: npm i -D pi-compact-model
```

`pi install <path>` records the folder in `~/.pi/agent/settings.json` under `packages` rather
than copying it, so editing the source takes effect the next time Pi starts. Remove it with
`pi uninstall <path>` or by deleting the entry.

Or load it for one run:

```bash
pi --extension ./index.ts       # from inside the cloned folder
```

Then check that it is loaded and configured:

```
/compact-model status
```

## Configuration

Files, highest precedence last (a key that is present wins; `null` clears an inherited key):

| File | Scope |
| --- | --- |
| `~/.pi/agent/compact-model.json` | global |
| `<cwd>/.pi/compact-model.json` | project |

Above the files, in increasing precedence: `PI_COMPACT_MODEL=<provider/modelId>` and
`pi --compact-model <provider/modelId>`. Set `PI_COMPACT_MODEL_NO_PROJECT=1` to ignore the
project file completely (see *Security and privacy*).

```json
{
  "enabled": true,
  "model": "openrouter/nvidia/nemotron-3.5-super-vl:free",
  "thinkingLevel": "inherit",
  "branchSummaries": true,
  "fallbackToSessionModel": true,
  "skipIfContextTooSmall": true
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` keeps the configured `model` but compaction uses the session model — this is what `/compact-model on` and `/compact-model off` write. A model given on the command line (`--compact-model x`, `PI_COMPACT_MODEL=x`) implies on. |
| `model` | none | Compact model reference. Absent or `null` means the extension stays out of compaction. |
| `provider` | none | Provider hint for references without a `provider/` prefix. |
| `thinkingLevel` | `"inherit"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `inherit` (the session's level). |
| `branchSummaries` | `true` | Also summarize abandoned branches when navigating with `/tree`. |
| `fallbackToSessionModel` | `true` | If the compact model call fails, let Pi summarize with the session model. If `false`, compaction is cancelled instead. |
| `skipIfContextTooSmall` | `true` | If the summary input will not fit the compact model's context window, use the session model instead. |

## Model references

Resolved like Pi resolves models on the CLI, against Pi's full model catalogue:

| Form | Example |
| --- | --- |
| `provider/modelId` | `openrouter/anthropic/claude-haiku-4.5` |
| `modelId` (any provider) | `anthropic/claude-haiku-4.5` |
| fuzzy substring of id, name, or provider | `haiku`, `gemini-flash`, `qwen coder` |
| trailing thinking level | `openrouter/google/gemini-2.5-flash:high` |

Notes that match Pi's own behaviour:

- OpenRouter ids keep their inner slashes and colon suffixes: `openrouter/qwen/qwen3.8-27b:free`
  resolves to that exact id — the `:free` is **not** read as a thinking level. A trailing
  `:off`/`:low`/`:high`/… is only treated as a thinking level when the whole text does not
  match a model id.
- An exact match wins. Otherwise a unique id match wins, then a unique fuzzy match (a notice
  says what it matched).
- Ambiguous matches are resolved to the single candidate whose provider has configured
  credentials; if several remain, `/compact-model <pattern>` shows a picker.

## Command

```
/compact-model                       status, then an interactive model search
/compact-model status                effective config, its source, and any warnings
/compact-model on                    use the compact model again (keeps the configured model)
/compact-model off                   stop using it: compaction goes back to the session model
/compact-model <pattern>             set the compact model (fuzzy ok; picker if ambiguous) — also turns it on
/compact-model clear                 forget the model entirely
/compact-model thinking <level>      off | minimal | low | medium | high | xhigh | max | inherit
/compact-model branch on|off         branch summaries (/tree)
/compact-model fallback on|off       fall back to the session model on failure
/compact-model guard on|off          skip the compact model when the input will not fit
```

`off` is a switch and leaves the model in the file, so `on` restores the previous choice —
`/compact-model status` then reads `compact model: off — kept <model> (<file>); "/compact-model on" to enable`.
Use `clear` (also `default`, `reset`, `inherit`) to remove the model instead. In the interactive
search, typing `off` toggles the switch and `clear` removes the model.

`off` also works per scope: `/compact-model off --project` disables it for this project only
while the global model stays enabled elsewhere.

Append `--project` to write `<cwd>/.pi/compact-model.json` instead of the global file.
Choices are saved immediately and apply to the next compaction; no restart needed.

## Behaviour details

- **Compaction** (`/compact`, auto-compaction, and retry compaction): the extension answers
  Pi's `session_before_compact` hook by calling Pi's own `compact()` with the compact
  model, then hands the result back, so the summary format, retained tail, file tracking,
  `firstKeptEntryId`, and token accounting are Pi's. One compaction normally costs two
  requests through the compact model (session summary plus the current-turn prefix) — that is
  what Pi itself does.
- **Branch summaries** (`/tree` navigation with summarization): same idea through
  `session_before_tree` and Pi's `generateBranchSummary()`.
- **Thinking level**: `inherit` uses the session's current level; Pi clamps it to what the
  compact model supports, exactly like `/model` does. A model that does not reason ignores it.
- **Failures**: rate limits (OpenRouter `:free` models hit these) and provider errors follow
  Pi's `settings.retry` policy, then fall back to the session model unless
  `fallbackToSessionModel` is `false`. A compact model is attempted **once per compaction
  request**: when Pi re-fires the hook for a retry, the retry summarizes with the session
  model, so a broken or rate-limited compact model cannot turn one `/compact` into a dozen paid
  calls. Missing credentials are detected before any request is made.
- **Context guard**: the input is estimated with Pi's `estimateTokens()` and compared against
  the compact model's `contextWindow` minus output headroom. This keeps a small hosted model
  usable even when the conversation is huge.
- **Context guard**: the input is estimated with Pi's `estimateTokens()` and compared against
  the compact model's `contextWindow` minus output headroom. This keeps a small hosted model
  usable even when the conversation is huge.
- Requests go through `modelRegistry.streamSimple`, so provider auth, base URLs, headers, and
  per-provider config (including any auth extensions) apply as they do for Pi itself.

## Development

```bash
npm run check          # tsc --noEmit
npm test               # unit tests: model references, config merging, branch summarization
npm run e2e            # real pi in RPC mode + a mock provider: proves which model summarized
npm run e2e:fallback   # summarizer fails; Pi must finish compaction with the session model
node scripts/e2e-rpc.mjs --compact-ref openrouter/nvidia/nemotron-3.5-super-vl:free
```

The end-to-end driver (`scripts/e2e-rpc.mjs`) starts real Pi with a mock provider
(`test/fixtures/mock-provider.ts`), drives a short session, triggers compaction, and reads the
mock provider's request log — the default runs make no network calls and cost nothing. The
normal run also compacts after `/compact-model off` and again after `/compact-model on`, and
asserts the session model and the compact model respectively did the work.
`--compact-ref <provider/modelId>` replaces the mock summarizer with a real model (the session
model stays mocked); it needs the provider key in the environment, e.g. `OPENROUTER_API_KEY`.
Set `PI_COMPACT_MODEL_DEBUG=1` to send the extension's resolution and failure diagnostics to
stderr; the driver forwards Pi's stderr, and `[pi stderr]` lines show them.

## Troubleshooting

| What you see | What it means |
|---|---|
| `Compacting with <model>…` then `Compacted with <model> in N.Ns` | the compact model did the work. |
| `compact model is off (<model>) — "/compact-model on" to enable` at session start | the switch is off; the model is still configured. |
| `… cannot fit N summary tokens (limit M); using the session model` | context guard tripped; pick a compact model with a bigger `contextWindow`, raise `reserveTokens`, or turn the guard off with `/compact-model guard off`. |
| `No model matches "x". Try one of: …` | the reference resolved to nothing in Pi's current catalogue (the list is `get_available_models`, so enabled/disabled and custom models are respected). |
| `"x" is ambiguous (a, b, c)` | more than one provider has that id; write `provider/modelId`. |
| `No credentials configured for …` | the model's provider is not logged in; `/login <provider>` or pick another model. |
| `Summarization failed: 403: {"message":"Key limit exceeded…` | the API key's spend limit is reached (OpenRouter keys default to `$0.00`, which blocks paid models; `:free` ids still work). Fix it at openrouter.ai/settings/keys. |
| `404 … This model is unavailable for free` | that `:free` id no longer exists; the paid variant does. Choose another id — the extension falls back to the session model meanwhile. |
| A model call at all when you expected none | `settings.compaction.enabled: false` disables Pi's automatic compaction entirely; `/compact` still works. |

## Security and privacy

What the extension touches:

- **No credentials are read, copied, or printed.** Authentication stays inside Pi: the
  extension only asks `modelRegistry.hasConfiguredAuth(model)` / `getApiKeyAndHeaders(model)`
  whether a model *can* authenticate, and discards the result immediately. It never opens
  `auth.json`, never reads provider key variables, and the request goes through Pi's own
  `modelRegistry.streamSimple`.
- **Nothing is sent anywhere except to the model you picked.** No telemetry, no network calls,
  no subprocesses, no `eval`. The only writes are `~/.pi/agent/compact-model.json` and
  `<cwd>/.pi/compact-model.json`, and only with the documented keys.
- **Error text is scrubbed.** Providers sometimes quote the request they were handed —
  including `Authorization` headers — inside error bodies. Every message the extension shows
  or logs passes through `redactSecrets()` (`sk-…`, `Bearer …`, `api_key`/`authorization`
  fields, key ids in URLs, long hex runs). Opt-in diagnostics
  (`PI_COMPACT_MODEL_DEBUG=1`) go to stderr only, never to stdout or the session transcript.
- **A model reference can only name a model Pi already knows.** Resolution happens against
  Pi's own catalogue, so a config file cannot point summarization at an arbitrary URL.
- **Project config is a deliberate trust decision.** `<cwd>/.pi/compact-model.json` is read
  from the working directory, so a cloned repository could pick which of *your* configured
  models receives the summary of your conversation. Set `PI_COMPACT_MODEL_NO_PROJECT=1` to
  ignore that layer entirely (`/compact-model … --project` then refuses to write it).
- **Privacy reminder:** compaction has always shipped part of your conversation to a model
  provider. This extension can send that part to a *different* provider than the conversation,
  which is the point — check that is acceptable for the data in the session. Free OpenRouter
  models may be logged or used for training by the upstream provider; read their policy.
- Model ids and thinking levels are validated, unknown config keys are reported instead of
  applied, and a broken provider call falls back to Pi's normal path rather than retrying
  endlessly against a paid endpoint.

## Not handled

- The initial compacted-context token estimate after a custom compaction is Pi's own heuristic
  over the rebuilt context.
- `/new`, `/clone`, and `/resume` reset the summarization state; nothing to carry over.
