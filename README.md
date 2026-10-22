# Strict Words

A layered word-link puzzle. Words are stacked in layers on a grid; only letters on top can be linked, and finding a word removes its letters and uncovers the layer below.

- `index.html` — the game (levels are embedded, plus `levels*.json` when served over http).
- `generator.html` / `generator-core.js` — the level generator.
- `player.js` — personal config (player name, telemetry key). Copy it from `player.example.js`.

Run locally:

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765/index.html (add `?debug` for the debug panel).

## Waves

A **wave** is the set of words that can be linked once every earlier wave is cleared. Wave 1 is every word linkable at the start, wave 2 is every word linkable after all of wave 1 is found, and so on. The game computes the same waves as the generator's simulation.

## Word list modes (Settings → Word list)

| Mode | Shows |
| --- | --- |
| Counts by length | How many words of each length are left. |
| All words | Every word in one wrapped list, shortest first; found words turn green. |
| All words (swipe) | Every word in a single swipeable row; found words turn green. |
| Ten words | Up to 10 words at a time, nearest wave first (rules below). |
| Available now by length | How many words of each length can be linked right now. |

### Ten words ("On kelime")

An extension of the non-scrolling **All words** list that never shows more than 10 words at once:

1. **At most 10 words are shown.** If fewer unfound words are left, only those are shown.
2. **Nearest wave first.** The list is filled from wave 1's words, then wave 2's, then wave 3's, and so on. The words of each wave are shuffled once per level.
3. **Words always stay tidy**: one wrapped list, no gaps, no scrolling.
4. **A found word is completed**: it turns green, then it is removed from the list.
5. **Its replacement takes the same position.** If the new word fits the old slot, it simply appears there. If it has a different length, the slot animates to the new width and the word appears in it.
6. **Uncovered words are always shown.** If finding a word uncovers words on the board that aren't listed yet, they are added: the first takes the found word's place, the rest are appended. This happens even if the list goes above 10.
7. **Shrinking back to 10.** While the list is above 10, found words are removed (their slot closes with an animation) without a replacement, until the list is back to 10. Normal refilling then resumes.
8. **Never stuck.** If none of the listed words can be linked but an unlisted one can, that word is added to the list.

Hints in this mode only point at words that are on the list.
