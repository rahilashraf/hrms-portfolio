import { afterEach, describe, expect, it } from 'vitest';
import { keepFocusInPage, restoreFocus } from './focus';

/** Batch 11C — focus returns to the trigger, or to main when the trigger is gone or unusable. */
function page() {
  document.body.innerHTML = `
    <main id="main-content" tabindex="-1">
      <button id="trigger">Approve</button>
      <button id="other">Other</button>
    </main>`;
  return {
    main: document.getElementById('main-content')!,
    trigger: document.getElementById('trigger') as HTMLButtonElement,
    other: document.getElementById('other') as HTMLButtonElement,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('restoreFocus', () => {
  it('returns focus to a trigger that is still in the page and enabled', () => {
    const { trigger, other } = page();
    other.focus();
    restoreFocus(trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it('moves focus to main when the trigger was removed', () => {
    const { main, trigger } = page();
    trigger.remove();
    restoreFocus(trigger);
    expect(document.activeElement).toBe(main);
  });

  it('moves focus to main when the trigger is disabled', () => {
    const { main, trigger } = page();
    trigger.disabled = true;
    restoreFocus(trigger);
    expect(document.activeElement).toBe(main);
  });

  it('moves focus to main when the trigger is inside an inert region', () => {
    const { main, trigger } = page();
    const wrapper = document.createElement('div');
    wrapper.setAttribute('inert', '');
    main.append(wrapper);
    wrapper.append(trigger);
    restoreFocus(trigger);
    expect(document.activeElement).toBe(main);
  });

  it('moves focus to main when there was no previous element', () => {
    const { main } = page();
    restoreFocus(null);
    expect(document.activeElement).toBe(main);
  });
});

describe('keepFocusInPage', () => {
  it('moves focus from <body> to main', () => {
    const { main } = page();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    keepFocusInPage();
    expect(document.activeElement).toBe(main);
  });

  it('leaves focus alone when an element in the page has it', () => {
    const { other } = page();
    other.focus();
    keepFocusInPage();
    expect(document.activeElement).toBe(other);
  });
});
