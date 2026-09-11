import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isClientMessage, isSettingsPatch, LIMITS } from '../src/validate.ts';

describe('client message validation', () => {
  it('accepts what the real client sends', () => {
    const real: unknown[] = [
      { t: 'join', roomCode: 'ABCD', nickname: 'Mara' },
      { t: 'join', roomCode: 'ABCD', nickname: 'Mara', resumeToken: 'a-b-c' },
      { t: 'leave' },
      { t: 'start' },
      { t: 'rematch' },
      { t: 'revealNext' },
      { t: 'revealFinish' },
      { t: 'draw', from: 'deck' },
      { t: 'draw', from: 'deck', index: 3 },
      { t: 'draw', from: 'discard', cardId: 'FR12', index: 0 },
      { t: 'discard', cardId: 'FR12' },
      { t: 'reorderHand', cards: ['FR01', 'FR02', 'FR03'] },
      { t: 'resolveAction', cardId: 'FR49', choice: ['FR47', 'Wizard'] },
      { t: 'resolveAction', cardId: 'FR49', choice: null },
      { t: 'voteEndGame', vote: true },
      { t: 'updateSettings', settings: { expansions: { cursedHoardSuits: true } } },
    ];
    for (const m of real) assert.equal(isClientMessage(m), true, JSON.stringify(m));
  });

  it('rejects anything that is not a known message', () => {
    for (const m of [null, undefined, 42, 'join', [], {}, { t: 'nope' }, { t: 'draw' }]) {
      assert.equal(isClientMessage(m), false, JSON.stringify(m) ?? 'undefined');
    }
  });

  it('bounds the sizes that would otherwise be stored and rebroadcast', () => {
    // The point of the whole module: a nickname is persisted on every save and
    // sent to every player on every state change.
    assert.equal(isClientMessage({ t: 'join', roomCode: 'ABCD', nickname: 'x'.repeat(LIMITS.nickname) }), true);
    assert.equal(isClientMessage({ t: 'join', roomCode: 'ABCD', nickname: 'x'.repeat(LIMITS.nickname + 1) }), false);
    assert.equal(isClientMessage({ t: 'join', roomCode: 'A'.repeat(64), nickname: 'Mara' }), false);
    assert.equal(isClientMessage({ t: 'discard', cardId: 'F'.repeat(1024) }), false);
    assert.equal(
      isClientMessage({ t: 'reorderHand', cards: Array.from({ length: 500 }, () => 'FR01') }),
      false,
    );
    assert.equal(
      isClientMessage({ t: 'resolveAction', cardId: 'FR49', choice: ['x'.repeat(LIMITS.choiceArg + 1)] }),
      false,
    );
  });

  it('rejects wrong types where the old cast would have waved them through', () => {
    assert.equal(isClientMessage({ t: 'join', roomCode: 'ABCD', nickname: 123 }), false);
    assert.equal(isClientMessage({ t: 'join', roomCode: 'ABCD', nickname: '   ' }), false);
    assert.equal(isClientMessage({ t: 'draw', from: 'somewhere' }), false);
    assert.equal(isClientMessage({ t: 'draw', from: 'deck', index: -1 }), false);
    assert.equal(isClientMessage({ t: 'draw', from: 'deck', index: 1.5 }), false);
    assert.equal(isClientMessage({ t: 'reorderHand', cards: 'FR01' }), false);
    assert.equal(isClientMessage({ t: 'voteEndGame', vote: 'yes' }), false);
    assert.equal(isClientMessage({ t: 'resolveAction', cardId: 'FR49', choice: 'FR47' }), false);
  });

  it('only lets known settings keys into the row it persists', () => {
    assert.equal(isSettingsPatch({}), true);
    assert.equal(isSettingsPatch({ locale: 'de' }), true);
    assert.equal(isSettingsPatch({ expansions: { cursedHoardItems: true } }), true);
    assert.equal(isSettingsPatch({ expansions: { cursedHoardItems: 'yes' } }), false);
    assert.equal(isSettingsPatch({ junk: 'x'.repeat(4000) }), false);
    assert.equal(isSettingsPatch('nope'), false);
  });
});
