# Beat montage (music, videos and photos)

A montage has no speech. The creator names one music file and the videos and photos to use, all in `Raw/`; the edit cuts on the music's beats, the videos play muted, the photos move, and the sound is the music plus a light sound design. Use only the files named. Nothing here invents claims or text; on-screen text is added only if the creator asks.

## 1. Run it

```text
node scripts/montage.mjs run --id <slug> --music Raw/<song> --media Raw/<a.mp4>,Raw/<b.jpg>,… --duration 30 --pace medium
```

`run` is `analyze`, `plan` and a preview `render` in one go (a minute or two; run it in the background and say so). It writes, in `Projects/<slug>/`:

- `montage/analysis.json`: tempo (BPM), beat and bar times, loudness per beat, the lifts (where the music clearly rises), and per video its motion and brightness over time.
- `montage/plan.json`: the edit (editable, see step 3) and `EDITORIAL_PLAN.md`: the same plan as a table in the creator's language.
- `renders/montage-preview.mp4` and its `.qc.json` (the studio's delivery check).

`--duration` is 15 to 600 seconds; omit it for 30, or give the music's length for the whole song. The window is chosen bar to bar: the loudest stretch of that length, with a lift inside when there is one. `--start <seconds>` picks the window start instead (snapped to the nearest bar). `--pace calm|medium|fast` sets how often it cuts: loud passages cut every 1, 2 or 4 beats, quieter ones hold longer, longer shots end on a bar start.

## 2. What the edit does

- Every cut lands on a beat (measured within about 10 ms on click tracks); the picture order spreads photos between videos.
- Each video shot uses the most moving, well-lit stretch of that video not already used; its own sound is removed.
- Photos zoom in, zoom out or pan slowly.
- At the main lift: a punch-in on the cut and a short white flash; the sound design adds a riser into it and an impact on it. Loud bar-start cuts get a soft air push, at most one every two seconds. No other effects: the music carries the edit.
- Sound: the music window with a short fade-in (when it starts mid-song) and a fade-out, the effects stem from `scripts/sfx.mjs`, normalised to -14 LUFS and -1.5 dBTP. Video: H.264 High 4.1, 1080×1920, 30 fps, closed 2-second GOP, AAC 48 kHz stereo.

## 3. Review and change

Tell the creator the BPM, the length, the number of shots and where the lift is, and give the preview (the dashboard shows it in the preview tab). You cannot hear the result: ask them to play it with sound. Changes:

- Faster/slower, longer/shorter, another part of the song: `plan` again with `--pace`, `--duration` or `--start`, then `render`.
- A different shot: edit `montage/plan.json` (`shots[i].media`, `from` for a video's start second, `move` for a photo: `zoom-in`, `zoom-out`, `pan-left`, `pan-right`; `punch`, `flash`), keeping each shot's `frames` and their total; then `render`. Effects are `sfx[]` entries (`riser`, `impact`, `whooshSoft`, or any `scripts/sound-catalog.mjs` sound) with a time and a small gain.
- New files: `analyze` again with the full `--media` list, then `plan` and `render`.

## 4. Deliver

After the creator accepts the preview, `node scripts/montage.mjs render --id <slug> --deliver` (better encoding), check its `.qc.json`, ask the creator to play it, and only after they answer `node scripts/montage.mjs publish --id <slug>`: it copies the file to `Outputs/<slug>/<slug>.mp4` with a cover frame. Then write the post description with the social-captions skill. The music's rights are the creator's: say so if they have not mentioned the source.
