# Editor & renderer: what osu! behaviour we follow

## Target: osu!stable file semantics, as reproduced by osu!lazer

The site edits `.osu` files (format v14) for **osu!standard** and draws them with **legacy (stable) skins**.
So the target is **osu!stable behaviour**, taken from **osu!lazer's legacy-compatibility code**, which exists to
reproduce stable exactly and is open source (MIT). We don't mix in lazer-only behaviour (lazer's editor-only
features, non-legacy skins, lazer's `osu file format v128+` float coordinates) except where noted.

| Area | Behaviour | Reference (ppy/osu, ppy/osu-framework) |
|---|---|---|
| Circle size | radius = 64 × (1 − 0.7 × (CS − 5) / 5) / 2 × 1.00041 (stable's gamefield rounding allowance) | `LegacyRulesetExtensions.CalculateScaleFromCircleSize(cs, applyFudge: true)`, `OsuHitObject.Radius` |
| Approach rate | preempt = DifficultyRange(AR, 1800, 1200, 450), **truncated to int**; fade-in = 400 × min(1, preempt / 450) | `IBeatmapDifficultyInfo.DifficultyRangeInt`, `OsuHitObject.ApplyDefaultsToSelf` |
| Approach circle | scale 4 → 1 over the preempt, alpha to 0.9 over min(2 × fade-in, preempt) | `DrawableHitCircle` / legacy approach circle |
| Stacking (v6+) | stack distance 3 px, threshold = (int)preempt × StackLeniency, int start/end times for circles, circles under slider ends stack down-right, offset = −stack × radius / 10 | `OsuBeatmapProcessor.applyStacking` |
| Stacking (≤ v5) | the old algorithm | `OsuBeatmapProcessor.applyStackingOld` |
| Combo colours | first combo uses colour index 1 (= **Combo2**, Combo1 comes last); colour skips only apply to an explicit new combo; the object after a spinner always starts a combo; spinners don't take a colour skip; beatmap colours use the skip-adjusted index, skin colours don't | `IHasComboInformation.UpdateComboInformation`, `ConvertHitObjectParser`, `LegacyBeatmapSkin.GetComboColour` |
| Slider control points | legacy files: coordinates truncated to ints; two identical points in a row start a new segment (red anchor); a first point equal to the head is dropped; legacy catmull has no segments | `ConvertHitObjectParser.convertPathString / convertPoints` |
| Bezier | adaptive subdivision until flat (tolerance 0.25 px) | `PathApproximator.BSplineToPiecewiseLinear` (bezier = full-degree B-spline) |
| Perfect curve | circle through 3 points, 0.1 px tolerance; not 3 points → bezier; **collinear → straight line (stable)**; degenerate / ≥ 1000 sub-points → bezier | `SliderPath.calculateSubPath`, `CircularArcProperties`, `ConvertHitObjectParser` |
| Catmull | 50 steps per knot, extrapolated end knots, stable's "keep vertices 6 px apart" optimisation (the removed length still counts) | `PathApproximator.CatmullToPiecewiseLinear`, `SliderPath` (`OptimiseCatmull`) |
| Slider length | path cut to the length in the file, or extended straight; **not extended when the last two points are equal** (then the shorter real length is used for the duration) | `SliderPath.calculateLength` |
| Slider velocity / duration | span = length / (100 × SliderMultiplier × SV) × beat length; SV from the green line (0.1–10×), reset by red lines | `Slider.ApplyDefaultsToSelf`, `LegacyBeatmapDecoder` |
| Slider ticks | tick distance = 100 × SliderMultiplier × SV / tick rate (files **older than v8: without SV**); no tick within 10 ms (in length) of the end | `Slider` (`TickDistanceMultiplier`), `SliderEventGenerator` |
| Coordinates | 512 × 384 playfield, drawn in osu!px; the editor adds a margin like osu!'s editor | — |

Verified by `tests/parse.test.mjs` (arcs, lines, bezier accuracy, red anchors, length rules, combo colours, preempt,
stacking old/new, tick spacing, raw lines untouched).

## Import / export keeps your data

* The editor changes `map.lines` (raw `[HitObjects]` lines) and only rewrites the sections it edits
  (General/Editor/Metadata/Difficulty keys it knows, `[TimingPoints]`, `[HitObjects]`); every other line, section,
  comment and unknown key is written back as it was. Opening and exporting without edits gives a byte-identical file
  (checked with an extra unknown section and comments).
* Unchanged objects keep their exact text (the parser never re-formats a line; collab merges rebuild a line from its
  original fields).
* Objects have stable ids (`adoptIds`, kept per difficulty in the order of `[HitObjects]`). They are stored with drafts
  and collab state, never inside the `.osu`.

## Remaining differences (known)

* The ball position along an optimised **catmull** slider uses the drawn vertices, while lazer keeps the removed
  length in the first segment's cumulative length; the ball can be slightly ahead on those (very old) sliders.
* Lazer-format files (`osu file format v128`, float coordinates) are drawn with float coordinates but exported in v14
  syntax only where the editor rewrites them.
* Scoring, HP drain and judgement windows are for the preview HUD only and are simplified.
* Spinners are drawn like stable's spinners without spin physics.
* The editor's own tools (stream, polygon, transform, snapping) are this site's design, inspired by osu!stable,
  osu!lazer and osucad (MIT); they write ordinary v14 lines.

## Sources

* ppy/osu (MIT): `osu.Game/Rulesets/Objects/SliderPath.cs`, `osu.Game/Rulesets/Objects/Legacy/ConvertHitObjectParser.cs`,
  `osu.Game.Rulesets.Osu/Beatmaps/OsuBeatmapProcessor.cs`, `osu.Game.Rulesets.Osu/Objects/OsuHitObject.cs`,
  `osu.Game.Rulesets.Osu/Objects/Slider.cs`, `osu.Game/Rulesets/Objects/SliderEventGenerator.cs`,
  `osu.Game/Rulesets/Objects/Types/IHasComboInformation.cs`, `osu.Game/Skinning/LegacyBeatmapSkin.cs`,
  `osu.Game/Rulesets/Objects/Legacy/LegacyRulesetExtensions.cs`, `osu.Game/Beatmaps/IBeatmapDifficultyInfo.cs`
* ppy/osu-framework (MIT): `osu.Framework/Utils/PathApproximator.cs`, `osu.Framework/Utils/CircularArcProperties.cs`
* skinning docs (first combo = Combo2): skinship.xyz `skin.ini` reference
* Parts of this code are translated into JavaScript from ppy/osu and ppy/osu-framework (stacking, slider paths and
  curves, Auto, osu!mania conversion and star rating); their MIT notice is in [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt).
