import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { DOUBAO_DOMAIN, DOUBAO_CHAT_URL, ensureDoubaoChatPage } from './utils.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// edit-image: generate images from a text prompt (text-to-image), or edit an
// uploaded image with a prompt (image edit), in a NEW conversation, wait for
// generation, and download the result images.
//
// Strategy: UI_SELECTOR (visible-ui contract). Every anchor below was verified
// against the live logged-in doubao.com DOM (2026-08-31):
// - Upload anchor: hidden input[type=file] via CDP setFileInputFiles (accept
//   includes png/jpeg/jpg/webp, multiple).
// - Composer anchor: the 2026-08 composer on /chat/ is a tiptap ProseMirror
//   editor; earlier builds used a Semi Design textarea, so both are covered.
// - Submit: the send control is div.send-btn-wrapper with no button/role
//   semantics, and CDP key events do not reach the tiptap keymap; dispatching
//   a synthetic KeyboardEvent('Enter') (key/code/keyCode/which) on the
//   composer is verified to submit. Success signal: the URL gains /chat/<id>.
// - Result anchor: img[src*="rc_gen_image"] inside the message list. The
//   message-list variant carries the 2048px template URL, a signed CDN link
//   that downloads fine outside the page.
// The internal SSE generation endpoint is deliberately not used: it has no
// external contract, while every UI anchor above is stable and observable.
// ---------------------------------------------------------------------------

const COMPOSER_SELECTORS = [
    'textarea.semi-input-textarea',
    'div.tiptap.ProseMirror',
    'textarea[data-testid="chat_input_input"]',
    '[contenteditable="true"][placeholder*="发消息"]',
    'textarea',
    '[contenteditable="true"]',
];

const COMPOSER_PROBE_SCRIPT = `
    (() => {
      for (const s of ${JSON.stringify(COMPOSER_SELECTORS)}) {
        const el = document.querySelector(s);
        if (el && !el.hidden) return s;
      }
      return null;
    })()`;

const FILL_SCRIPT = (text) => `
    (() => {
      let composer = null;
      for (const s of ${JSON.stringify(COMPOSER_SELECTORS)}) {
        const el = document.querySelector(s);
        if (el && !el.hidden) { composer = el; break; }
      }
      if (!composer) return { ok: false, reason: 'composer not found' };
      composer.focus();
      const expected = ${JSON.stringify(text)};
      if (composer.isContentEditable) {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, expected);
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: expected, inputType: 'insertText' }));
      } else {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(composer, expected);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const current = (composer.isContentEditable ? composer.innerText : composer.value) || '';
      return { ok: current.includes(expected.slice(0, Math.min(12, expected.length))), length: current.length };
    })()`;

const SUBMIT_SCRIPT = `
    (() => {
      let composer = null;
      for (const s of ${JSON.stringify(COMPOSER_SELECTORS)}) {
        const el = document.querySelector(s);
        if (el && !el.hidden) { composer = el; break; }
      }
      if (!composer) return { dispatched: false };
      composer.focus();
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, view: window };
      composer.dispatchEvent(new KeyboardEvent('keydown', opts));
      composer.dispatchEvent(new KeyboardEvent('keypress', opts));
      composer.dispatchEvent(new KeyboardEvent('keyup', opts));
      return { dispatched: true };
    })()`;

const SUBMIT_STATE_SCRIPT = `
    (() => {
      // 2026-09: new conversations may use local_ prefixed ids (/chat/local_<digits>)
      // alongside the legacy numeric ids.
      const match = location.pathname.match(/\\/chat\\/((?:local_)?\\d{6,})/);
      const pm = document.querySelector('div.tiptap.ProseMirror');
      const ta = document.querySelector('textarea.semi-input-textarea');
      const text = pm ? pm.innerText : (ta ? ta.value : '');
      return { conversationId: match ? match[1] : null, composerLength: (text || '').trim().length };
    })()`;

const UPLOAD_STATE_SCRIPT = `
    (() => Array.from(document.querySelectorAll('input[type=file]')).filter((i) => i.files && i.files.length > 0).length)()`;

const RESULT_SCRIPT = `
    (() => {
      const scope = document.querySelector('[class*="list_items"]') || document.body;
      const urls = [];
      for (const img of scope.querySelectorAll('img')) {
        const src = img.currentSrc || img.src;
        if (!src || src.indexOf('rc_gen_image') === -1) continue;
        if (!img.naturalWidth) continue;
        const key = src.split('?')[0].split('~')[0];
        if (!urls.some((u) => u.split('?')[0].split('~')[0] === key)) urls.push(src);
      }
      const text = document.body ? document.body.innerText : '';
      return { urls, busy: /正在生成|生成中/.test(text), fail: /生成失败|无法完成|违规内容/.test(text) };
    })()`;

