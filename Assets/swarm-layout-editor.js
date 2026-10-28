// Layout Editor - SwarmUI host.
// Adds "Layout Editor (boxes)" to the + menu beside the prompt box. It opens the editor in a modal (with a maximize button).
// Apply writes the layout JSON into the prompt (replacing it) and sets Swarm's resolution to the canvas size.
// Generate (or Ctrl+Enter) runs Swarm's normal generation with the layout, and shows results in the editor.
(function () {
    'use strict';
    let LE = window.LayoutEditor;
    if (!LE || typeof GenerateHandler == 'undefined') {
        console.warn('[LayoutEditor] SwarmUI generate page not found; the layout editor is disabled on this page.');
        return;
    }

    let modal = null;
    let editor = null;
    let genHandler = null;
    let isOpen = false;
    let expectedImages = 0;
    let receivedImages = 0;

    function seedFromMetadata(metadata) {
        try {
            let parsed = typeof metadata == 'string' ? JSON.parse(metadata) : metadata;
            let seed = parsed && parsed.sui_image_params ? parsed.sui_image_params.seed : null;
            return seed == null ? null : seed;
        }
        catch (e) {
            return null;
        }
    }

    /** A GenerateHandler that behaves exactly like Swarm's main one, but also reports to the editor. */
    class LayoutGenHandler extends GenerateHandler {
        /** Passes a finished image to the editor and updates its status. */
        reportResult(image, metadata) {
            receivedImages++;
            if (editor) {
                editor.addResult(image, seedFromMetadata(metadata));
                if (receivedImages >= expectedImages) {
                    editor.setGenStatus(`Done: ${receivedImages} image${receivedImages == 1 ? '' : 's'}.`, null, false);
                }
                else {
                    editor.setGenStatus(`Image ${receivedImages} of ${expectedImages}…`, receivedImages / expectedImages, true);
                }
            }
        }

        /** Swarm hook: a new image arrived (no placeholder existed). */
        gotImageResult(image, metadata, batchId) {
            let result = super.gotImageResult(image, metadata, batchId);
            this.reportResult(image, metadata);
            return result;
        }

        /** Swarm hook: an image arrived for an existing placeholder. */
        gotTrackedImageResult(image, metadata, batchId, existingDiv = null) {
            super.gotTrackedImageResult(image, metadata, batchId, existingDiv);
            this.reportResult(image, metadata);
        }

        /** Swarm hook: generation progress. */
        gotProgress(current, overall, batchId) {
            super.gotProgress(current, overall, batchId);
            if (editor && editor.generating) {
                let pct = Math.round((overall || 0) * 100);
                editor.setGenStatus(`Generating… ${pct}%`, overall || 0, true);
            }
        }

        /** Swarm hook: raw socket data; used to detect the end of the request. */
        internalHandleData(data, images, discardable, timeLastGenHit, actualInput, socketId, socket, isPreview, batch_id) {
            let res = super.internalHandleData(data, images, discardable, timeLastGenHit, actualInput, socketId, socket, isPreview, batch_id);
            if (editor && data && data.socket_intention == 'close' && editor.generating) {
                editor.setGenStatus(receivedImages ? `Done: ${receivedImages} image${receivedImages == 1 ? '' : 's'}.` : 'Finished.', null, false);
            }
            return res;
        }

        /** Swarm hook: generation error. */
        hadError(msg) {
            super.hadError(msg);
            if (editor) {
                editor.setGenStatus(`Error: ${msg}`, null, false);
            }
        }
    }

    function getSwarmSize() {
        let w = parseInt((document.getElementById('input_width') || {}).value);
        let h = parseInt((document.getElementById('input_height') || {}).value);
        return { width: w || 1024, height: h || 1024 };
    }

    function getPromptBox() {
        return document.getElementById('alt_prompt_textbox');
    }

    /** Replaces the prompt with the layout JSON and sets Swarm's resolution to the canvas size. */
    function writeToSwarm(prompt, model) {
        let box = getPromptBox();
        if (box) {
            box.value = prompt;
            triggerChangeFor(box);
        }
        let aspect = document.getElementById('input_aspectratio');
        if (aspect && aspect.value != 'Custom') {
            aspect.value = 'Custom';
            triggerChangeFor(aspect);
        }
        for (let [id, value] of [['input_width', model.width], ['input_height', model.height]]) {
            let input = document.getElementById(id);
            if (input && parseInt(input.value) != value) {
                input.value = value;
                triggerChangeFor(input);
            }
        }
    }

    function currentCompat() {
        try {
            return currentModelHelper.curCompatClass || null;
        }
        catch (e) {
            return null;
        }
    }

    function generate(prompt, model) {
        writeToSwarm(prompt, model);
        currentModelHelper.ensureCurrentModel(() => {
            let modelSelect = document.getElementById('current_model');
            if (modelSelect && modelSelect.value == '') {
                editor.toast('Select a model in SwarmUI first.', true);
                return;
            }
            let overrides = {
                prompt: prompt,
                width: model.width,
                height: model.height,
                aspectratio: 'Custom',
                sidelength: null
            };
            if (editor.keepSeed && editor.lastSeed != null) {
                overrides.seed = editor.lastSeed;
            }
            let imagesInput = document.getElementById('input_images');
            expectedImages = Math.max(1, parseInt(imagesInput ? imagesInput.value : '1') || 1);
            receivedImages = 0;
            editor.setGenStatus('Queued…', 0, true);
            genHandler.doGenerate(overrides);
        });
    }

    function buildModal() {
        modal = document.createElement('div');
        modal.className = 'le-swarm-overlay';
        modal.innerHTML = '<div class="le-swarm-dialog"><div class="le-swarm-editor"></div></div>';
        modal.addEventListener('pointerdown', e => {
            if (e.target == modal) {
                close();
            }
        });
        document.body.appendChild(modal);
        let dialog = modal.querySelector('.le-swarm-dialog');
        editor = new LE.Editor(modal.querySelector('.le-swarm-editor'), {
            mode: 'swarm',
            canGenerate: true,
            applyLabel: 'Apply',
            /** Apply: write the layout into the prompt and close. */
            onApply(prompt, model) {
                writeToSwarm(prompt, model);
                close();
            },
            /** Generate: run a normal Swarm generation with the layout. */
            onGenerate(prompt, model) {
                generate(prompt, model);
            },
            /** Cancel: interrupt the generation. */
            onInterrupt() {
                genHandler.doInterrupt();
                editor.setGenStatus('Cancelled.', null, false);
            },
            /** Shortcuts only apply while the modal is open. */
            isActive() {
                return isOpen;
            },
            /** Adds the maximize and close buttons. */
            extraToolbar(tools) {
                let max = document.createElement('button');
                max.className = 'le-btn le-icon';
                max.title = 'Maximize';
                max.textContent = '⤢';
                max.addEventListener('click', () => {
                    dialog.classList.toggle('le-max');
                    max.title = dialog.classList.contains('le-max') ? 'Restore size' : 'Maximize';
                    editor.relayout();
                });
                let closeBtn = document.createElement('button');
                closeBtn.className = 'le-btn le-icon';
                closeBtn.title = 'Close without applying (Esc)';
                closeBtn.textContent = '×';
                closeBtn.addEventListener('click', () => close());
                tools.appendChild(max);
                tools.appendChild(closeBtn);
            }
        });
        editor.renderResults();
        document.addEventListener('keydown', e => {
            if (isOpen && e.key == 'Escape' && !e.defaultPrevented) {
                e.preventDefault();
                close();
            }
        });
    }

    function open() {
        if (!modal) {
            buildModal();
        }
        isOpen = true;
        modal.style.display = 'flex';
        let size = getSwarmSize();
        if (size.width != editor.model.width || size.height != editor.model.height) {
            editor.setSize(size.width, size.height);
        }
        // Load the layout already in the prompt (from an LLM, ComfyUI, or a previous Apply).
        let box = getPromptBox();
        if (box && box.value.trim() && box.value.trim() != editor.getPrompt()) {
            editor.importPrompt(box.value, true);
        }
        let profile = LE.getFormat(editor.model.formatId);
        let compat = currentCompat();
        if (compat && profile.compatClasses && !profile.compatClasses.includes(compat)) {
            editor.toast(`The selected model (${compat}) is not ${profile.name}. This layout format is meant for ${profile.name}.`);
        }
        requestAnimationFrame(() => {
            editor.relayout();
            editor.focus();
        });
    }

    function close() {
        if (!isOpen) {
            return;
        }
        isOpen = false;
        editor.closeMenu();
        editor.commit();
        modal.style.display = 'none';
    }

    let MENU_ENTRY = {
        key: 'Layout Editor (boxes)',
        title: 'Draw boxes with captions to build a layout prompt (MOSS-Image)',
        action: () => open()
    };

    /**
     * Adds "Layout Editor" to the menu of the + button beside the prompt.
     * Swarm has no extension hook for that menu, so this wraps the menu's show method and appends an entry
     * to the popover it just built (the popover rebuilds its list from `buttons`, as its own search does).
     */
    function hookPlusMenu() {
        if (typeof promptPlusButton == 'undefined' || !promptPlusButton || typeof promptPlusButton.showMenu != 'function') {
            return false;
        }
        if (promptPlusButton.layoutEditorHooked) {
            return true;
        }
        let originalShowMenu = promptPlusButton.showMenu;
        promptPlusButton.showMenu = function () {
            originalShowMenu.apply(this, arguments);
            try {
                let pop = this.popover;
                if (!pop || !Array.isArray(pop.buttons) || typeof pop.buildList != 'function') {
                    // The popover changed shape in this Swarm version: offer a plain button instead.
                    addFallbackButton();
                    return;
                }
                if (!pop.buttons.includes(MENU_ENTRY)) {
                    let otherIndex = pop.buttons.findIndex(b => b.key == 'other');
                    pop.buttons.splice(otherIndex == -1 ? pop.buttons.length : otherIndex, 0, MENU_ENTRY);
                    pop.buildList();
                    if (typeof pop.fitOptionAreaWidth == 'function') {
                        pop.fitOptionAreaWidth();
                    }
                }
            }
            catch (e) {
                console.warn('[LayoutEditor] Could not add the menu entry:', e);
                addFallbackButton();
            }
        };
        promptPlusButton.layoutEditorHooked = true;
        return true;
    }

    /** Fallback when the + menu can't be found (e.g. a future Swarm version): a small labeled button. */
    function addFallbackButton() {
        if (document.getElementById('le_open_layout_editor')) {
            return;
        }
        let wrapper = document.querySelector('.alt-prompt-buttons-wrapper');
        if (!wrapper) {
            return;
        }
        let button = document.createElement('button');
        button.id = 'le_open_layout_editor';
        button.className = 'alt-prompt-buttons basic-button le-swarm-open';
        button.title = MENU_ENTRY.title;
        button.textContent = 'Layout';
        button.addEventListener('click', open);
        wrapper.insertBefore(button, wrapper.firstChild);
    }

    function init() {
        genHandler = new LayoutGenHandler();
        if (!hookPlusMenu()) {
            addFallbackButton();
        }
    }

    window.layoutEditorSwarm = { open: open, close: close, getEditor: () => editor };

    if (typeof sessionReadyCallbacks != 'undefined') {
        sessionReadyCallbacks.push(init);
    }
    else {
        document.addEventListener('DOMContentLoaded', init);
    }
})();
