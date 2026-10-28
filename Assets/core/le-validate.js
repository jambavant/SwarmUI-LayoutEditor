// Layout Editor - validation shared by all formats.
// Issues never block export; they are shown in the editor and clicking one selects its box.
(function () {
    'use strict';
    let LE = window.LayoutEditor = window.LayoutEditor || {};

    /** Rough legibility check: largest font size (px) at which the text fits its box. */
    LE.estimateFontPx = function (text, wPx, hPx) {
        let lines = String(text || '').split('\n');
        let longest = Math.max(1, ...lines.map(l => l.length));
        let byHeight = hPx / (lines.length * 1.25);
        let byWidth = wPx / (longest * 0.55);
        return Math.min(byHeight, byWidth);
    };

    LE.MAX_ITEMS_HINT = 12;
    LE.MIN_TEXT_PX = 14;

    LE.validate = function (model, opts) {
        opts = opts || {};
        let profile = LE.getFormat(model.formatId);
        let issues = [];
        if (model.width % 16 || model.height % 16) {
            issues.push({ level: 'warning', message: `Canvas ${model.width}×${model.height} is not a multiple of 16.` });
        }
        let mp = LE.megapixels(model);
        if (mp < 0.25 || mp > 4) {
            issues.push({ level: 'error', message: `${mp.toFixed(2)} MP is outside the 0.25–4 MP range the model supports.` });
        }
        else if (mp < 0.95 || mp > 2.1) {
            issues.push({ level: 'info', message: `${mp.toFixed(2)} MP: 1–2 MP is recommended.` });
        }
        let visible = model.items.filter(i => i.visible);
        if (visible.length == 0) {
            issues.push({ level: 'info', message: 'No boxes yet. Drag on the canvas to draw one.' });
        }
        if (visible.length > LE.MAX_ITEMS_HINT) {
            issues.push({ level: 'warning', message: `${visible.length} boxes: layouts with more than about ${LE.MAX_ITEMS_HINT} are followed less reliably.` });
        }
        let allowedTypes = profile.types(model).map(t => t.id);
        for (let index = 0; index < model.items.length; index++) {
            let item = model.items[index];
            if (!item.visible) {
                continue;
            }
            let n = `#${index + 1}`;
            let p = LE.itemPixels(model, item);
            if (p.w < 1 || p.h < 1) {
                issues.push({ level: 'error', itemId: item.id, message: `${n} has no size.` });
            }
            if (p.x1 < 0 || p.y1 < 0 || p.x2 > model.width || p.y2 > model.height) {
                issues.push({ level: 'error', itemId: item.id, message: `${n} goes outside the canvas.` });
            }
            if (!allowedTypes.includes(item.type)) {
                issues.push({ level: 'info', itemId: item.id, message: `${n} is a ${item.type}, exported as ${profile.typeForExport(model, item)} in ${profile.name}.` });
            }
            if (!item.caption.trim()) {
                issues.push({ level: 'warning', itemId: item.id, message: `${n} has an empty caption.` });
            }
            if (item.type == 'text') {
                if (!item.text.trim()) {
                    issues.push({ level: 'error', itemId: item.id, message: `${n} is a text box with no text to render.` });
                }
                else {
                    let px = LE.estimateFontPx(item.text, p.w, p.h);
                    if (px < LE.MIN_TEXT_PX) {
                        issues.push({ level: 'warning', itemId: item.id, message: `${n}: the text would be about ${Math.round(px)} px tall, likely too small to render legibly. Enlarge the box or shorten the text.` });
                    }
                }
            }
            if (opts.swarm && /[<>]/.test(item.caption + item.text)) {
                issues.push({ level: 'warning', itemId: item.id, message: `${n} contains < or >. SwarmUI reads <...> as prompt tags, which can change the JSON.` });
            }
        }
        if (opts.swarm && /[<>]/.test(model.scene.caption)) {
            issues.push({ level: 'warning', message: 'The scene caption contains < or >. SwarmUI reads <...> as prompt tags, which can change the JSON.' });
        }
        // Overlaps are allowed (a title over an image), so they are only informational.
        for (let i = 0; i < visible.length; i++) {
            for (let j = i + 1; j < visible.length; j++) {
                let a = visible[i], b = visible[j];
                let ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
                let iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
                if (ix > 0 && iy > 0 && a.type == 'text' && b.type == 'text') {
                    issues.push({ level: 'info', itemId: b.id, message: `Text boxes #${model.items.indexOf(a) + 1} and #${model.items.indexOf(b) + 1} overlap; their glyphs may collide.` });
                }
            }
        }
        for (let issue of profile.validate(model)) {
            issues.push(issue);
        }
        let rank = { error: 0, warning: 1, info: 2 };
        issues.sort((a, b) => rank[a.level] - rank[b.level]);
        return issues;
    };
})();
