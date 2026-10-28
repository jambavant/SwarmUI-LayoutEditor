// Layout Editor - the visual editor.
// Host-agnostic: SwarmUI and the standalone page both create an Editor and pass a `host` object.
//
// host = {
//   mode: 'swarm' | 'standalone',
//   canGenerate: bool,
//   applyLabel: string,                 // 'Apply' (Swarm) or 'Copy' (standalone)
//   onApply(prompt, model),             // Apply / Copy button
//   onGenerate(prompt, model),          // Generate button / Ctrl+Enter (only when canGenerate)
//   onInterrupt(),                      // Cancel button during generation
//   isActive() -> bool,                 // whether keyboard shortcuts should be handled right now
//   extraToolbar(el)                    // lets the host add its own buttons (maximize, close)
// }
(function () {
    'use strict';
    let LE = window.LayoutEditor = window.LayoutEditor || {};

    let STORAGE_AUTOSAVE = 'layoutEditor.autosave.v1';
    let STORAGE_SAVED = 'layoutEditor.saved.v1';
    let STORAGE_PREFS = 'layoutEditor.prefs.v1';
    let SNAP_SCREEN_PX = 7;
    let GRID = 16;
    let MIN_DRAW_SCREEN_PX = 6;

    function storageGet(key, fallback) {
        try {
            let v = window.localStorage.getItem(key);
            return v == null ? fallback : JSON.parse(v);
        }
        catch (e) {
            return fallback;
        }
    }

    function storageSet(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        }
        catch (e) {
            // Storage can be unavailable (private mode, blocked site data); the editor still works without it.
        }
    }

    function el(tag, attrs, children) {
        let e = document.createElement(tag);
        if (attrs) {
            for (let k in attrs) {
                let v = attrs[k];
                // Strict on purpose: 0 is a valid attribute value (min: 0), only false means "omit".
                if (v == null || v === false) {
                    continue;
                }
                if (k == 'class') {
                    e.className = v;
                }
                else if (k == 'text') {
                    e.textContent = v;
                }
                else if (k == 'html') {
                    e.innerHTML = v;
                }
                else if (k.startsWith('on')) {
                    e.addEventListener(k.substring(2), v);
                }
                else if (k == 'style' && typeof v == 'object') {
                    Object.assign(e.style, v);
                }
                else {
                    e.setAttribute(k, v === true ? '' : v);
                }
            }
        }
        for (let c of [].concat(children || [])) {
            if (c == null || c === false) {
                continue;
            }
            e.appendChild(typeof c == 'string' ? document.createTextNode(c) : c);
        }
        return e;
    }

    function isTypingTarget(t) {
        if (!t) {
            return false;
        }
        let tag = t.tagName;
        return tag == 'INPUT' || tag == 'TEXTAREA' || tag == 'SELECT' || t.isContentEditable;
    }

    let TYPE_LETTER = { text: 'T', object: 'O', character: 'C' };

    /** The visual layout editor. One instance per host (Swarm modal or standalone page). */
    class Editor {
        /** Creates the editor inside `root`, restoring the autosaved layout and preferences. */
        constructor(root, host) {
            this.root = root;
            this.host = Object.assign({
                mode: 'standalone',
                canGenerate: false,
                applyLabel: 'Copy',
                onApply() { },
                onGenerate() { },
                onInterrupt() { },
                isActive() { return true; },
                extraToolbar() { }
            }, host || {});
            this.prefs = Object.assign({ snap: true, grid: true, targetMp: 1.05, jsonOpen: false, underlayOpacity: 0.5 }, storageGet(STORAGE_PREFS, {}));
            this.model = LE.normalizeModel(storageGet(STORAGE_AUTOSAVE, null) || LE.newModel('moss'));
            this.selectedId = null;
            this.drawType = 'object';
            this.history = [JSON.stringify(this.model)];
            this.historyIndex = 0;
            this.underlay = null;
            this.results = [];
            this.generating = false;
            this.keepSeed = false;
            this.drag = null;
            this.scale = 1;
            this.buildDom();
            this.bindGlobalKeys();
            this.renderAll();
        }

        // ------------------------------------------------------------ selection
        // `selection` holds the selected box ids; the last one is the primary (shown in single-box views).

        /** Primary selected box id (the last one selected), or null. */
        get selectedId() {
            return this.selection && this.selection.length ? this.selection[this.selection.length - 1] : null;
        }

        /** Selects exactly one box (or none when given null). */
        set selectedId(id) {
            this.selection = id ? [id] : [];
        }

        /** Whether the box with this id is selected. */
        isSelected(id) {
            return this.selection.includes(id);
        }

        /** The selected boxes, in layer order. */
        selectedItems() {
            return this.model.items.filter(i => this.selection.includes(i.id));
        }

        /** Replaces the selection (unknown and duplicate ids are dropped) and refreshes the views. */
        setSelection(ids) {
            let seen = new Set();
            this.selection = ids.filter(id => !seen.has(id) && seen.add(id) && this.model.items.some(i => i.id == id));
            this.renderBoxes();
            this.renderLayers();
            this.renderInspector();
        }

        /** Ctrl/Cmd+click: add a box to the selection, or remove it. */
        toggleSelect(id) {
            let next = this.selection.slice();
            let i = next.indexOf(id);
            if (i == -1) {
                next.push(id);
            }
            else {
                next.splice(i, 1);
            }
            this.setSelection(next);
        }

        /** Selects every visible box. */
        selectAll() {
            this.setSelection(this.model.items.filter(i => i.visible).map(i => i.id));
        }

        // ------------------------------------------------------------ public API

        /** The prompt for the current layout, in the active format. */
        getPrompt() {
            return LE.getFormat(this.model.formatId).exportPrompt(this.model);
        }

        /** The live layout model (not a copy). */
        getModel() {
            return this.model;
        }

        /** Replaces the canvas size (keeps relative box positions). */
        setSize(width, height, recordHistory) {
            this.model.width = LE.round16(width);
            this.model.height = LE.round16(height);
            this.renderAll();
            if (recordHistory !== false) {
                this.commit();
            }
        }

        /** Tries to load a prompt string. Returns true when it was recognized and imported. */
        importPrompt(str, silent) {
            for (let id of LE.formatOrder) {
                let profile = LE.formats[id];
                if (profile.detect(str)) {
                    try {
                        let res = profile.importPrompt(str, this.model);
                        this.model = res.model;
                        this.selectedId = null;
                        this.renderAll();
                        this.commit();
                        if (res.notes.length && !silent) {
                            this.toast(res.notes.join(' '));
                        }
                        return true;
                    }
                    catch (e) {
                        if (!silent) {
                            this.toast('Could not import: ' + e.message, true);
                        }
                        return false;
                    }
                }
            }
            return false;
        }

        /** Updates the generation status line, progress bar and Generate/Cancel buttons. */
        setGenStatus(text, progress, running) {
            this.generating = !!running;
            if (!this.resultsBar) {
                return;
            }
            this.genStatusText.textContent = text || '';
            this.genProgress.style.width = progress == null ? '0%' : `${Math.round(progress * 100)}%`;
            this.genProgress.parentElement.style.visibility = running ? 'visible' : 'hidden';
            this.generateButton.style.display = running ? 'none' : '';
            this.cancelButton.style.display = running ? '' : 'none';
        }

        /** Adds a generated image to the results strip and shows it under the boxes. */
        addResult(src, seed) {
            this.results.unshift({ src: src, seed: seed });
            if (this.results.length > 24) {
                this.results.length = 24;
            }
            if (seed != null) {
                this.lastSeed = seed;
            }
            this.renderResults();
            // The newest result becomes the underlay so boxes can be compared against it right away.
            this.setUnderlay(src, false);
        }

        /** Focuses the canvas so keyboard shortcuts apply. */
        focus() {
            this.stageWrap.focus({ preventScroll: true });
        }

        /** Recomputes the canvas scale, e.g. after the host resized the editor. */
        relayout() {
            this.layoutStage();
        }

        // ------------------------------------------------------------ DOM

        /** Builds the editor DOM: toolbar, layers, canvas, inspector, results, scene and JSON panels. */
        buildDom() {
            let r = this.root;
            r.innerHTML = '';
            r.classList.add('le-root');
            r.classList.toggle('le-mode-swarm', this.host.mode == 'swarm');

            // Toolbar
            this.formatSelect = el('select', { class: 'le-select', title: 'Output format', onchange: () => this.changeFormat(this.formatSelect.value) });
            for (let id of LE.formatOrder) {
                this.formatSelect.appendChild(el('option', { value: id, text: LE.formats[id].name }));
            }
            this.aspectSelect = el('select', { class: 'le-select', title: 'Aspect ratio', onchange: () => this.onAspectChange() });
            this.aspectSelect.appendChild(el('option', { value: 'custom', text: 'Custom' }));
            for (let a of LE.ASPECTS) {
                this.aspectSelect.appendChild(el('option', { value: a, text: a }));
            }
            this.mpSelect = el('select', { class: 'le-select', title: 'Target size for aspect presets', onchange: () => { this.prefs.targetMp = parseFloat(this.mpSelect.value); this.savePrefs(); this.onAspectChange(); } });
            for (let mp of [[1.05, '≈1 MP'], [1.5, '≈1.5 MP'], [2.1, '≈2 MP']]) {
                this.mpSelect.appendChild(el('option', { value: mp[0], text: mp[1] }));
            }
            this.mpSelect.value = String(this.prefs.targetMp);
            this.widthInput = el('input', { class: 'le-num', type: 'number', min: 256, max: 4096, step: 16, title: 'Width (px)', onchange: () => this.onSizeInput() });
            this.heightInput = el('input', { class: 'le-num', type: 'number', min: 256, max: 4096, step: 16, title: 'Height (px)', onchange: () => this.onSizeInput() });
            this.mpBadge = el('span', { class: 'le-badge' });
            this.typeButtons = el('div', { class: 'le-seg', title: 'Type for new boxes (keys T / O / C)' });
            this.addBoxButton = el('button', { class: 'le-btn le-add', title: 'Add a box of the selected type in a free spot (N). Useful when the canvas is full: you can also Shift-drag over boxes.', onclick: () => this.addBox() }, '+ Add');
            this.snapToggle = el('label', { class: 'le-check', title: 'Snap to edges, centers and other boxes (hold Alt to disable)' }, [
                el('input', { type: 'checkbox', onchange: e => { this.prefs.snap = e.target.checked; this.savePrefs(); } }), 'Snap'
            ]);
            this.gridToggle = el('label', { class: 'le-check', title: 'Snap to a 16 px grid' }, [
                el('input', { type: 'checkbox', onchange: e => { this.prefs.grid = e.target.checked; this.savePrefs(); } }), 'Grid 16'
            ]);
            this.underlayInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onchange: e => this.loadUnderlayFile(e.target.files[0]) });
            this.underlayButton = el('button', { class: 'le-btn', title: 'Show an image under the boxes to trace or compare', onclick: () => this.underlay ? this.setUnderlay(null) : this.underlayInput.click() }, 'Underlay');
            this.underlayOpacity = el('input', { type: 'range', min: 0, max: 1, step: 0.05, class: 'le-range', title: 'Underlay opacity', oninput: e => { this.prefs.underlayOpacity = parseFloat(e.target.value); this.applyUnderlayOpacity(); this.savePrefs(); } });
            this.undoButton = el('button', { class: 'le-btn le-icon', title: 'Undo (Ctrl+Z)', onclick: () => this.undo() }, '↶');
            this.redoButton = el('button', { class: 'le-btn le-icon', title: 'Redo (Ctrl+Shift+Z)', onclick: () => this.redo() }, '↷');
            this.layoutsButton = el('button', { class: 'le-btn', title: 'New, save, load, export and import layouts', onclick: e => this.openLayoutsMenu(e) }, 'Layouts ▾');
            this.optionsButton = el('button', { class: 'le-btn', title: 'Format options', onclick: e => this.openOptionsMenu(e) }, 'Options ▾');
            this.hostTools = el('div', { class: 'le-host-tools' });
            this.applyButton = el('button', { class: 'le-btn le-primary-outline', title: this.host.mode == 'swarm' ? 'Write the layout into the prompt and close' : 'Copy the prompt to the clipboard', onclick: () => this.doApply() }, this.host.applyLabel);
            this.hostTools.appendChild(this.applyButton);
            this.host.extraToolbar(this.hostTools);

            let toolbar = el('div', { class: 'le-toolbar' }, [
                el('div', { class: 'le-group' }, [this.formatSelect]),
                el('div', { class: 'le-group' }, [this.aspectSelect, this.mpSelect, this.widthInput, el('span', { class: 'le-x', text: '×' }), this.heightInput, this.mpBadge]),
                el('div', { class: 'le-group' }, [this.addBoxButton, this.typeButtons]),
                el('div', { class: 'le-group' }, [this.snapToggle, this.gridToggle]),
                el('div', { class: 'le-group' }, [this.underlayButton, this.underlayOpacity, this.underlayInput]),
                el('div', { class: 'le-group' }, [this.undoButton, this.redoButton, this.layoutsButton, this.optionsButton]),
                el('div', { class: 'le-spacer' }),
                this.hostTools
            ]);

            // Layers
            this.layersList = el('div', { class: 'le-layers-list' });
            let layers = el('div', { class: 'le-panel le-layers' }, [
                el('div', { class: 'le-panel-title', text: 'Layers' }),
                this.layersList,
                el('div', { class: 'le-hint', text: 'Drag to reorder. Order = order of items in the prompt.' })
            ]);

            // Stage
            this.underlayImg = el('img', { class: 'le-underlay', alt: '' });
            this.boxesLayer = el('div', { class: 'le-boxes' });
            this.guidesLayer = el('div', { class: 'le-guides' });
            this.stage = el('div', { class: 'le-stage' }, [this.underlayImg, this.boxesLayer, this.guidesLayer]);
            this.stageWrap = el('div', { class: 'le-stage-wrap', tabindex: '0' }, [this.stage]);
            this.stage.addEventListener('pointerdown', e => this.onStagePointerDown(e));
            this.stage.addEventListener('dblclick', e => this.onStageDblClick(e));
            this.stage.addEventListener('contextmenu', e => e.preventDefault());
            this.stageWrap.addEventListener('pointerdown', e => {
                if (e.target == this.stageWrap) {
                    this.select(null);
                }
            });

            // Results (generation)
            if (this.host.canGenerate) {
                this.genStatusText = el('span', { class: 'le-gen-status' });
                this.genProgress = el('div', { class: 'le-progress-inner' });
                this.generateButton = el('button', { class: 'le-btn le-primary', title: 'Generate with the current layout (Ctrl+Enter)', onclick: () => this.doGenerate() }, 'Generate');
                this.cancelButton = el('button', { class: 'le-btn le-danger', title: 'Stop the current generation', style: { display: 'none' }, onclick: () => this.host.onInterrupt() }, 'Cancel');
                this.keepSeedBox = el('input', { type: 'checkbox', onchange: e => { this.keepSeed = e.target.checked; } });
                this.resultsStrip = el('div', { class: 'le-results-strip' });
                this.resultsBar = el('div', { class: 'le-results' }, [
                    el('div', { class: 'le-results-head' }, [
                        this.generateButton, this.cancelButton,
                        el('label', { class: 'le-check', title: 'Reuse the seed of the last result, to compare layout changes fairly' }, [this.keepSeedBox, 'Keep seed']),
                        el('div', { class: 'le-progress', style: { visibility: 'hidden' } }, [this.genProgress]),
                        this.genStatusText
                    ]),
                    this.resultsStrip
                ]);
            }
            let center = el('div', { class: 'le-center' }, [this.stageWrap, this.resultsBar || null]);

            // Inspector
            this.inspector = el('div', { class: 'le-panel le-inspector' });

            // Bottom: scene + issues + JSON
            this.sceneCaption = el('textarea', { class: 'le-textarea', rows: 2, oninput: () => { this.model.scene.caption = this.sceneCaption.value; this.changed(true); } });
            this.metaChips = el('div', { class: 'le-chips' });
            this.issuesList = el('div', { class: 'le-issues' });
            this.jsonText = el('textarea', { class: 'le-textarea le-mono', rows: 6, spellcheck: 'false', oninput: () => this.onJsonInput() });
            this.jsonError = el('div', { class: 'le-json-error' });
            this.jsonDetails = el('details', { class: 'le-json', ontoggle: () => { this.prefs.jsonOpen = this.jsonDetails.open; this.savePrefs(); } }, [
                el('summary', {}, [
                    el('span', { text: 'Prompt JSON' }),
                    el('span', { class: 'le-hint', text: ' (live; edit or paste a layout here to load it)' })
                ]),
                this.jsonText,
                el('div', { class: 'le-row' }, [
                    el('button', { class: 'le-btn', onclick: () => this.copyPrompt() }, 'Copy'),
                    this.jsonError
                ])
            ]);
            this.jsonDetails.open = !!this.prefs.jsonOpen;
            this.sceneLabel = el('div', { class: 'le-label' });
            let bottom = el('div', { class: 'le-bottom' }, [
                el('div', { class: 'le-scene' }, [this.sceneLabel, this.sceneCaption, this.metaChips]),
                el('div', { class: 'le-side' }, [
                    el('div', { class: 'le-label', text: 'Checks' }),
                    this.issuesList
                ]),
                this.jsonDetails
            ]);

            this.toastEl = el('div', { class: 'le-toast' });
            this.menuEl = null;
            r.appendChild(toolbar);
            r.appendChild(el('div', { class: 'le-main' }, [layers, center, this.inspector]));
            r.appendChild(bottom);
            r.appendChild(this.toastEl);

            this.resizeObserver = new ResizeObserver(() => this.layoutStage());
            this.resizeObserver.observe(this.stageWrap);
        }

        // ------------------------------------------------------------ rendering

        /** Refreshes every part of the editor from the model. */
        renderAll() {
            let m = this.model;
            let profile = LE.getFormat(m.formatId);
            this.formatSelect.value = profile.id;
            this.widthInput.value = m.width;
            this.heightInput.value = m.height;
            let aspect = LE.describeAspect(m.width, m.height);
            let presetDims = LE.ASPECTS.includes(aspect) ? LE.dimsForAspect(aspect, this.prefs.targetMp) : null;
            this.aspectSelect.value = presetDims && presetDims.width == m.width && presetDims.height == m.height ? aspect : 'custom';
            let mp = LE.megapixels(m);
            this.mpBadge.textContent = `${aspect} · ${mp.toFixed(2)} MP`;
            this.mpBadge.className = 'le-badge ' + (mp < 0.25 || mp > 4 ? 'le-bad' : (mp < 0.95 || mp > 2.1 ? 'le-warn' : 'le-ok'));
            this.snapToggle.querySelector('input').checked = !!this.prefs.snap;
            this.gridToggle.querySelector('input').checked = !!this.prefs.grid;
            this.underlayOpacity.value = this.prefs.underlayOpacity;
            this.underlayOpacity.style.display = this.underlay ? '' : 'none';
            this.underlayButton.textContent = this.underlay ? 'Underlay \u2715' : 'Underlay';
            this.underlayButton.title = this.underlay ? 'Remove the underlay image' : 'Show an image under the boxes to trace or compare';
            this.renderTypeButtons();
            if (document.activeElement != this.sceneCaption) {
                this.sceneCaption.value = m.scene.caption;
            }
            this.sceneCaption.placeholder = profile.scenePlaceholder;
            this.sceneLabel.textContent = profile.sceneLabel;
            this.renderMeta();
            this.layoutStage();
            this.renderLayers();
            this.renderInspector();
            this.renderOutput();
            this.undoButton.disabled = this.historyIndex <= 0;
            this.redoButton.disabled = this.historyIndex >= this.history.length - 1;
        }

        /** Renders the type buttons for new boxes, per the active format. */
        renderTypeButtons() {
            let profile = LE.getFormat(this.model.formatId);
            let types = profile.types(this.model);
            if (!types.find(t => t.id == this.drawType)) {
                this.drawType = 'object';
            }
            this.typeButtons.innerHTML = '';
            for (let t of types) {
                this.typeButtons.appendChild(el('button', {
                    class: `le-seg-btn le-type-${t.id}` + (t.id == this.drawType ? ' le-active' : ''),
                    title: `Draw ${t.label} boxes (${t.key.toUpperCase()})`,
                    onclick: () => { this.drawType = t.id; this.renderTypeButtons(); }
                }, [el('span', { class: 'le-type-dot' }), t.label]));
            }
        }

        /** Renders the meta tag chips and the custom tag input. */
        renderMeta() {
            let profile = LE.getFormat(this.model.formatId);
            let meta = this.model.scene.meta;
            this.metaChips.innerHTML = '';
            this.metaChips.appendChild(el('span', { class: 'le-hint', text: 'Meta:' }));
            let all = profile.metaSuggestions.slice();
            for (let m of meta) {
                if (!all.includes(m)) {
                    all.push(m);
                }
            }
            for (let m of all) {
                let on = meta.includes(m);
                this.metaChips.appendChild(el('button', {
                    class: 'le-chip' + (on ? ' le-active' : ''),
                    onclick: () => {
                        let i = this.model.scene.meta.indexOf(m);
                        if (i == -1) {
                            this.model.scene.meta.push(m);
                        }
                        else {
                            this.model.scene.meta.splice(i, 1);
                        }
                        this.renderMeta();
                        this.changed();
                    }
                }, m));
            }
            let add = el('input', {
                class: 'le-chip-input', placeholder: '+ add', title: 'Add a custom meta tag, then press Enter',
                onkeydown: e => {
                    if (e.key == 'Enter' && add.value.trim()) {
                        let v = add.value.trim();
                        if (!this.model.scene.meta.includes(v)) {
                            this.model.scene.meta.push(v);
                        }
                        this.renderMeta();
                        this.changed();
                        e.preventDefault();
                    }
                }
            });
            this.metaChips.appendChild(add);
        }

        /** Scales the canvas to fit its area, then redraws the boxes. */
        layoutStage() {
            let wrap = this.stageWrap;
            let availW = Math.max(50, wrap.clientWidth - 24);
            let availH = Math.max(50, wrap.clientHeight - 24);
            let m = this.model;
            this.scale = Math.min(availW / m.width, availH / m.height);
            this.stage.style.width = `${Math.round(m.width * this.scale)}px`;
            this.stage.style.height = `${Math.round(m.height * this.scale)}px`;
            this.stage.style.setProperty('--le-grid', `${GRID * this.scale}px`);
            this.renderBoxes();
        }

        /** Draws all visible boxes on the canvas, with handles on a single selected box. */
        renderBoxes() {
            let m = this.model;
            let layer = this.boxesLayer;
            layer.innerHTML = '';
            for (let index = 0; index < m.items.length; index++) {
                let item = m.items[index];
                if (!item.visible) {
                    continue;
                }
                let sel = this.isSelected(item.id);
                let box = el('div', {
                    class: `le-box le-type-${item.type}` + (sel ? ' le-selected' : '') + (item.locked ? ' le-locked' : ''),
                    'data-id': item.id
                });
                box.style.left = `${item.x * 100}%`;
                box.style.top = `${item.y * 100}%`;
                box.style.width = `${item.w * 100}%`;
                box.style.height = `${item.h * 100}%`;
                box.appendChild(el('div', { class: 'le-box-tag', text: `${index + 1} ${TYPE_LETTER[item.type] || '?'}` + (item.locked ? ' 🔒' : '') }));
                if (item.type == 'text' && item.text) {
                    let p = LE.itemPixels(m, item);
                    let fontImg = LE.clamp(LE.estimateFontPx(item.text, p.w, p.h) * 0.85, 4, 400);
                    box.appendChild(el('div', { class: 'le-box-text', text: item.text, style: { fontSize: `${Math.max(6, fontImg * this.scale)}px` } }));
                }
                else if (item.caption) {
                    box.appendChild(el('div', { class: 'le-box-caption', text: item.caption }));
                }
                else {
                    box.appendChild(el('div', { class: 'le-box-caption le-empty', text: 'Double-click to describe' }));
                }
                if (sel && this.selection.length == 1 && !item.locked) {
                    for (let dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
                        box.appendChild(el('div', { class: `le-handle le-h-${dir}`, 'data-dir': dir }));
                    }
                }
                layer.appendChild(box);
            }
        }

        /** Renders the layers list (order = order of items in the prompt). */
        renderLayers() {
            let list = this.layersList;
            list.innerHTML = '';
            if (!this.model.items.length) {
                list.appendChild(el('div', { class: 'le-hint le-pad', text: 'No boxes yet.' }));
                return;
            }
            for (let index = 0; index < this.model.items.length; index++) {
                let item = this.model.items[index];
                let row = el('div', {
                    class: 'le-layer' + (this.isSelected(item.id) ? ' le-active' : '') + (item.visible ? '' : ' le-hidden'),
                    draggable: 'true',
                    onclick: e => this.onLayerClick(e, item, index),
                    ondblclick: () => this.focusInspectorField(item),
                    ondragstart: e => { this.dragLayerId = item.id; e.dataTransfer.effectAllowed = 'move'; row.classList.add('le-dragging'); },
                    ondragend: () => row.classList.remove('le-dragging'),
                    ondragover: e => { e.preventDefault(); row.classList.add('le-dragover'); },
                    ondragleave: () => row.classList.remove('le-dragover'),
                    ondrop: e => { e.preventDefault(); row.classList.remove('le-dragover'); this.moveItemTo(this.dragLayerId, index); }
                }, [
                    el('span', { class: 'le-layer-num', text: String(index + 1) }),
                    el('span', { class: `le-type-dot le-type-${item.type}`, title: item.type }),
                    el('span', { class: 'le-layer-name', text: (item.type == 'text' && item.text ? `“${item.text.split('\n')[0]}” ` : '') + (item.caption || '(no caption)') }),
                    el('button', { class: 'le-mini', title: item.visible ? 'Hide (not exported)' : 'Show', onclick: e => { e.stopPropagation(); this.updateItem(item.id, { visible: !item.visible }); } }, item.visible ? '👁' : '–'),
                    el('button', { class: 'le-mini', title: item.locked ? 'Unlock' : 'Lock', onclick: e => { e.stopPropagation(); this.updateItem(item.id, { locked: !item.locked }); } }, item.locked ? '🔒' : '🔓')
                ]);
                list.appendChild(row);
            }
        }

        /** Layer click: Ctrl/Cmd toggles, Shift selects a range, plain click selects one. */
        onLayerClick(e, item, index) {
            if (e.ctrlKey || e.metaKey) {
                this.toggleSelect(item.id);
            }
            else if (e.shiftKey && this.selectedId) {
                let from = this.model.items.findIndex(i => i.id == this.selectedId);
                let lo = Math.min(from, index), hi = Math.max(from, index);
                let range = this.model.items.slice(lo, hi + 1).map(i => i.id).filter(id => id != this.selectedId);
                this.setSelection(range.concat([this.selectedId]));
            }
            else {
                this.select(item.id);
            }
        }

        /** Renders the inspector for the selection: help, one box, or several boxes. */
        renderInspector() {
            let ins = this.inspector;
            let item = this.selectedItem();
            let profile = LE.getFormat(this.model.formatId);
            ins.innerHTML = '';
            if (this.selection.length > 1) {
                this.renderMultiInspector(this.selectedItems());
                return;
            }
            if (!item) {
                ins.appendChild(el('div', { class: 'le-panel-title', text: 'Inspector' }));
                ins.appendChild(el('div', { class: 'le-help' }, [
                    el('p', { text: 'Drag on the canvas to draw a box of the selected type, or click + Add.' }),
                    el('table', { class: 'le-keys' }, [
                        ['T / O / C', 'Text / Object / Character type'],
                        ['N', 'Add a box of the selected type'],
                        ['Ctrl+click', 'Select several boxes'],
                        ['Ctrl-drag', 'Select boxes inside a rectangle'],
                        ['Ctrl+A', 'Select all boxes'],
                        ['Double-click', 'Edit a box on the canvas'],
                        ['Arrows', 'Nudge 1 px (Shift: 16 px)'],
                        ['Shift-drag', 'Draw over existing boxes (or lock the box below)'],
                        ['Alt-drag', 'Duplicate a box; Alt while dragging: no snapping'],
                        ['Shift+T / O / C', 'Change the selected boxes\' type'],
                        ['Ctrl+D', 'Duplicate'],
                        ['Delete', 'Delete the selected boxes'],
                        ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
                        ['Ctrl+Enter', this.host.canGenerate ? 'Generate' : this.host.applyLabel],
                        ['Esc', 'Deselect / leave a field']
                    ].map(kv => el('tr', {}, [el('td', {}, [el('kbd', { text: kv[0] })]), el('td', { text: kv[1] })])))
                ]));
                return;
            }
            let index = this.model.items.indexOf(item);
            ins.appendChild(el('div', { class: 'le-panel-title', text: `Box #${index + 1}` }));
            let types = profile.types(this.model);
            let seg = el('div', { class: 'le-seg le-full' });
            for (let t of types) {
                seg.appendChild(el('button', {
                    class: `le-seg-btn le-type-${t.id}` + (item.type == t.id ? ' le-active' : ''),
                    onclick: () => { this.updateItem(item.id, { type: t.id }); this.renderInspector(); }
                }, [el('span', { class: 'le-type-dot' }), t.label]));
            }
            if (!types.find(t => t.id == item.type)) {
                seg.appendChild(el('span', { class: 'le-hint', text: `(${item.type}: exported as ${profile.typeForExport(this.model, item)})` }));
            }
            ins.appendChild(el('div', { class: 'le-label', text: 'Type' }));
            ins.appendChild(seg);
            let fields = profile.itemFields(item.type);
            if (fields.includes('text')) {
                ins.appendChild(el('div', { class: 'le-label', text: 'Text to render' }));
                let ta = el('textarea', {
                    class: 'le-textarea le-field-text', rows: 3, placeholder: profile.textPlaceholder,
                    oninput: () => { item.text = ta.value; this.changed(true, { skipInspector: true }); },
                    onkeydown: e => this.fieldKeys(e, false)
                });
                ta.value = item.text;
                ins.appendChild(ta);
            }
            ins.appendChild(el('div', { class: 'le-label', text: item.type == 'text' ? 'Caption (how the text looks)' : 'Caption' }));
            let cap = el('textarea', {
                class: 'le-textarea le-field-caption', rows: 4, placeholder: profile.placeholder(item.type),
                oninput: () => { item.caption = cap.value; this.changed(true, { skipInspector: true }); },
                onkeydown: e => this.fieldKeys(e, true)
            });
            cap.value = item.caption;
            ins.appendChild(cap);
            ins.appendChild(el('div', { class: 'le-label', text: 'Position and size (px, from top-left)' }));
            let p = LE.itemPixels(this.model, item);
            let geo = el('div', { class: 'le-geo' });
            let mk = (label, key, value) => {
                let input = el('input', {
                    class: 'le-num', type: 'number', step: 1, value: value, 'data-geo': key,
                    onchange: () => this.onGeoInput(item.id)
                });
                return el('label', { class: 'le-geo-field' }, [el('span', { text: label }), input]);
            };
            geo.appendChild(mk('X', 'x', p.x1));
            geo.appendChild(mk('Y', 'y', p.y1));
            geo.appendChild(mk('W', 'w', p.w));
            geo.appendChild(mk('H', 'h', p.h));
            ins.appendChild(geo);
            ins.appendChild(el('div', { class: 'le-row le-wrap' }, [
                el('button', { class: 'le-btn', title: 'Duplicate (Ctrl+D)', onclick: () => this.duplicateSelected() }, 'Duplicate'),
                el('button', { class: 'le-btn', title: 'Move earlier in the prompt', onclick: () => this.moveItemTo(item.id, index - 1) }, '↑'),
                el('button', { class: 'le-btn', title: 'Move later in the prompt', onclick: () => this.moveItemTo(item.id, index + 1) }, '↓'),
                el('button', { class: 'le-btn', onclick: () => this.updateItem(item.id, { locked: !item.locked }) }, item.locked ? 'Unlock' : 'Lock'),
                el('button', { class: 'le-btn le-danger', title: 'Delete (Del)', onclick: () => this.deleteSelected() }, 'Delete')
            ]));
        }

        /** Inspector for several boxes: type, align, distribute, size and group actions. */
        renderMultiInspector(items) {
            let ins = this.inspector;
            let profile = LE.getFormat(this.model.formatId);
            ins.appendChild(el('div', { class: 'le-panel-title', text: `${items.length} boxes selected` }));
            ins.appendChild(el('div', { class: 'le-hint', text: 'Drag any of them to move them together. Ctrl+click a box to add or remove it.' }));
            ins.appendChild(el('div', { class: 'le-label', text: 'Type' }));
            let seg = el('div', { class: 'le-seg le-full' });
            for (let t of profile.types(this.model)) {
                let all = items.every(i => i.type == t.id);
                seg.appendChild(el('button', {
                    class: `le-seg-btn le-type-${t.id}` + (all ? ' le-active' : ''),
                    title: `Make all selected boxes ${t.label}`,
                    onclick: () => { for (let i of items) { i.type = t.id; } this.changed(); }
                }, [el('span', { class: 'le-type-dot' }), t.label]));
            }
            ins.appendChild(seg);
            let btn = (label, title, fn, disabled) => el('button', { class: 'le-btn', title: title, disabled: disabled ? 'disabled' : null, onclick: fn }, label);
            ins.appendChild(el('div', { class: 'le-label', text: 'Align (to the selection)' }));
            ins.appendChild(el('div', { class: 'le-align-grid' }, [
                btn('Left', 'Align left edges', () => this.align('left')),
                btn('Center', 'Align horizontal centers', () => this.align('hcenter')),
                btn('Right', 'Align right edges', () => this.align('right')),
                btn('Top', 'Align top edges', () => this.align('top')),
                btn('Middle', 'Align vertical centers', () => this.align('vcenter')),
                btn('Bottom', 'Align bottom edges', () => this.align('bottom'))
            ]));
            ins.appendChild(el('div', { class: 'le-label', text: 'Distribute and size' }));
            ins.appendChild(el('div', { class: 'le-align-grid' }, [
                btn('Space H', 'Equal horizontal gaps (3+ boxes)', () => this.distribute('x'), items.length < 3),
                btn('Space V', 'Equal vertical gaps (3+ boxes)', () => this.distribute('y'), items.length < 3),
                btn('Center on canvas', 'Center the group on the canvas', () => this.centerGroup()),
                btn('Same width', 'Give all the width of the last selected box', () => this.matchSize('w')),
                btn('Same height', 'Give all the height of the last selected box', () => this.matchSize('h'))
            ]));
            let anyLocked = items.some(i => i.locked);
            let anyHidden = items.some(i => !i.visible);
            ins.appendChild(el('div', { class: 'le-row le-wrap' }, [
                btn('Duplicate', 'Duplicate (Ctrl+D)', () => this.duplicateSelected()),
                btn(anyLocked ? 'Unlock all' : 'Lock all', '', () => { for (let i of items) { i.locked = !anyLocked; } this.changed(); }),
                btn(anyHidden ? 'Show all' : 'Hide all', 'Hidden boxes are not exported', () => { for (let i of items) { i.visible = anyHidden; } this.changed(); }),
                el('button', { class: 'le-btn le-danger', title: 'Delete (Del)', onclick: () => this.deleteSelected() }, 'Delete')
            ]));
        }

        /** Pixel rectangles of the selected, unlocked boxes plus their bounding box. */
        groupRects() {
            let m = this.model;
            let rects = this.selectedItems().filter(i => !i.locked).map(i => ({ item: i, p: LE.itemPixels(m, i) }));
            if (!rects.length) {
                return null;
            }
            return {
                rects: rects,
                x1: Math.min(...rects.map(r => r.p.x1)), y1: Math.min(...rects.map(r => r.p.y1)),
                x2: Math.max(...rects.map(r => r.p.x2)), y2: Math.max(...rects.map(r => r.p.y2))
            };
        }

        /** Aligns the selected unlocked boxes to an edge or center of their bounding box. */
        align(mode) {
            let g = this.groupRects();
            if (!g) {
                return;
            }
            for (let r of g.rects) {
                let x = r.p.x1, y = r.p.y1;
                if (mode == 'left') { x = g.x1; }
                if (mode == 'right') { x = g.x2 - r.p.w; }
                if (mode == 'hcenter') { x = Math.round((g.x1 + g.x2 - r.p.w) / 2); }
                if (mode == 'top') { y = g.y1; }
                if (mode == 'bottom') { y = g.y2 - r.p.h; }
                if (mode == 'vcenter') { y = Math.round((g.y1 + g.y2 - r.p.h) / 2); }
                LE.setItemPixels(this.model, r.item, x, y, r.p.w, r.p.h);
            }
            this.changed();
        }

        /** Spaces the selected unlocked boxes evenly along one axis ('x' or 'y'). */
        distribute(axis) {
            let g = this.groupRects();
            if (!g || g.rects.length < 3) {
                return;
            }
            let lo = axis == 'x' ? 'x1' : 'y1', size = axis == 'x' ? 'w' : 'h';
            let sorted = g.rects.slice().sort((a, b) => a.p[lo] - b.p[lo]);
            let span = (axis == 'x' ? g.x2 - g.x1 : g.y2 - g.y1);
            let used = sorted.reduce((s, r) => s + r.p[size], 0);
            let gap = (span - used) / (sorted.length - 1);
            let pos = axis == 'x' ? g.x1 : g.y1;
            for (let r of sorted) {
                let v = Math.round(pos);
                LE.setItemPixels(this.model, r.item, axis == 'x' ? v : r.p.x1, axis == 'x' ? r.p.y1 : v, r.p.w, r.p.h);
                pos += r.p[size] + gap;
            }
            this.changed();
        }

        /** Centers the selected unlocked boxes, as a group, on the canvas. */
        centerGroup() {
            let g = this.groupRects();
            if (!g) {
                return;
            }
            let dx = Math.round((this.model.width - (g.x2 - g.x1)) / 2) - g.x1;
            let dy = Math.round((this.model.height - (g.y2 - g.y1)) / 2) - g.y1;
            for (let r of g.rects) {
                LE.setItemPixels(this.model, r.item, r.p.x1 + dx, r.p.y1 + dy, r.p.w, r.p.h);
            }
            this.changed();
        }

        /** Gives the selected boxes the width ('w') or height ('h') of the primary selected box. */
        matchSize(dim) {
            let g = this.groupRects();
            let ref = this.model.items.find(i => i.id == this.selectedId);
            if (!g || !ref) {
                return;
            }
            let rp = LE.itemPixels(this.model, ref);
            for (let r of g.rects) {
                LE.setItemPixels(this.model, r.item, r.p.x1, r.p.y1, dim == 'w' ? rp.w : r.p.w, dim == 'h' ? rp.h : r.p.h);
            }
            this.changed();
        }

        /** Adds a box of the given (or current) type in a free spot near the center, then edits it. */
        addBox(type) {
            type = type || this.drawType;
            let m = this.model;
            let w = Math.max(GRID, Math.round(m.width * 0.4 / GRID) * GRID);
            let h = Math.max(GRID, Math.round(m.height * (type == 'text' ? 0.12 : 0.3) / GRID) * GRID);
            let x = Math.round((m.width - w) / 2 / GRID) * GRID;
            let y = Math.round((m.height - h) / 2 / GRID) * GRID;
            let taken = (px, py) => m.items.some(it => {
                let p = LE.itemPixels(m, it);
                return it.visible && Math.abs(p.x1 - px) < 8 && Math.abs(p.y1 - py) < 8;
            });
            for (let k = 0; k < 40 && taken(x, y); k++) {
                x += 2 * GRID;
                y += 2 * GRID;
                if (x + w > m.width || y + h > m.height) {
                    x = GRID * (k % 8);
                    y = GRID * (k % 8);
                }
            }
            let item = LE.newItem(type, 0, 0, 0, 0);
            LE.setItemPixels(m, item, x, y, w, h);
            m.items.push(item);
            this.selectedId = item.id;
            this.changed();
            this.focusInspectorField(item);
        }

        /** Refreshes the X/Y/W/H fields of the inspector without rebuilding it. */
        updateInspectorGeometry() {
            let item = this.selectedItem();
            if (!item) {
                return;
            }
            let p = LE.itemPixels(this.model, item);
            let vals = { x: p.x1, y: p.y1, w: p.w, h: p.h };
            for (let input of this.inspector.querySelectorAll('[data-geo]')) {
                if (document.activeElement != input) {
                    input.value = vals[input.dataset.geo];
                }
            }
        }

        /** Refreshes the prompt JSON panel and the list of checks. */
        renderOutput() {
            let prompt = this.getPrompt();
            if (document.activeElement != this.jsonText) {
                this.jsonText.value = prompt;
                this.jsonError.textContent = '';
            }
            let issues = LE.validate(this.model, { swarm: this.host.mode == 'swarm' });
            this.issuesList.innerHTML = '';
            let counts = { error: 0, warning: 0, info: 0 };
            for (let issue of issues) {
                counts[issue.level]++;
                this.issuesList.appendChild(el('div', {
                    class: `le-issue le-${issue.level}` + (issue.itemId ? ' le-clickable' : ''),
                    onclick: issue.itemId ? () => this.select(issue.itemId) : null
                }, [el('span', { class: 'le-issue-icon', text: issue.level == 'error' ? '✖' : issue.level == 'warning' ? '⚠' : 'ℹ' }), issue.message]));
            }
            if (!issues.length) {
                this.issuesList.appendChild(el('div', { class: 'le-issue le-ok', text: '✔ No problems found.' }));
            }
            this.applyButton.classList.toggle('le-has-errors', counts.error > 0);
        }

        /** Renders the thumbnails of generated results. */
        renderResults() {
            if (!this.resultsStrip) {
                return;
            }
            this.resultsStrip.innerHTML = '';
            if (!this.results.length) {
                this.resultsStrip.appendChild(el('div', { class: 'le-hint le-pad', text: 'Results appear here. Click one to show it under the boxes.' }));
                return;
            }
            for (let r of this.results) {
                let img = el('img', {
                    class: 'le-thumb' + (this.underlay == r.src ? ' le-active' : ''),
                    src: r.src, title: (r.seed != null ? `Seed ${r.seed}. ` : '') + 'Click: show under the boxes. Double-click: open full size.',
                    onclick: () => this.setUnderlay(this.underlay == r.src ? null : r.src),
                    ondblclick: () => window.open(r.src, '_blank')
                });
                this.resultsStrip.appendChild(img);
            }
        }

        // ------------------------------------------------------------ state changes

        /** The selected box when exactly one is selected, otherwise null. */
        selectedItem() {
            if (this.selection.length != 1) {
                return null;
            }
            return this.model.items.find(i => i.id == this.selection[0]) || null;
        }

        /** Selects exactly one box, or clears the selection when given null. */
        select(id) {
            if (id ? (this.selection.length == 1 && this.selection[0] == id) : this.selection.length == 0) {
                return;
            }
            this.setSelection(id ? [id] : []);
        }

        /** Call after any model change. `typing` debounces the history entry. */
        changed(typing, opts) {
            opts = opts || {};
            this.renderBoxes();
            this.renderLayers();
            if (!opts.skipInspector) {
                this.renderInspector();
            }
            this.renderOutput();
            if (typing) {
                clearTimeout(this.commitTimer);
                this.commitTimer = setTimeout(() => this.commit(), 500);
            }
            else {
                this.commit();
            }
        }

        /** Records an undo step (if the model changed) and autosaves. */
        commit() {
            clearTimeout(this.commitTimer);
            let snap = JSON.stringify(this.model);
            if (snap == this.history[this.historyIndex]) {
                return;
            }
            this.history.length = this.historyIndex + 1;
            this.history.push(snap);
            if (this.history.length > 200) {
                this.history.shift();
            }
            this.historyIndex = this.history.length - 1;
            storageSet(STORAGE_AUTOSAVE, this.model);
            this.undoButton.disabled = this.historyIndex <= 0;
            this.redoButton.disabled = true;
        }

        /** Loads a model snapshot from the undo history. */
        restore(snap) {
            this.model = LE.normalizeModel(JSON.parse(snap));
            this.selection = this.selection.filter(id => this.model.items.some(i => i.id == id));
            storageSet(STORAGE_AUTOSAVE, this.model);
            this.renderAll();
        }

        /** Steps back one change. */
        undo() {
            this.commit();
            if (this.historyIndex > 0) {
                this.historyIndex--;
                this.restore(this.history[this.historyIndex]);
            }
        }

        /** Steps forward one change. */
        redo() {
            if (this.historyIndex < this.history.length - 1) {
                this.historyIndex++;
                this.restore(this.history[this.historyIndex]);
            }
        }

        /** Applies a partial change to one box and records it. */
        updateItem(id, patch) {
            let item = this.model.items.find(i => i.id == id);
            if (!item) {
                return;
            }
            Object.assign(item, patch);
            this.changed();
        }

        /** Moves a box to another position in the layer order. */
        moveItemTo(id, newIndex) {
            let items = this.model.items;
            let from = items.findIndex(i => i.id == id);
            if (from == -1) {
                return;
            }
            newIndex = LE.clamp(newIndex, 0, items.length - 1);
            if (from == newIndex) {
                return;
            }
            let [it] = items.splice(from, 1);
            items.splice(newIndex, 0, it);
            this.changed();
        }

        /** Copies each selected box (inserted right after its original); the copies become the selection. */
        cloneSelection(offsetPx) {
            let items = this.model.items;
            let sel = this.selectedItems();
            let copies = [];
            for (let k = sel.length - 1; k >= 0; k--) {
                let copy = Object.assign(LE.cloneModel(sel[k]), { id: LE.uid(), locked: false });
                if (offsetPx) {
                    copy.x = LE.clamp(copy.x + offsetPx / this.model.width, 0, 1 - copy.w);
                    copy.y = LE.clamp(copy.y + offsetPx / this.model.height, 0, 1 - copy.h);
                }
                items.splice(items.indexOf(sel[k]) + 1, 0, copy);
                copies.unshift(copy);
            }
            this.selection = copies.map(c => c.id);
            return copies;
        }

        /** Duplicates the selected boxes, offset by one grid step. */
        duplicateSelected() {
            if (!this.selection.length) {
                return;
            }
            this.cloneSelection(GRID);
            this.changed();
        }

        /** Deletes the selected boxes. */
        deleteSelected() {
            let sel = this.selectedItems();
            if (!sel.length) {
                return;
            }
            let firstIdx = this.model.items.indexOf(sel[0]);
            this.model.items = this.model.items.filter(i => !this.selection.includes(i.id));
            let next = this.model.items[Math.min(firstIdx, this.model.items.length - 1)];
            this.selectedId = next && sel.length == 1 ? next.id : null;
            this.changed();
        }

        /** Switches the output format; box data is kept. */
        changeFormat(id) {
            this.model.formatId = id;
            this.renderAll();
            this.commit();
        }

        /** Applies an aspect ratio preset at the chosen target size. */
        onAspectChange() {
            let a = this.aspectSelect.value;
            if (a == 'custom') {
                return;
            }
            let d = LE.dimsForAspect(a, this.prefs.targetMp);
            this.setSize(d.width, d.height);
        }

        /** Applies the width/height typed in the toolbar (rounded to multiples of 16). */
        onSizeInput() {
            let w = LE.clamp(LE.round16(parseInt(this.widthInput.value) || this.model.width), 256, 4096);
            let h = LE.clamp(LE.round16(parseInt(this.heightInput.value) || this.model.height), 256, 4096);
            this.setSize(w, h);
        }

        /** Applies the X/Y/W/H typed in the inspector. */
        onGeoInput(id) {
            let item = this.model.items.find(i => i.id == id);
            if (!item) {
                return;
            }
            let vals = {};
            for (let input of this.inspector.querySelectorAll('[data-geo]')) {
                vals[input.dataset.geo] = parseInt(input.value) || 0;
            }
            LE.setItemPixels(this.model, item, vals.x, vals.y, Math.max(1, vals.w), Math.max(1, vals.h));
            this.changed(false, { skipInspector: true });
            this.updateInspectorGeometry();
        }

        /** Imports JSON edited in the prompt panel, shortly after typing stops. */
        onJsonInput() {
            clearTimeout(this.jsonTimer);
            this.jsonTimer = setTimeout(() => {
                let text = this.jsonText.value;
                if (text == this.getPrompt()) {
                    this.jsonError.textContent = '';
                    return;
                }
                let profile = LE.getFormat(this.model.formatId);
                try {
                    let res = profile.importPrompt(text, this.model);
                    this.model = res.model;
                    this.selectedId = null;
                    this.jsonError.textContent = res.notes.join(' ');
                    this.jsonError.classList.remove('le-bad');
                    this.renderAll();
                    this.commit();
                }
                catch (e) {
                    this.jsonError.textContent = 'Not applied: ' + e.message;
                    this.jsonError.classList.add('le-bad');
                }
            }, 600);
        }

        /** Saves editor preferences (snap, grid, sizes, panel state). */
        savePrefs() {
            storageSet(STORAGE_PREFS, this.prefs);
        }

        // ------------------------------------------------------------ underlay

        /** Loads an image file as the underlay. */
        loadUnderlayFile(file) {
            if (!file) {
                return;
            }
            let reader = new FileReader();
            reader.onload = () => this.setUnderlay(reader.result);
            reader.readAsDataURL(file);
            this.underlayInput.value = '';
        }

        /** Shows an image under the boxes, or removes it when given null. */
        setUnderlay(src) {
            this.underlay = src || null;
            if (this.underlay) {
                this.underlayImg.src = this.underlay;
                this.underlayImg.style.display = 'block';
            }
            else {
                this.underlayImg.removeAttribute('src');
                this.underlayImg.style.display = 'none';
            }
            this.applyUnderlayOpacity();
            this.underlayOpacity.style.display = this.underlay ? '' : 'none';
            this.underlayButton.textContent = this.underlay ? 'Underlay \u2715' : 'Underlay';
            this.underlayButton.title = this.underlay ? 'Remove the underlay image' : 'Show an image under the boxes to trace or compare';
            this.renderResults();
        }

        /** Applies the underlay opacity preference. */
        applyUnderlayOpacity() {
            this.underlayImg.style.opacity = this.prefs.underlayOpacity;
        }

        // ------------------------------------------------------------ actions

        /** Apply/Copy button: hands the prompt to the host. */
        doApply() {
            this.commit();
            this.host.onApply(this.getPrompt(), this.model);
        }

        /** Generate button: hands the prompt to the host for generation. */
        doGenerate() {
            if (!this.host.canGenerate || this.generating) {
                return;
            }
            this.commit();
            this.host.onGenerate(this.getPrompt(), this.model);
        }

        /** Copies the prompt to the clipboard, with a fallback for non-secure pages. */
        copyPrompt() {
            let text = this.getPrompt();
            let done = () => this.toast('Prompt copied to the clipboard.');
            let fallback = () => {
                let ta = el('textarea', { style: { position: 'fixed', left: '-9999px' } });
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                let ok = false;
                try {
                    ok = document.execCommand('copy');
                }
                catch (e) {
                    ok = false;
                }
                ta.remove();
                if (ok) {
                    done();
                }
                else {
                    this.toast('Copy failed: select the JSON below and copy it manually.', true);
                    this.jsonDetails.open = true;
                }
            };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(done, fallback);
            }
            else {
                fallback();
            }
        }

        /** Shows a short message at the bottom of the editor. */
        toast(message, bad) {
            this.toastEl.textContent = message;
            this.toastEl.classList.toggle('le-bad', !!bad);
            this.toastEl.classList.add('le-show');
            clearTimeout(this.toastTimer);
            this.toastTimer = setTimeout(() => this.toastEl.classList.remove('le-show'), bad ? 6000 : 3000);
        }

        // ------------------------------------------------------------ menus

        /** Closes the open dropdown menu, if any. */
        closeMenu() {
            if (this.menuEl) {
                this.menuEl.remove();
                this.menuEl = null;
                document.removeEventListener('pointerdown', this.menuCloser, true);
            }
        }

        /** Opens a dropdown menu under `anchor` with the given entries. */
        openMenu(anchor, entries) {
            this.closeMenu();
            let menu = el('div', { class: 'le-menu' });
            for (let entry of entries) {
                if (entry == '-') {
                    menu.appendChild(el('div', { class: 'le-menu-sep' }));
                    continue;
                }
                if (entry.header) {
                    menu.appendChild(el('div', { class: 'le-menu-header', text: entry.header }));
                    continue;
                }
                if (entry.node) {
                    menu.appendChild(entry.node);
                    continue;
                }
                menu.appendChild(el('div', { class: 'le-menu-row' }, [
                    el('button', { class: 'le-menu-item', onclick: () => { this.closeMenu(); entry.action(); } }, entry.label),
                    entry.side ? el('button', { class: 'le-menu-side', title: entry.sideTitle, onclick: () => { this.closeMenu(); entry.side(); } }, entry.sideLabel) : null
                ]));
            }
            let rect = anchor.getBoundingClientRect();
            let rootRect = this.root.getBoundingClientRect();
            menu.style.left = `${rect.left - rootRect.left}px`;
            menu.style.top = `${rect.bottom - rootRect.top + 4}px`;
            this.root.appendChild(menu);
            this.menuEl = menu;
            this.menuCloser = e => {
                if (!menu.contains(e.target) && e.target != anchor) {
                    this.closeMenu();
                }
            };
            setTimeout(() => document.addEventListener('pointerdown', this.menuCloser, true), 0);
        }

        /** Layouts menu: new, save, export, import, and saved layouts. */
        openLayoutsMenu(e) {
            let saved = storageGet(STORAGE_SAVED, {});
            let names = Object.keys(saved).sort((a, b) => a.localeCompare(b));
            let entries = [
                { label: 'New layout', action: () => this.newLayout() },
                { label: 'Save as…', action: () => this.saveAs() },
                '-',
                { label: 'Export .json file', action: () => this.exportFile() },
                { label: 'Import .json file…', action: () => this.importFile() }
            ];
            if (names.length) {
                entries.push('-');
                entries.push({ header: 'Saved layouts' });
                for (let name of names) {
                    entries.push({
                        label: name, action: () => this.loadSaved(name),
                        side: () => this.deleteSaved(name), sideLabel: '✕', sideTitle: `Delete "${name}"`
                    });
                }
            }
            this.openMenu(e.currentTarget, entries);
        }

        /** Options menu: format options and output options. */
        openOptionsMenu(e) {
            let m = this.model;
            let entries = [];
            let check = (label, title, value, onChange) => el('label', { class: 'le-menu-check', title: title }, [
                el('input', { type: 'checkbox', checked: value ? 'checked' : null, onchange: ev => onChange(ev.target.checked) }), label
            ]);
            if (m.formatId == 'moss') {
                entries.push({ header: 'MOSS-Image' });
                entries.push({ node: check('Character type', 'Adds a Character box type. The "character" label comes from ComfyUI\'s MOSS-Image Layout Prompt node, not the official MOSS spec.', m.options.characterType, v => { m.options.characterType = v; this.renderAll(); this.commit(); }) });
                let canvasInput = el('input', { class: 'le-input', value: m.scene.canvas || 'single', onchange: ev => { m.scene.canvas = ev.target.value.trim() || 'single'; this.changed(); } });
                entries.push({ node: el('label', { class: 'le-menu-check', title: 'summary.canvas value. Leave as "single" unless you know the model accepts another value.' }, ['Canvas mode ', canvasInput]) });
            }
            entries.push({ header: 'Output' });
            entries.push({ node: check('Compact JSON', 'One line, fewer tokens. Uncheck for indented JSON.', m.options.compactJson, v => { m.options.compactJson = v; this.changed(); }) });
            this.openMenu(e.currentTarget, entries);
        }

        /** Starts an empty layout with the same size and options. */
        newLayout() {
            if (this.model.items.length && !window.confirm('Start a new layout? The current one stays in undo history.')) {
                return;
            }
            let fresh = LE.newModel(this.model.formatId);
            fresh.width = this.model.width;
            fresh.height = this.model.height;
            fresh.options = Object.assign({}, this.model.options);
            this.model = fresh;
            this.selectedId = null;
            this.renderAll();
            this.commit();
        }

        /** Saves the layout under a name in browser storage. */
        saveAs() {
            let name = window.prompt('Name for this layout:', this.lastSavedName || '');
            if (!name || !name.trim()) {
                return;
            }
            let saved = storageGet(STORAGE_SAVED, {});
            if (saved[name.trim()] && !window.confirm(`Replace the saved layout "${name.trim()}"?`)) {
                return;
            }
            saved[name.trim()] = this.model;
            storageSet(STORAGE_SAVED, saved);
            this.lastSavedName = name.trim();
            this.toast(`Saved "${name.trim()}".`);
        }

        /** Loads a layout saved under a name. */
        loadSaved(name) {
            let saved = storageGet(STORAGE_SAVED, {});
            if (!saved[name]) {
                return;
            }
            this.model = LE.normalizeModel(saved[name]);
            this.selectedId = null;
            this.lastSavedName = name;
            this.renderAll();
            this.commit();
        }

        /** Deletes a layout saved under a name. */
        deleteSaved(name) {
            if (!window.confirm(`Delete the saved layout "${name}"?`)) {
                return;
            }
            let saved = storageGet(STORAGE_SAVED, {});
            delete saved[name];
            storageSet(STORAGE_SAVED, saved);
        }

        /** Downloads the layout (model and prompt) as a .json file. */
        exportFile() {
            let data = JSON.stringify({ layoutEditor: 1, model: this.model, prompt: this.getPrompt() }, null, 2);
            let blob = new Blob([data], { type: 'application/json' });
            let a = el('a', { href: URL.createObjectURL(blob), download: `${(this.lastSavedName || 'layout').replace(/[^\w.-]+/g, '_')}.json` });
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        }

        /** Loads a layout from a .json file: an editor export or a prompt JSON. */
        importFile() {
            let input = el('input', { type: 'file', accept: '.json,application/json,.txt' });
            input.onchange = () => {
                let file = input.files[0];
                if (!file) {
                    return;
                }
                file.text().then(text => {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(text);
                    }
                    catch (e) {
                        parsed = null;
                    }
                    if (parsed && parsed.layoutEditor && parsed.model) {
                        this.model = LE.normalizeModel(parsed.model);
                        this.selectedId = null;
                        this.renderAll();
                        this.commit();
                        this.toast(`Loaded ${file.name}.`);
                    }
                    else if (!this.importPrompt(text)) {
                        this.toast(`${file.name} is not a layout this editor recognizes.`, true);
                    }
                });
            };
            input.click();
        }

        /** Selects a box and puts the cursor in its main field (text for text boxes, caption otherwise). */
        focusInspectorField(item) {
            this.select(item.id);
            let field = this.inspector.querySelector(item.type == 'text' ? '.le-field-text' : '.le-field-caption');
            if (field) {
                field.focus();
                field.setSelectionRange(field.value.length, field.value.length);
            }
        }

        /** Enter in a caption commits and returns to the canvas; Esc always returns to the canvas. */
        fieldKeys(e, enterCommits) {
            if (e.key == 'Escape' || (enterCommits && e.key == 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey)) {
                e.preventDefault();
                e.stopPropagation();
                this.commit();
                this.focus();
            }
        }

        // ------------------------------------------------------------ keyboard

        /** Registers the keyboard shortcuts (active only while the host says the editor is active). */
        bindGlobalKeys() {
            this.keyHandler = e => {
                if (!this.root.isConnected || !this.host.isActive()) {
                    return;
                }
                let typing = isTypingTarget(e.target);
                let insideEditor = this.root.contains(e.target) || e.target == document.body;
                let ctrl = e.ctrlKey || e.metaKey;
                if (ctrl && e.key == 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (document.activeElement && document.activeElement.classList.contains('le-inline-edit')) {
                        document.activeElement.blur();
                    }
                    if (this.host.canGenerate) {
                        this.doGenerate();
                    }
                    else {
                        this.doApply();
                    }
                    return;
                }
                if (typing || !insideEditor) {
                    return;
                }
                let key = e.key.toLowerCase();
                if (ctrl && key == 'z') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.shiftKey) {
                        this.redo();
                    }
                    else {
                        this.undo();
                    }
                    return;
                }
                if (ctrl && key == 'y') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.redo();
                    return;
                }
                if (ctrl && key == 'd') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.duplicateSelected();
                    return;
                }
                if (ctrl && key == 'a') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.selectAll();
                    return;
                }
                if (ctrl || e.altKey) {
                    return;
                }
                if (key == 'n' || key == '+') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.addBox();
                    return;
                }
                let types = LE.getFormat(this.model.formatId).types(this.model);
                let t = types.find(t => t.key == key);
                if (t) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.drawType = t.id;
                    this.renderTypeButtons();
                    if (e.shiftKey && this.selection.length) {
                        for (let it of this.selectedItems()) {
                            it.type = t.id;
                        }
                        this.changed();
                    }
                    return;
                }
                if (key == 'delete' || key == 'backspace') {
                    if (this.selection.length) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.deleteSelected();
                    }
                    return;
                }
                if (key == 'escape') {
                    if (this.selection.length) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.select(null);
                    }
                    return;
                }
                if (key == 'enter') {
                    let item = this.selectedItem();
                    if (item) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.focusInspectorField(item);
                    }
                    return;
                }
                let arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
                if (arrows[key]) {
                    let movable = this.selectedItems().filter(i => !i.locked);
                    if (!movable.length) {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    let step = e.shiftKey ? GRID : 1;
                    for (let item of movable) {
                        let p = LE.itemPixels(this.model, item);
                        LE.setItemPixels(this.model, item, p.x1 + arrows[key][0] * step, p.y1 + arrows[key][1] * step, p.w, p.h);
                    }
                    this.renderBoxes();
                    this.updateInspectorGeometry();
                    this.renderOutput();
                    clearTimeout(this.commitTimer);
                    this.commitTimer = setTimeout(() => this.commit(), 400);
                }
            };
            document.addEventListener('keydown', this.keyHandler, true);
        }

        // ------------------------------------------------------------ pointer: draw, move, resize

        /** Converts a pointer position to canvas pixel coordinates. */
        clientToImage(e) {
            let rect = this.stage.getBoundingClientRect();
            return {
                x: (e.clientX - rect.left) / this.scale,
                y: (e.clientY - rect.top) / this.scale
            };
        }

        /** Snap candidates along one axis: canvas edges and center, plus other boxes' edges and centers. */
        snapTargets(axis, excludeId) {
            let m = this.model;
            let size = axis == 'x' ? m.width : m.height;
            let t = [0, size / 2, size];
            let exclude = Array.isArray(excludeId) ? excludeId : [excludeId];
            for (let it of m.items) {
                if (exclude.includes(it.id) || !it.visible) {
                    continue;
                }
                let p = LE.itemPixels(m, it);
                if (axis == 'x') {
                    t.push(p.x1, p.x2, (p.x1 + p.x2) / 2);
                }
                else {
                    t.push(p.y1, p.y2, (p.y1 + p.y2) / 2);
                }
            }
            return t;
        }

        /**
         * Snaps a set of candidate values on one axis (e.g. left, center, right of a moving box).
         * Returns { delta, guide } where delta is the correction to apply (image px).
         */
        snapAxis(values, axis, excludeId, noSnap) {
            if (noSnap) {
                return { delta: 0, guide: null };
            }
            let threshold = SNAP_SCREEN_PX / this.scale;
            let best = null;
            if (this.prefs.snap) {
                for (let target of this.snapTargets(axis, excludeId)) {
                    for (let v of values) {
                        let d = target - v;
                        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) {
                            best = { delta: d, guide: target };
                        }
                    }
                }
            }
            if (best) {
                return best;
            }
            if (this.prefs.grid) {
                let v = values[0];
                return { delta: Math.round(v / GRID) * GRID - v, guide: null };
            }
            return { delta: 0, guide: null };
        }

        /** Shows the snapping guide lines (or hides them when given null). */
        showGuides(gx, gy) {
            this.guidesLayer.innerHTML = '';
            if (gx != null) {
                this.guidesLayer.appendChild(el('div', { class: 'le-guide le-guide-v', style: { left: `${gx * this.scale}px` } }));
            }
            if (gy != null) {
                this.guidesLayer.appendChild(el('div', { class: 'le-guide le-guide-h', style: { top: `${gy * this.scale}px` } }));
            }
        }

        /** Starts a canvas interaction: resize, move, Ctrl+click selection, rectangle selection, or drawing. */
        onStagePointerDown(e) {
            if (e.button != 0) {
                return;
            }
            this.closeMenu();
            if (isTypingTarget(document.activeElement)) {
                document.activeElement.blur();
            }
            this.focus();
            let m = this.model;
            let pt = this.clientToImage(e);
            let handle = e.target.closest('.le-handle');
            let boxEl = e.target.closest('.le-box');
            if (e.target.closest('.le-inline-edit')) {
                return;
            }
            e.preventDefault();
            let ctrl = e.ctrlKey || e.metaKey;
            let hit = boxEl ? m.items.find(i => i.id == boxEl.dataset.id) : null;
            if (handle && hit && !ctrl) {
                this.drag = { mode: 'resize', dir: handle.dataset.dir, id: hit.id, start: pt, orig: LE.itemPixels(m, hit) };
            }
            else if (hit && ctrl) {
                // Ctrl/Cmd+click adds or removes a box; dragging right away moves the whole selection.
                this.toggleSelect(hit.id);
                if (!this.isSelected(hit.id)) {
                    return;
                }
                this.drag = this.makeGroupMove(pt, false);
            }
            else if (hit && !e.shiftKey && !hit.locked) {
                // Locked boxes and Shift-drag let you draw new boxes on top of existing ones.
                if (!this.isSelected(hit.id)) {
                    this.select(hit.id);
                }
                if (e.altKey) {
                    // Alt-drag duplicates, like in most design tools.
                    this.cloneSelection(0);
                    this.renderLayers();
                }
                this.drag = this.makeGroupMove(pt, e.altKey);
                this.drag.clickedId = e.altKey ? null : hit.id;
            }
            else if (ctrl) {
                // Ctrl-drag on empty canvas: rectangle selection, added to the current one.
                this.drag = { mode: 'marquee', start: pt, base: this.selection.slice() };
            }
            else {
                this.select(null);
                this.drag = { mode: 'draw', start: pt, id: null, type: this.drawType };
            }
            if (!this.drag) {
                return;
            }
            this.drag.moved = false;
            this.stage.setPointerCapture(e.pointerId);
            this.moveHandler = ev => this.onPointerMove(ev);
            this.upHandler = ev => this.onPointerUp(ev);
            this.stage.addEventListener('pointermove', this.moveHandler);
            this.stage.addEventListener('pointerup', this.upHandler);
            this.stage.addEventListener('pointercancel', this.upHandler);
        }

        /** Drag state for moving the selected unlocked boxes together. */
        makeGroupMove(pt, altStarted) {
            let g = this.groupRects();
            if (!g) {
                return null;
            }
            let origs = {};
            for (let r of g.rects) {
                origs[r.item.id] = r.p;
            }
            return { mode: 'move', ids: Object.keys(origs), origs: origs, bbox: g, start: pt, altStarted: altStarted };
        }

        /** Updates the current canvas interaction while the pointer moves. */
        onPointerMove(e) {
            let d = this.drag;
            if (!d) {
                return;
            }
            let m = this.model;
            let pt = this.clientToImage(e);
            let noSnap = e.altKey && d.mode != 'move';
            let dx = pt.x - d.start.x, dy = pt.y - d.start.y;
            if (!d.moved && Math.hypot(dx, dy) * this.scale < 3) {
                return;
            }
            d.moved = true;
            let gx = null, gy = null;
            if (d.mode == 'draw') {
                if (!d.id && Math.hypot(dx, dy) * this.scale < MIN_DRAW_SCREEN_PX) {
                    return;
                }
                let sx = this.snapAxis([d.start.x], 'x', d.id, noSnap);
                let sy = this.snapAxis([d.start.y], 'y', d.id, noSnap);
                let x0 = d.start.x + sx.delta, y0 = d.start.y + sy.delta;
                let ex = this.snapAxis([pt.x], 'x', d.id, noSnap);
                let ey = this.snapAxis([pt.y], 'y', d.id, noSnap);
                let x1 = LE.clamp(pt.x + ex.delta, 0, m.width), y1 = LE.clamp(pt.y + ey.delta, 0, m.height);
                gx = ex.guide; gy = ey.guide;
                let rx = Math.min(x0, x1), ry = Math.min(y0, y1);
                let rw = Math.max(1, Math.abs(x1 - x0)), rh = Math.max(1, Math.abs(y1 - y0));
                if (!d.id) {
                    let item = LE.newItem(d.type, 0, 0, 0, 0);
                    m.items.push(item);
                    d.id = item.id;
                    this.selectedId = item.id;
                }
                let item = m.items.find(i => i.id == d.id);
                LE.setItemPixels(m, item, Math.round(rx), Math.round(ry), Math.round(rw), Math.round(rh));
            }
            else if (d.mode == 'move') {
                let b = d.bbox;
                let bw = b.x2 - b.x1, bh = b.y2 - b.y1;
                let nx = b.x1 + dx, ny = b.y1 + dy;
                let free = e.altKey && !d.altStarted;
                let sx = this.snapAxis([nx, nx + bw / 2, nx + bw], 'x', d.ids, free);
                let sy = this.snapAxis([ny, ny + bh / 2, ny + bh], 'y', d.ids, free);
                nx += sx.delta; ny += sy.delta;
                gx = sx.guide; gy = sy.guide;
                nx = LE.clamp(nx, 0, m.width - bw);
                ny = LE.clamp(ny, 0, m.height - bh);
                let offX = Math.round(nx - b.x1), offY = Math.round(ny - b.y1);
                for (let id of d.ids) {
                    let o = d.origs[id];
                    let item = m.items.find(i => i.id == id);
                    if (item) {
                        LE.setItemPixels(m, item, o.x1 + offX, o.y1 + offY, o.w, o.h);
                    }
                }
            }
            else if (d.mode == 'marquee') {
                let x1 = Math.min(d.start.x, pt.x), y1 = Math.min(d.start.y, pt.y);
                let x2 = Math.max(d.start.x, pt.x), y2 = Math.max(d.start.y, pt.y);
                let inside = m.items.filter(it => {
                    if (!it.visible) {
                        return false;
                    }
                    let p = LE.itemPixels(m, it);
                    return p.x1 < x2 && p.x2 > x1 && p.y1 < y2 && p.y2 > y1;
                }).map(it => it.id);
                this.selection = d.base.concat(inside.filter(id => !d.base.includes(id)));
                this.renderBoxes();
                this.showGuides(null, null);
                this.guidesLayer.appendChild(el('div', {
                    class: 'le-marquee',
                    style: { left: `${x1 * this.scale}px`, top: `${y1 * this.scale}px`, width: `${(x2 - x1) * this.scale}px`, height: `${(y2 - y1) * this.scale}px` }
                }));
                return;
            }
            else if (d.mode == 'resize') {
                let o = d.orig;
                let x1 = o.x1, y1 = o.y1, x2 = o.x2, y2 = o.y2;
                if (d.dir.includes('w')) {
                    let s = this.snapAxis([o.x1 + dx], 'x', d.id, noSnap);
                    x1 = LE.clamp(o.x1 + dx + s.delta, 0, x2 - 1); gx = s.guide;
                }
                if (d.dir.includes('e')) {
                    let s = this.snapAxis([o.x2 + dx], 'x', d.id, noSnap);
                    x2 = LE.clamp(o.x2 + dx + s.delta, x1 + 1, m.width); gx = s.guide;
                }
                if (d.dir.includes('n')) {
                    let s = this.snapAxis([o.y1 + dy], 'y', d.id, noSnap);
                    y1 = LE.clamp(o.y1 + dy + s.delta, 0, y2 - 1); gy = s.guide;
                }
                if (d.dir.includes('s')) {
                    let s = this.snapAxis([o.y2 + dy], 'y', d.id, noSnap);
                    y2 = LE.clamp(o.y2 + dy + s.delta, y1 + 1, m.height); gy = s.guide;
                }
                let item = m.items.find(i => i.id == d.id);
                LE.setItemPixels(m, item, Math.round(x1), Math.round(y1), Math.round(x2 - x1), Math.round(y2 - y1));
            }
            this.showGuides(gx, gy);
            this.renderBoxes();
            this.updateInspectorGeometry();
        }

        /** Finishes the current canvas interaction and records it. */
        onPointerUp(e) {
            let d = this.drag;
            this.drag = null;
            this.stage.removeEventListener('pointermove', this.moveHandler);
            this.stage.removeEventListener('pointerup', this.upHandler);
            this.stage.removeEventListener('pointercancel', this.upHandler);
            try {
                this.stage.releasePointerCapture(e.pointerId);
            }
            catch (err) {
                // Capture may already be gone.
            }
            this.showGuides(null, null);
            if (d && !d.moved && d.mode == 'move' && d.clickedId && this.selection.length > 1) {
                this.select(d.clickedId);
                return;
            }
            if (!d || !d.moved) {
                return;
            }
            if (d.mode == 'marquee') {
                this.setSelection(this.selection);
                return;
            }
            if (d.mode == 'draw') {
                if (!d.id) {
                    return;
                }
                let item = this.model.items.find(i => i.id == d.id);
                let p = LE.itemPixels(this.model, item);
                if (p.w * this.scale < MIN_DRAW_SCREEN_PX || p.h * this.scale < MIN_DRAW_SCREEN_PX) {
                    this.model.items.splice(this.model.items.indexOf(item), 1);
                    this.selectedId = null;
                    this.changed();
                    return;
                }
                this.changed();
                // Draw, type, Enter, draw the next one: jump straight into the box's main field.
                this.focusInspectorField(item);
                return;
            }
            this.changed();
        }

        /** Double-click on a box: edit it on the canvas. */
        onStageDblClick(e) {
            if (e.target.closest('.le-inline-edit')) {
                return;
            }
            // The first click re-renders the boxes, so the event target may be stale: hit-test the point instead.
            let hit = document.elementFromPoint(e.clientX, e.clientY);
            let boxEl = hit ? hit.closest('.le-box') : null;
            if (!boxEl) {
                return;
            }
            let item = this.model.items.find(i => i.id == boxEl.dataset.id);
            if (!item) {
                return;
            }
            e.preventDefault();
            this.select(item.id);
            this.startInlineEdit(item);
        }

        /** Edits a box's main field directly on the canvas: the text for text boxes, the caption otherwise. */
        startInlineEdit(item) {
            let boxEl = this.boxesLayer.querySelector(`.le-box[data-id="${item.id}"]`);
            if (!boxEl) {
                return;
            }
            let field = item.type == 'text' ? 'text' : 'caption';
            let ta = el('textarea', {
                class: 'le-inline-edit',
                placeholder: field == 'text' ? 'Text to render…' : 'Describe this box…'
            });
            ta.value = item[field];
            let done = false;
            let finish = (save) => {
                if (done) {
                    return;
                }
                done = true;
                if (save) {
                    item[field] = ta.value;
                }
                this.changed();
                this.focus();
            };
            ta.addEventListener('keydown', ev => {
                ev.stopPropagation();
                if (ev.key == 'Escape') {
                    ev.preventDefault();
                    finish(false);
                }
                else if (ev.key == 'Enter' && field == 'caption' && !ev.shiftKey) {
                    ev.preventDefault();
                    finish(true);
                }
                else if (ev.key == 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                    ev.preventDefault();
                    finish(true);
                }
            });
            ta.addEventListener('blur', () => finish(true));
            ta.addEventListener('pointerdown', ev => ev.stopPropagation());
            boxEl.appendChild(ta);
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
    }

    LE.Editor = Editor;
})();
