// Shared presentation from the existing Breeze recording. Decisions are supplied separately.
export function createBreezeChrome(page, logo) {
  const pause = ms => page.waitForTimeout(ms);
  async function installChrome() {
    await page.evaluate(src => {
      if (document.getElementById('nl-cursor')) return;
      const cursor = document.createElement('div');
      cursor.id = 'nl-cursor';
      cursor.dataset.kriyaGuide = 'cursor';
      cursor.innerHTML =
        '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="#f5f5f7" stroke="#1d1d1f" stroke-width="1.2" d="M5 3l12 9-5 1 3 6-2 1-3-6-5 4z"/></svg>';
      const style = document.createElement('style');
      style.textContent = `
      ::view-transition-old(root), ::view-transition-new(root) { animation-duration: 450ms; }
      #kriya-click-guide-status { display: none !important; }
      #nl-cursor { position: fixed; z-index: 2147483647; width: 22px; height: 22px; pointer-events: none; left: 72px; top: 72px; }
      #nl-entry {
        position: fixed; top: 96px; left: 50%; z-index: 2147483646;
        display: grid; grid-template-columns: 28px minmax(0, 1fr) 40px; align-items: center; column-gap: 10px;
        width: min(480px, calc(100vw - 48px)); margin: 0; padding: 8px 8px 8px 10px;
        border-radius: 14px; background: #1d1d1f; color: #f5f5f7;
        font-family: "Euclid Circular A", "Segoe UI", sans-serif;
        box-shadow: 0 10px 28px rgba(0,0,0,.28);
        transform: translateX(-50%) translateY(-8px); opacity: 0;
        animation: nl-in 720ms cubic-bezier(.22,1,.36,1) forwards;
      }
      @keyframes nl-in { to { opacity: 1; transform: translateX(-50%) translateY(0); } }
      #nl-entry [data-nl="mark"] { width: 28px; height: 28px; display: block; }
      #nl-entry [data-nl="question"] { margin: 0; color: #f5f5f7; font-size: 14px; line-height: 1.25; font-weight: 600; }
      #nl-entry [data-nl="answer"] { margin: 2px 0 0; color: #ff922d; font-size: 13px; line-height: 1.25; min-height: 1.25em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #nl-entry.is-success { background: #0e7a32; }
      #nl-entry.is-failure { background: #b42318; }
      #nl-entry.is-success [data-nl="question"], #nl-entry.is-success [data-nl="answer"],
      #nl-entry.is-failure [data-nl="question"], #nl-entry.is-failure [data-nl="answer"] { color: #ffffff; }
      #kriya-click-guide-highlight.is-success { background: rgba(14,122,50,.34); box-shadow: 0 0 0 2px #ffffff, 0 0 0 5px #0e7a32, 0 0 22px 6px rgba(14,122,50,.7); animation: none; }
      #kriya-click-guide-highlight.is-failure { background: rgba(180,35,24,.34); box-shadow: 0 0 0 2px #ffffff, 0 0 0 5px #b42318, 0 0 22px 6px rgba(180,35,24,.7); animation: none; }
      #nl-entry [data-nl="answer"].is-in { animation: nl-answer 420ms cubic-bezier(.22,1,.36,1); }
      @keyframes nl-answer { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      #nl-entry.is-sending::after {
        content: ""; position: absolute; left: 10px; right: 8px; bottom: 4px; height: 2px; border-radius: 2px;
        background: #ff922d; transform-origin: left center; animation: nl-send 640ms cubic-bezier(.22,1,.36,1);
      }
      @keyframes nl-send { from { transform: scaleX(0); } to { transform: scaleX(1); } }
      #nl-go {
        width: 40px; height: 40px; margin: 0; padding: 0; border: 0; border-radius: 999px;
        background: #ff922d; display: grid; place-items: center; align-self: center; cursor: pointer;
      }
      #nl-go svg { display: block; }
      #nl-go.is-loading svg { animation: nl-spin 700ms linear infinite; transform-origin: center; }
      @keyframes nl-spin { to { transform: rotate(360deg); } }
    `;
      document.body.append(style, cursor);
      const entry = document.createElement('section');
      entry.id = 'nl-entry';
      entry.dataset.kriyaGuide = 'bar';
      entry.innerHTML = `
      <img data-nl="mark" alt="Automatic" />
      <div>
        <p data-nl="question"></p>
        <p data-nl="answer"></p>
      </div>
      <button id="nl-go" type="button" aria-label="Start">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12h12M13 6l6 6-6 6" fill="none" stroke="#1d1d1f" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    `;
      entry.querySelector('[data-nl="mark"]').src = src;
      document.body.appendChild(entry);
    }, logo);
    await page.evaluate(async () => {
      await document.fonts.load('600 14px "Euclid Circular A"');
      if (
        ![...document.fonts].some(
          face =>
            face.family === 'Euclid Circular A' && face.weight === '600' && face.status === 'loaded'
        )
      ) {
        throw new Error('Euclid Circular A SemiBold did not load');
      }
    });
  }

  async function moveCursorTo(x, y) {
    const start = await page.evaluate(() => {
      const cursor = document.getElementById('nl-cursor');
      return {
        x: Number.parseFloat(cursor?.style.left || '80'),
        y: Number.parseFloat(cursor?.style.top || '80'),
      };
    });
    const frames = 28;
    for (let i = 1; i <= frames; i += 1) {
      const t = i / frames;
      const eased = 1 - (1 - t) ** 3;
      await page.evaluate(
        point => {
          const cursor = document.getElementById('nl-cursor');
          if (!cursor) return;
          cursor.style.left = `${point.x}px`;
          cursor.style.top = `${point.y}px`;
        },
        { x: start.x + (x - start.x) * eased, y: start.y + (y - start.y) * eased }
      );
      await pause(20);
    }
  }

  async function pointAt(selector) {
    const box = await page.locator(selector).boundingBox();
    if (!box) return;
    await moveCursorTo(box.x + box.width * 0.72, box.y + box.height * 0.62);
  }

  async function smoothScroll(target) {
    const start = await page.evaluate(() => window.scrollY);
    const frames = 32;
    for (let i = 1; i <= frames; i += 1) {
      const t = i / frames;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await page.evaluate(top => window.scrollTo(0, top), start + (target - start) * eased);
      await pause(20);
    }
  }

  async function typeInto(selector, value) {
    await page.evaluate(sel => {
      const node = document.querySelector(sel);
      if (node) node.textContent = '';
    }, selector);
    for (const character of value) {
      await page.evaluate(
        ({ sel, character: next }) => {
          const node = document.querySelector(sel);
          if (node) node.textContent += next;
        },
        { sel: selector, character }
      );
      await pause(18);
    }
  }

  async function hideStatus() {
    await page.evaluate(() => document.getElementById('kriya-click-guide-status')?.remove());
  }

  async function highlightArrow() {
    await page.evaluate(() => {
      const button = document.getElementById('nl-go');
      if (!button) return;
      globalThis.KriyaGuide.paintHighlight(button, '');
      const hand = document.querySelector('#kriya-click-guide-highlight [data-kriya-guide="hand"]');
      if (hand instanceof HTMLElement) {
        hand.style.left = '42%';
        hand.style.top = '34%';
        hand.style.right = 'auto';
        hand.style.bottom = 'auto';
      }
      document.getElementById('kriya-click-guide-status')?.remove();
      const rect = button.getBoundingClientRect();
      const cursor = document.getElementById('nl-cursor');
      cursor?.style.setProperty('left', `${rect.left + rect.width / 2}px`);
      cursor?.style.setProperty('top', `${rect.top + rect.height / 2}px`);
      cursor?.style.setProperty('display', 'none');
    });
  }

  async function showAnswer(text, tone) {
    await page.evaluate(
      ({ text, tone }) => {
        const entry = document.getElementById('nl-entry');
        const node = document.querySelector('[data-nl="answer"]');
        entry?.classList.remove('is-sending');
        if (!node) return;
        node.textContent = text;
        node.style.color = tone === 'bad' ? '#ffb4ab' : '#ff922d';
        node.classList.remove('is-in');
        void node.offsetWidth;
        node.classList.add('is-in');
      },
      { text, tone }
    );
  }

  return { installChrome, moveCursorTo, smoothScroll, typeInto, highlightArrow, showAnswer };
}