export const editImageCommand = cli({
    site: 'doubao',
    name: 'edit-image',
    access: 'write',
    description: 'Generate images from a prompt, or edit an uploaded image with a prompt, in a new Doubao conversation',
    domain: DOUBAO_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    navigateBefore: false,
    args: [
        { name: 'prompt', required: true, positional: true, help: 'Editing instruction (with --image) or generation prompt (without)' },
        { name: 'image', required: false, help: 'Absolute path of an image file to edit; omit for text-to-image' },
        { name: 'out', required: false, help: 'Output directory (default: ~/Downloads/doubao-edit)' },
        { name: 'timeout', type: 'int', required: false, default: 180, help: 'Max seconds to wait for generation (min: 30)' },
    ],
    columns: ['Index', 'ConversationId', 'SavedTo', 'Url'],
    func: async (page, kwargs) => {
        const prompt = String(kwargs.prompt || '').trim();
        const imageArg = String(kwargs.image || '').trim();
        const outDir = kwargs.out ? path.resolve(String(kwargs.out)) : path.join(os.homedir(), 'Downloads', 'doubao-edit');
        const timeout = kwargs.timeout;
        const hasImage = Boolean(imageArg);
        const imagePath = hasImage ? path.resolve(imageArg) : null;
        if (!prompt) {
            throw new ArgumentError('<prompt> is required');
        }
        if (hasImage && !fs.existsSync(imagePath)) {
            throw new ArgumentError(`Image file not found: ${imagePath}`);
        }
        if (!Number.isInteger(timeout) || timeout < 30) {
            throw new ArgumentError('--timeout must be an integer >= 30 (seconds)');
        }

        // 1. Fresh conversation page
        await ensureDoubaoChatPage(page);
        await page.goto(DOUBAO_CHAT_URL, { waitUntil: 'load', settleMs: 2500 });
        let composerSel = null;
        for (let i = 0; i < 12 && !composerSel; i++) {
            composerSel = await page.evaluate(COMPOSER_PROBE_SCRIPT).catch(() => null);
            if (!composerSel) await page.wait(0.8);
        }
        if (!composerSel) {
            throw new CommandExecutionError('Doubao composer not found after loading /chat (new composer markup or login required)');
        }

        // 2. Edit mode: upload the source image
        if (hasImage) {
            await page.setFileInput([imagePath], 'input[type=file]');
            let registered = 0;
            for (let i = 0; i < 5 && !registered; i++) {
                await page.wait(0.8);
                registered = await page.evaluate(UPLOAD_STATE_SCRIPT).catch(() => 0);
            }
            if (!registered) {
                throw new CommandExecutionError('Doubao file input did not register the uploaded image');
            }
            await page.wait(1.5);
        }

        // 3. Fill the prompt
        const filled = await page.evaluate(FILL_SCRIPT(prompt));
        if (!filled?.ok) {
            throw new CommandExecutionError(`Failed to insert prompt into Doubao composer: ${filled?.reason || JSON.stringify(filled)}`);
        }

        // 4. Submit; a new conversation URL (/chat/<id>) is the success signal
        await page.evaluate(SUBMIT_SCRIPT);
        let conversationId = null;
        for (let i = 0; i < 12 && !conversationId; i++) {
            await page.wait(1);
            const state = await page.evaluate(SUBMIT_STATE_SCRIPT).catch(() => null);
            if (state?.conversationId) conversationId = state.conversationId;
        }
        if (!conversationId) {
            throw new CommandExecutionError('Prompt was not submitted (no conversation created). Doubao may show a verification challenge or the composer changed again.');
        }

        // 5. Poll for generated images. Owned-session tabs can be recycled when
        //    idle, so an evaluate failure re-enters the conversation URL and
        //    keeps polling instead of losing the run.
        const conversationUrl = `https://www.doubao.com/chat/${conversationId}`;
        const deadline = Date.now() + timeout * 1000;
        let urls = [];
        let failReason = null;
        let recoveries = 0;
        while (Date.now() < deadline) {
            let result = null;
            try {
                result = await page.evaluate(RESULT_SCRIPT);
            }
            catch {
                if (recoveries++ > 5) break;
                await page.goto(conversationUrl, { waitUntil: 'load', settleMs: 2500 }).catch(() => {});
                await page.wait(1.5);
                continue;
            }
            if (result?.urls?.length) {
                urls = result.urls;
                break;
            }
            if (result?.fail) {
                failReason = 'Doubao reported a generation failure in the conversation';
                break;
            }
            await page.wait(2.5);
        }
        if (!urls.length) {
            throw new TimeoutError(failReason || `No generated image within ${timeout}s. Conversation: ${conversationUrl}`);
        }

        // 6. Download results (signed CDN URL works outside the page)
        fs.mkdirSync(outDir, { recursive: true });
        const rows = [];
        for (let n = 0; n < urls.length; n++) {
            const url = urls[n];
            const extMatch = url.match(/\.(png|jpe?g|webp)(?:\?|$)/);
            const ext = extMatch ? (extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1]) : 'png';
            const filePath = path.join(outDir, `doubao_edit_${conversationId}_${n + 1}.${ext}`);
            const res = await fetch(url);
            if (!res.ok) {
                throw new CommandExecutionError(`Download failed (HTTP ${res.status}) for generated image ${n + 1}`);
            }
            fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
            rows.push({
                Index: n + 1,
                ConversationId: conversationId,
                SavedTo: filePath,
                Url: url,
            });
        }
        return rows;
    },
});

export const __test__ = {
    COMPOSER_SELECTORS,
    COMPOSER_PROBE_SCRIPT,
    FILL_SCRIPT,
    SUBMIT_SCRIPT,
    SUBMIT_STATE_SCRIPT,
    UPLOAD_STATE_SCRIPT,
    RESULT_SCRIPT,
};
