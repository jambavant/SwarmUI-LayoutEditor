// Layout Editor - core data model.
// Plain script (no modules) so it runs the same inside SwarmUI and from a local file.
// Everything lives on the global `LayoutEditor` namespace.
(function () {
    'use strict';
    let LE = window.LayoutEditor = window.LayoutEditor || {};

    let idCounter = 0;
    LE.uid = function () {
        idCounter++;
        return 'b' + Date.now().toString(36) + idCounter.toString(36);
    };

    LE.clamp = function (v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    };

    /** Rounds a pixel value to the nearest multiple of 16, at least 16. */
    LE.round16 = function (v) {
        return Math.max(16, Math.round(v / 16) * 16);
    };

    /**
     * Canonical layout model, independent of any output format.
     * Box geometry is stored normalized (0..1, top-left origin) so a resolution change keeps every box in place.
     */
    LE.newModel = function (formatId) {
        return {
            version: 1,
            formatId: formatId || 'moss',
            width: 1024,
            height: 1024,
            scene: {
                caption: '',
                meta: [],
                canvas: 'single'
            },
            options: {
                characterType: false,
                compactJson: true
            },
            items: []
        };
    };

    LE.newItem = function (type, x, y, w, h) {
        return {
            id: LE.uid(),
            type: type || 'object', // 'text' | 'object' | 'character'
            caption: '',
            text: '',
            x: x, y: y, w: w, h: h, // normalized
            visible: true,
            locked: false
        };
    };

    LE.cloneModel = function (model) {
        return JSON.parse(JSON.stringify(model));
    };

    /** Fills missing fields so models loaded from storage or older versions are always complete. */
    LE.normalizeModel = function (raw) {
        let base = LE.newModel(raw && raw.formatId);
        if (!raw || typeof raw != 'object') {
            return base;
        }
        let m = Object.assign(base, raw);
        m.scene = Object.assign(LE.newModel().scene, raw.scene || {});
        m.options = Object.assign(LE.newModel().options, raw.options || {});
        if (!Array.isArray(m.scene.meta)) {
            m.scene.meta = [];
        }
        m.width = LE.round16(parseInt(m.width) || 1024);
        m.height = LE.round16(parseInt(m.height) || 1024);
        m.items = (Array.isArray(raw.items) ? raw.items : []).map(it => {
            let item = Object.assign(LE.newItem('object', 0, 0, 0.1, 0.1), it || {});
            if (!item.id) {
                item.id = LE.uid();
            }
            for (let k of ['x', 'y', 'w', 'h']) {
                item[k] = Number(item[k]) || 0;
            }
            return item;
        });
        return m;
    };

    /** Pixel rectangle of an item on the model's canvas, rounded to whole pixels. */
    LE.itemPixels = function (model, item) {
        let x1 = Math.round(item.x * model.width);
        let y1 = Math.round(item.y * model.height);
        let x2 = Math.round((item.x + item.w) * model.width);
        let y2 = Math.round((item.y + item.h) * model.height);
        return { x1: x1, y1: y1, x2: x2, y2: y2, w: x2 - x1, h: y2 - y1 };
    };

    /** Sets an item's geometry from pixel values (top-left x, y, width, height). */
    LE.setItemPixels = function (model, item, x, y, w, h) {
        item.x = x / model.width;
        item.y = y / model.height;
        item.w = w / model.width;
        item.h = h / model.height;
    };

    LE.megapixels = function (model) {
        return (model.width * model.height) / 1000000;
    };

    /** Aspect presets: dimensions near the given megapixel target, multiples of 16. */
    LE.ASPECTS = ['1:1', '4:5', '3:4', '2:3', '9:16', '5:4', '4:3', '3:2', '16:9', '21:9'];
    LE.dimsForAspect = function (aspect, targetMp) {
        let parts = aspect.split(':').map(Number);
        let ratio = parts[0] / parts[1];
        let area = (targetMp || 1.05) * 1000000;
        let h = Math.sqrt(area / ratio);
        return { width: LE.round16(h * ratio), height: LE.round16(h) };
    };

    LE.describeAspect = function (w, h) {
        let gcd = (a, b) => b ? gcd(b, a % b) : a;
        for (let a of LE.ASPECTS) {
            let p = a.split(':').map(Number);
            if (Math.abs(w / h - p[0] / p[1]) < 0.02) {
                return a;
            }
        }
        let g = gcd(w, h);
        return (w / g) + ':' + (h / g);
    };
})();
