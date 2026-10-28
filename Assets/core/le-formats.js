// Layout Editor - format profiles.
// A profile decides which element types and fields the editor shows, adds its own validation,
// and converts the canonical model to and from the prompt string a model reads.
(function () {
    'use strict';
    let LE = window.LayoutEditor = window.LayoutEditor || {};

    LE.formats = {};
    LE.formatOrder = [];

    LE.registerFormat = function (profile) {
        LE.formats[profile.id] = profile;
        if (!LE.formatOrder.includes(profile.id)) {
            LE.formatOrder.push(profile.id);
        }
    };

    LE.getFormat = function (id) {
        return LE.formats[id] || LE.formats[LE.formatOrder[0]];
    };

    /** Extracts the outermost JSON object from a prompt that may have text around it. */
    LE.extractJsonObject = function (str) {
        if (typeof str != 'string') {
            return null;
        }
        let start = str.indexOf('{');
        let end = str.lastIndexOf('}');
        if (start == -1 || end <= start) {
            return null;
        }
        try {
            return JSON.parse(str.substring(start, end + 1));
        }
        catch (e) {
            return null;
        }
    };

    // ------------------------------------------------------------------ MOSS-Image
    // Spec: https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE.md (Layout Prompts)
    // bbox = [y_min, x_min, y_max, x_max], absolute pixels, origin at the canvas center.

    let MOSS_TYPES = [
        { id: 'text', label: 'Text', key: 't' },
        { id: 'object', label: 'Object', key: 'o' },
        { id: 'character', label: 'Character', key: 'c', optional: true }
    ];

    let moss = {
        id: 'moss',
        name: 'MOSS-Image',
        description: 'OpenMOSS MOSS-Image layout JSON (centered pixel coordinates, yxyx).',
        sceneLabel: 'Scene caption',
        scenePlaceholder: 'Describe the whole image: subject, setting, style, medium, lighting and colors.',
        metaSuggestions: ['poster', 'photo', 'illustration', 'infographic', 'comic', 'anime', '3d render', 'product shot'],
        hasCanvasField: true,
        compatClasses: ['moss-image'],

        /** Element types offered by this format; Character only when enabled in the options. */
        types(model) {
            return MOSS_TYPES.filter(t => !t.optional || model.options.characterType);
        },

        /** Fields the inspector shows for a box of the given type. */
        itemFields(type) {
            return type == 'text' ? ['caption', 'text'] : ['caption'];
        },

        /** Example caption shown in an empty caption field, per type. */
        placeholder(type) {
            if (type == 'text') {
                return 'How the text looks: e.g. "Bold white sans-serif title with a soft drop shadow".';
            }
            if (type == 'character') {
                return 'Who it is and what they do: e.g. "A young woman in a yellow raincoat, laughing, holding an umbrella".';
            }
            return 'What it is: e.g. "A red steel road bicycle clamped in a grey repair stand".';
        },

        textPlaceholder: 'The exact words to render. Press Enter for a line break.',

        /** Label written to the prompt for an item (Character falls back to Object when disabled). */
        typeForExport(model, item) {
            if (item.type == 'character' && !model.options.characterType) {
                return 'object';
            }
            return item.type;
        },

        /** Format-specific checks, added to the shared ones in le-validate.js. */
        validate(model) {
            let issues = [];
            if (!model.scene.caption.trim()) {
                issues.push({ level: 'warning', message: 'The scene caption is empty. MOSS-Image reads it as the description of the whole image.' });
            }
            return issues;
        },

        /** Builds the MOSS layout object: summary, items with centered yxyx pixel boxes, coordinate format. */
        exportObject(model) {
            let halfW = model.width / 2;
            let halfH = model.height / 2;
            let summary = {};
            if (model.scene.meta.length) {
                summary.meta = model.scene.meta.slice();
            }
            summary.canvas = model.scene.canvas || 'single';
            summary.caption = model.scene.caption.trim();
            let items = [];
            for (let item of model.items) {
                if (!item.visible) {
                    continue;
                }
                let p = LE.itemPixels(model, item);
                let label = this.typeForExport(model, item);
                let out = { label: label, caption: (item.caption || '').trim() };
                if (label == 'text') {
                    out.text = item.text || '';
                }
                out.bbox = [
                    Math.round(p.y1 - halfH),
                    Math.round(p.x1 - halfW),
                    Math.round(p.y2 - halfH),
                    Math.round(p.x2 - halfW)
                ];
                items.push(out);
            }
            return {
                summary: summary,
                items: items,
                bbox_coord_space: 'abs_centralized',
                bbox_format: 'yxyx'
            };
        },

        /** The prompt string: the layout object as compact or indented JSON. */
        exportPrompt(model) {
            let obj = this.exportObject(model);
            return model.options.compactJson ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
        },

        /** True when the string looks like a MOSS layout prompt. */
        detect(str) {
            let obj = LE.extractJsonObject(str);
            return !!(obj && Array.isArray(obj.items) && (obj.summary || obj.bbox_format || obj.bbox_coord_space));
        },

        /**
         * Parses a MOSS layout prompt into the given model (the model supplies width/height, since the JSON has none).
         * Returns { model, notes } or throws an Error with a readable message.
         */
        importPrompt(str, baseModel) {
            let obj = LE.extractJsonObject(str);
            if (!obj) {
                throw new Error('No JSON object found.');
            }
            if (!Array.isArray(obj.items)) {
                throw new Error('This JSON has no "items" list, so it is not a MOSS layout.');
            }
            let notes = [];
            let model = LE.cloneModel(baseModel);
            model.formatId = 'moss';
            let summary = obj.summary || {};
            model.scene.caption = typeof summary.caption == 'string' ? summary.caption : '';
            model.scene.meta = Array.isArray(summary.meta) ? summary.meta.map(String) : [];
            model.scene.canvas = typeof summary.canvas == 'string' ? summary.canvas : 'single';
            let format = (obj.bbox_format || 'yxyx').toLowerCase();
            let space = (obj.bbox_coord_space || 'abs_centralized').toLowerCase();
            if (format != 'yxyx' && format != 'xyxy') {
                throw new Error(`Unsupported bbox_format "${obj.bbox_format}".`);
            }
            if (space != 'abs_centralized' && space != 'abs') {
                throw new Error(`Unsupported bbox_coord_space "${obj.bbox_coord_space}".`);
            }
            let W = model.width, H = model.height;
            let outside = false;
            model.items = [];
            for (let raw of obj.items) {
                if (!raw || !Array.isArray(raw.bbox) || raw.bbox.length != 4) {
                    notes.push('Skipped an item without a valid 4-number bbox.');
                    continue;
                }
                let [a, b, c, d] = raw.bbox.map(Number);
                let x1, y1, x2, y2;
                if (format == 'yxyx') {
                    y1 = a; x1 = b; y2 = c; x2 = d;
                }
                else {
                    x1 = a; y1 = b; x2 = c; y2 = d;
                }
                if (space == 'abs_centralized') {
                    x1 += W / 2; x2 += W / 2; y1 += H / 2; y2 += H / 2;
                }
                if (x1 < -1 || y1 < -1 || x2 > W + 1 || y2 > H + 1) {
                    outside = true;
                }
                let label = String(raw.label || 'object').toLowerCase();
                if (label == 'obj') {
                    label = 'object';
                }
                if (!['text', 'object', 'character'].includes(label)) {
                    notes.push(`Unknown label "${raw.label}" imported as Object.`);
                    label = 'object';
                }
                if (label == 'character') {
                    model.options.characterType = true;
                }
                let item = LE.newItem(label, 0, 0, 0, 0);
                item.caption = typeof raw.caption == 'string' ? raw.caption : '';
                item.text = typeof raw.text == 'string' ? raw.text : '';
                LE.setItemPixels(model, item, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
                model.items.push(item);
            }
            if (outside) {
                notes.push(`Some boxes fall outside ${W}×${H}. The layout was probably made for another resolution: set the canvas size it was made for.`);
            }
            return { model: model, notes: notes };
        }
    };

    LE.registerFormat(moss);
})();
