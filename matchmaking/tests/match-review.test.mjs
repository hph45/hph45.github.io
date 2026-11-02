import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { createMatchReview } from '../src/match-review.js';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const match = { id: 'match-a', display_name: 'Alex', recommended_book: { work_id: 'OL1W', title: 'Project Hail Mary' } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  const window = new Window({ settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false } });
  window.document.write(html);
  const $ = selector => window.document.querySelector(selector);
  const state = { calls: [], saved: null, failure: null, savedCount: 0, load: null, save: null };
  const client = { rpc: async (name, args) => {
    state.calls.push({ name, args });
    if (name === 'get_my_matchmaking_match_review') return state.load ? state.load() : { data: state.saved, error: state.failure };
    if (state.save) return state.save(args);
    if (state.failure) return { error: state.failure };
    state.saved = { compatibility_rating: args.p_compatibility_rating, book_rating: args.p_book_rating, recommended_book_id: args.p_recommended_book_id };
    return { data: state.saved, error: null };
  } };
  const parent = $('#match-reveal-dialog'); parent.showModal();
  const trigger = window.document.createElement('button'); trigger.textContent = 'Review this match'; parent.append(trigger);
  const review = createMatchReview({ client, document: window.document });
  const open = (item = match) => review.open(item, trigger, () => state.savedCount++);
  const rate = (name, value) => { const input = $(`input[name="${name}"][value="${value}"]`); input.checked = true; input.dispatchEvent(new window.Event('change', { bubbles: true })); };
  const save = async () => { $('#match-review-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true })); await tick(); };
  t.after(async () => { review.destroy(); await window.happyDOM.close(); });
  return { $, window, state, review, open, rate, save, parent, trigger };
}

test('ratings save only after both choices, keep the parent open, and reopen for editing', async t => {
  const { $, state, open, rate, save, parent, trigger, window } = setup(t);
  assert.equal(state.calls.length, 0, 'no requests before opening review');
  await open(); assert.equal($('#match-review-dialog').open, true); assert.equal(parent.open, true);
  assert.equal($('#match-review-save').disabled, true);
  rate('compatibility_rating', 4); await save(); assert.equal(state.calls.length, 1);
  rate('book_rating', 5); await save();
  assert.deepEqual(state.calls[1], { name: 'save_matchmaking_match_review', args: { p_match_id: 'match-a', p_compatibility_rating: 4, p_book_rating: 5, p_recommended_book_id: 'OL1W' } });
  assert.equal($('#match-review-dialog').open, false); assert.equal(parent.open, true); assert.equal(window.document.activeElement, trigger); assert.equal(state.savedCount, 1);
  await open(); assert.equal($('input[name="compatibility_rating"]:checked').value, '4'); assert.equal($('input[name="book_rating"]:checked').value, '5');
  assert.equal(state.calls.length, 2, 'reuse current-session own-review cache');
  rate('compatibility_rating', 3); await save(); assert.equal(state.saved.compatibility_rating, 3);
});

test('load failures cannot overwrite an existing review; retry recovers', async t => {
  const { $, state, open } = setup(t); state.failure = new Error('Offline');
  await open(); assert.equal($('#match-review-save').disabled, true); assert.equal($('#match-review-retry').hidden, false);
  state.failure = null; state.saved = { compatibility_rating: 2, book_rating: 4, recommended_book_id: 'OL1W' };
  $('#match-review-retry').click(); await tick(); assert.equal($('input[name="compatibility_rating"]:checked').value, '2');
  assert.equal($('#match-review-error').hidden, true);
});

test('save failures retain choices and a double submit sends once', async t => {
  const { $, state, open, rate, save } = setup(t); await open(); rate('compatibility_rating', 4); rate('book_rating', 3);
  state.failure = new Error('Offline'); await save(); assert.equal($('#match-review-dialog').open, true);
  assert.equal($('input[name="book_rating"]:checked').value, '3'); assert.equal(state.savedCount, 0);
  let finish; state.failure = null; state.save = () => new Promise(resolve => { finish = resolve; });
  await save(); await save(); assert.equal(state.calls.filter(x => x.name === 'save_matchmaking_match_review').length, 2, 'one failed plus one pending');
  finish({ data: { compatibility_rating: 4, book_rating: 3, recommended_book_id: 'OL1W' } }); await tick(); assert.equal(state.savedCount, 1);
});

test('closing the overlay and resetting an account discard late reads and writes', async t => {
  const { $, state, open, review, rate, save, parent } = setup(t);
  let finish; state.load = () => new Promise(resolve => { finish = resolve; }); const pending = open();
  review.close(); finish({ data: { compatibility_rating: 5, book_rating: 5, recommended_book_id: 'OL1W' } }); await pending;
  assert.equal($('#match-review-dialog').open, false); assert.equal(parent.open, true);
  state.load = null; await open(); assert.equal($('input[name="compatibility_rating"]:checked'), null);
  rate('compatibility_rating', 2); rate('book_rating', 3); state.save = () => new Promise(resolve => { finish = resolve; });
  await save(); review.reset(); finish({ data: { compatibility_rating: 2, book_rating: 3, recommended_book_id: 'OL1W' } }); await tick();
  assert.equal(state.savedCount, 0); assert.equal($('#match-review-context').textContent, '');
  state.save = null; await open(); assert.equal($('input[name="compatibility_rating"]:checked'), null);
});

test('a changed recommendation does not inherit the old book score; legacy matches need only compatibility', async t => {
  const { $, state, open, rate, save } = setup(t);
  state.saved = { compatibility_rating: 4, book_rating: 5, recommended_book_id: 'OL2W' }; await open();
  assert.equal($('input[name="compatibility_rating"]:checked').value, '4'); assert.equal($('input[name="book_rating"]:checked'), null);
  await open({ id: 'legacy', display_name: '<img src=x onerror=alert(1)>', recommended_book: null });
  assert.equal($('#match-review-context img'), null); assert.equal($('[data-rating="book_rating"]').hidden, true);
  rate('compatibility_rating', 3); await save(); assert.equal(state.calls.at(-1).args.p_book_rating, null);
});
