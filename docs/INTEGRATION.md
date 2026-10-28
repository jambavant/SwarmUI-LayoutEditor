# How Layout Editor integrates with SwarmUI

This page lists every point where the extension touches SwarmUI, for reviewers and for anyone checking compatibility after a Swarm update.

**Summary:** the C# side only registers static web files. The editor runs entirely in the browser and generates through Swarm's normal generation path, so every parameter the user has set (model, steps, CFG, LoRAs, presets, batch size) applies unchanged. The extension adds no parameters, API routes, ComfyUI nodes, workflow steps, settings, permissions or network connections.

## Server side (C#)

`LayoutEditorExtension.cs` overrides two lifecycle methods:

| Method | What it does |
| --- | --- |
| `OnPreInit` | Adds 5 scripts to `ScriptFiles`, 2 stylesheets to `StyleSheetFiles`, and `standalone/index.html` to `OtherAssets` |
| `OnInit` | Logs one line (`Layout Editor extension loaded.`) |

Swarm serves those files under `/ExtensionFile/LayoutEditorExtension/...`. Script order matters: the core files define the `window.LayoutEditor` namespace that the Swarm host script uses.

## Browser side

### Files and globals

| File | Role |
| --- | --- |
| `Assets/core/le-model.js` | Canonical layout model (box geometry normalized 0..1, independent of format) |
| `Assets/core/le-formats.js` | Format profiles; MOSS-Image export/import |
| `Assets/core/le-validate.js` | Checks shown in the editor |
| `Assets/core/le-editor.js` | The editor UI (host-agnostic, also used by the standalone page) |
| `Assets/swarm-layout-editor.js` | The SwarmUI host: menu entry, modal, Apply, generation |

Globals added: `window.LayoutEditor` (namespace) and `window.layoutEditorSwarm` (`open`, `close`, `getEditor`). Everything else is inside closures.

All CSS is scoped under `.le-root` (the editor) and `.le-swarm-*` (the modal). Colors come from Swarm's theme variables (`--background`, `--background-panel`, `--text`, `--emphasis`, `--light-border`, ...), so the editor follows the user's theme. The modal overlay uses `z-index: 1060`, above Bootstrap modals.

### Swarm functions and elements used

| Swarm API | Used for |
| --- | --- |
| `sessionReadyCallbacks` | Initialize once the Generate page session is ready |
| `class GenerateHandler` | Subclassed as `LayoutGenHandler` (see below) |
| `currentModelHelper.ensureCurrentModel(cb)` | Same model check Swarm's own Image Batcher uses before generating |
| `currentModelHelper.curCompatClass` | Show a notice when the selected model is not `moss-image` |
| `triggerChangeFor(elem)` | Notify Swarm after changing the prompt or resolution inputs |
| `#alt_prompt_textbox` | Read the prompt (to load an existing layout) and write it on Apply |
| `#input_aspectratio`, `#input_width`, `#input_height` | Read the resolution; on Apply set aspect to `Custom` and the canvas size |
| `#input_images` | Number of images expected, for the progress text |
| `#current_model` | Detect "no model selected" |
| `promptPlusButton.showMenu` | Add the menu entry (see below) |

### Generation

`LayoutGenHandler extends GenerateHandler`. It overrides `gotImageResult`, `gotTrackedImageResult`, `gotProgress`, `internalHandleData` and `hadError`. Each override calls `super` first, so Swarm's own handling (batch area, current image, history, completion sound) is unchanged; the override only reports to the editor.

Generate calls `doGenerate(overrides)` on that handler with:

```js
{ prompt: <layout JSON>, width: W, height: H, aspectratio: 'Custom', sidelength: null, seed: <only with "Keep seed"> }
```

Before generating, it also writes the prompt and resolution into Swarm's inputs (same as Apply, without closing). Swarm's own controls, metadata and "reuse parameters" therefore always match what was generated.

Cancel calls the handler's `doInterrupt()`, which uses Swarm's normal interrupt for the session.

### The + menu entry

Swarm has no extension hook for the menu of the **+** button beside the prompt. The extension wraps `promptPlusButton.showMenu`:

1. It calls the original `showMenu` first, unchanged.
2. Then it inserts one entry into the popover's `buttons` list, before "Other...", and calls the popover's own `buildList()`, the same method its search box uses.

The wrapper is guarded: if `promptPlusButton`, its popover, `buttons` or `buildList` are missing (for example after a Swarm refactor), it does nothing. A plain **Layout** button is then added next to Generate instead, so the editor stays reachable.

A small upstream hook, such as an array of extra entries that `showMenu` appends, would remove the need for this wrapper. The extension would switch to it as soon as it exists.

### Keyboard

The editor listens for `keydown` on `document` in the capture phase, but only while the modal is open. It stops propagation only for keys it actually handles, so Swarm's own shortcuts (Ctrl+Enter generate, arrow keys in the image history) don't fire while the editor is in use. Esc closes the modal when nothing in the editor consumed it.

### Prompt syntax

Apply replaces the whole prompt with the layout JSON. Swarm parses `<...>` as prompt tags; the JSON itself never contains `<` or `>`, and the editor warns when a caption or text does. LoRAs set in Swarm's LoRA panel are unaffected; LoRA tags typed into the prompt are replaced along with it.

### Storage

`localStorage` keys, per browser: `layoutEditor.autosave.v1` (current layout), `layoutEditor.saved.v1` (named layouts), `layoutEditor.prefs.v1` (snap, grid, panel state). Every access is wrapped in try/catch; the editor works without storage.

## Standalone page

`standalone/index.html` loads the same core files and a minimal host (no generation; **Copy prompt** puts the JSON on the clipboard). It works from disk or at `/ExtensionFile/LayoutEditorExtension/standalone/index.html` while Swarm runs.

## Uninstall

Delete the extension folder and restart Swarm. Nothing is written outside it, apart from the browser storage keys above.

## What a Swarm update could break

| If Swarm changes... | Effect | Fallback |
| --- | --- | --- |
| `promptPlusButton` / the popover API | Menu entry missing | A **Layout** button appears next to Generate (at load, or the first time the menu opens) |
| `GenerateHandler` method names | Results or progress not shown in the editor | Generation still works and results appear in Swarm as usual |
| Prompt or resolution element ids | Apply doesn't fill the prompt or size | Copy the JSON from the editor's JSON panel |
